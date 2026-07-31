//! Module-to-module calls — a declared, scoped, auditable path where there was none.
//!
//! A sysmod is a one-shot child process: stdin in, stdout out, no way to ask the framework for
//! anything. That is fine for a module that wraps one API, and impossible for a module that
//! composes several — an autotrade cycle needs candles from a broker, a signal from
//! `technical-analysis`, then an order back at the broker. Without a path, the only options are
//! duplicating every broker's REST layer inside the caller (so adding a broker stops being a
//! declaration) or folding the whole flow into a fixed pipeline (which cannot emit a variable
//! number of orders).
//!
//! **This narrows the trust boundary rather than widening it.** The sandbox is `BasicProcess`: no
//! filesystem restriction, the parent's environment intact, `data/vault.db` readable, and the MCP
//! server listening on loopback. A module that wanted full admin tool access already had it, with
//! nothing recorded. So the point of a scoped token is not to grant reach — it is to make the
//! reach *declared* (`dependencies` in config.json), *narrow* (only what was declared),
//! *bounded* (depth and call budget), and *logged*.
//!
//! The mechanism is deliberately the second instance of one that already works:
//! [`crate::utils::hub_context`] registers a per-turn token in a map, `verify_token` accepts it as
//! an auth source, and `handle_rpc` looks it up into a task-local for the duration of a request.
//! Same shape here, different policy — so there is no new transport and no new auth scheme.
//!
//! Approval is inherited, never invented: the token carries whether the *parent* call was already
//! approved (a cron run is; a chat turn is not). A child hitting an approval-gated action with an
//! unapproved token is refused outright rather than raising an approval card, because a card is
//! answered by the frontend calling again — the waiting child would hang to its timeout with an
//! order in an unknown state.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

/// How long past the sandbox timeout a token stays usable. The guard normally removes it the
/// moment the child exits; this only covers a guard that never ran its `Drop` (panic, abort).
const GRACE_MS: i64 = 5_000;

/// What a module declared it may call (`dependencies` in config.json).
#[derive(Clone, Debug, Default)]
pub struct Dependencies {
    /// Module names, exact.
    pub modules: Vec<String>,
    /// Capabilities — `stock-trading` covers every broker module, so adding a broker stays a
    /// declaration in that broker's own config rather than an edit here.
    pub capabilities: Vec<String>,
    /// Built-in tool names (`cache_read`, `stream_watch_start`, …).
    pub tools: Vec<String>,
    pub max_depth: u8,
    pub max_calls: u32,
}

impl Dependencies {
    pub fn is_empty(&self) -> bool {
        self.modules.is_empty() && self.capabilities.is_empty() && self.tools.is_empty()
    }
}

/// `dependencies` from a module config. `None` = the module never asked for the path, so it does
/// not get a token at all.
pub fn parse_dependencies(config: &serde_json::Value) -> Option<Dependencies> {
    let decl = config.get("dependencies")?.as_object()?;
    let list = |key: &str| -> Vec<String> {
        decl.get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let deps = Dependencies {
        modules: list("modules"),
        capabilities: list("capabilities"),
        tools: list("tools"),
        // Depth 1 by default: the caller may call, the callee may not call on. Anything deeper has
        // to be asked for explicitly.
        max_depth: decl
            .get("maxDepth")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .min(4) as u8,
        max_calls: decl
            .get("maxCalls")
            .and_then(|v| v.as_u64())
            .unwrap_or(200)
            .min(5_000) as u32,
    };
    if deps.is_empty() {
        return None;
    }
    Some(deps)
}

#[derive(Clone, Debug)]
pub struct ModuleCallContext {
    /// The module holding this token.
    pub caller: String,
    /// Every module already on the stack, caller included — membership is the recursion check.
    pub chain: Vec<String>,
    pub depth: u8,
    pub deps: Dependencies,
    /// Shared with the registry entry so every request against this token draws from one budget.
    pub budget: Arc<AtomicU32>,
    /// Whether the call that spawned this module was itself already approved (cron/schedule).
    pub approved: bool,
    pub expires_ms: i64,
}

/// Why a call was refused. The code travels to the module so it can branch without string matching.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Deny {
    NotDeclared,
    Recursion,
    Depth,
    Budget,
    Expired,
}

impl Deny {
    pub fn code(&self) -> &'static str {
        match self {
            Deny::NotDeclared => "module_call_denied",
            Deny::Recursion => "module_call_recursion",
            Deny::Depth => "module_call_depth",
            Deny::Budget => "module_call_budget",
            Deny::Expired => "module_call_expired",
        }
    }

    /// Phrased so the module (and whoever reads the log) knows the next move, not just the verdict.
    pub fn message(&self, caller: &str, target: &str) -> String {
        match self {
            Deny::NotDeclared => format!(
                "'{caller}' may not call '{target}' — add it to `dependencies` in its config.json \
                 (a module name, a capability, or a tool name)."
            ),
            Deny::Recursion => format!(
                "'{target}' is already on the call chain — a module cannot call back into its own caller."
            ),
            Deny::Depth => format!(
                "call depth limit reached for '{caller}' — raise `dependencies.maxDepth` if the \
                 extra hop is intended."
            ),
            Deny::Budget => format!(
                "'{caller}' used up `dependencies.maxCalls` for this run."
            ),
            Deny::Expired => "this module-call token has expired".to_string(),
        }
    }
}

static MODULE_CALLS: RwLock<BTreeMap<String, ModuleCallContext>> = RwLock::new(BTreeMap::new());

tokio::task_local! {
    /// The context for one MCP request made with a module token. Unset everywhere else, which is
    /// what keeps admin and CLI traffic unaffected.
    pub static CURRENT_MODULE_CALL: Option<ModuleCallContext>;
}

/// RAII registration — dropped when the sandbox call returns, however it returns.
pub struct ModuleCallGuard {
    token: String,
}

impl ModuleCallGuard {
    pub fn enter(
        caller: String,
        chain: Vec<String>,
        depth: u8,
        deps: Dependencies,
        approved: bool,
        lifetime_ms: i64,
    ) -> (Self, String) {
        let token = new_token(&caller);
        let ctx = ModuleCallContext {
            caller,
            chain,
            depth,
            budget: Arc::new(AtomicU32::new(deps.max_calls)),
            deps,
            approved,
            expires_ms: crate::utils::time::now_ms() + lifetime_ms + GRACE_MS,
        };
        if let Ok(mut map) = MODULE_CALLS.write() {
            map.insert(token.clone(), ctx);
        }
        (
            Self {
                token: token.clone(),
            },
            token,
        )
    }
}

impl Drop for ModuleCallGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = MODULE_CALLS.write() {
            map.remove(&self.token);
        }
    }
}

fn new_token(caller: &str) -> String {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "mcall-{}-{}-{}-{}",
        caller,
        crate::utils::time::now_ms(),
        n,
        uuid::Uuid::new_v4().simple()
    )
}

/// Auth check for `verify_token`. Expired entries are dropped here rather than lingering.
pub fn is_registered_token(token: &str) -> bool {
    lookup(token).is_some()
}

pub fn lookup(token: &str) -> Option<ModuleCallContext> {
    let found = MODULE_CALLS.read().ok().and_then(|m| m.get(token).cloned());
    match found {
        Some(ctx) if ctx.expires_ms > crate::utils::time::now_ms() => Some(ctx),
        Some(_) => {
            if let Ok(mut map) = MODULE_CALLS.write() {
                map.remove(token);
            }
            None
        }
        None => None,
    }
}

/// The context of the request being served, if it came from a module.
pub fn active() -> Option<ModuleCallContext> {
    CURRENT_MODULE_CALL.try_with(|c| c.clone()).ok().flatten()
}

/// Whether the current module call inherited approval. Read by the approval gate alongside the
/// cron check — a scheduled cycle's orders go through, an interactive one's do not.
pub fn current_inherits_approval() -> bool {
    active().map(|c| c.approved).unwrap_or(false)
}

/// Is the current request a module call at all? Used to refuse instead of raising an approval card.
pub fn is_module_call_active() -> bool {
    active().is_some()
}

/// May this context call that sysmod? `capability` is the target module's declared capability.
pub fn permits_module(
    ctx: &ModuleCallContext,
    target: &str,
    capability: Option<&str>,
) -> Result<(), Deny> {
    if ctx.chain.iter().any(|m| m == target) {
        return Err(Deny::Recursion);
    }
    if ctx.depth >= ctx.deps.max_depth {
        return Err(Deny::Depth);
    }
    let by_name = ctx.deps.modules.iter().any(|m| m == target);
    let by_cap = capability
        .map(|c| ctx.deps.capabilities.iter().any(|d| d == c))
        .unwrap_or(false);
    if !by_name && !by_cap {
        return Err(Deny::NotDeclared);
    }
    Ok(())
}

pub fn permits_tool(ctx: &ModuleCallContext, tool: &str) -> Result<(), Deny> {
    if ctx.deps.tools.iter().any(|t| t == tool) {
        Ok(())
    } else {
        Err(Deny::NotDeclared)
    }
}

/// One call off the budget. Saturates at zero rather than wrapping.
pub fn consume_budget(ctx: &ModuleCallContext) -> Result<(), Deny> {
    let mut left = ctx.budget.load(Ordering::Relaxed);
    loop {
        if left == 0 {
            return Err(Deny::Budget);
        }
        match ctx.budget.compare_exchange_weak(
            left,
            left - 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Ok(()),
            Err(actual) => left = actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deps(modules: &[&str], caps: &[&str], tools: &[&str], depth: u8, calls: u32) -> Dependencies {
        Dependencies {
            modules: modules.iter().map(|s| s.to_string()).collect(),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            tools: tools.iter().map(|s| s.to_string()).collect(),
            max_depth: depth,
            max_calls: calls,
        }
    }

    fn ctx(d: Dependencies, chain: &[&str], depth: u8) -> ModuleCallContext {
        ModuleCallContext {
            caller: chain.last().unwrap_or(&"c").to_string(),
            chain: chain.iter().map(|s| s.to_string()).collect(),
            depth,
            budget: Arc::new(AtomicU32::new(d.max_calls)),
            deps: d,
            approved: false,
            expires_ms: crate::utils::time::now_ms() + 60_000,
        }
    }

    #[test]
    fn a_module_with_no_declaration_gets_no_token() {
        assert!(parse_dependencies(&serde_json::json!({})).is_none());
        assert!(parse_dependencies(&serde_json::json!({"dependencies": {}})).is_none());
    }

    #[test]
    fn declaration_defaults_keep_the_hop_shallow() {
        let d = parse_dependencies(&serde_json::json!({
            "dependencies": {"modules": ["kiwoom"]}
        }))
        .unwrap();
        assert_eq!(d.max_depth, 1);
        assert_eq!(d.max_calls, 200);
    }

    #[test]
    fn only_declared_targets_are_reachable() {
        let c = ctx(deps(&["kiwoom"], &[], &[], 1, 10), &["autotrade"], 0);
        assert!(permits_module(&c, "kiwoom", None).is_ok());
        assert_eq!(
            permits_module(&c, "notes", None).unwrap_err(),
            Deny::NotDeclared
        );
    }

    #[test]
    fn a_capability_covers_modules_added_later() {
        // The point of declaring a capability: a new broker ships with its own config and becomes
        // callable without touching the caller.
        let c = ctx(deps(&[], &["stock-trading"], &[], 1, 10), &["autotrade"], 0);
        assert!(permits_module(&c, "toss-invest", Some("stock-trading")).is_ok());
        assert_eq!(
            permits_module(&c, "kakao-map", Some("map")).unwrap_err(),
            Deny::NotDeclared
        );
    }

    #[test]
    fn a_module_cannot_call_back_into_its_own_chain() {
        let c = ctx(
            deps(&["autotrade", "kiwoom"], &[], &[], 2, 10),
            &["autotrade", "kiwoom"],
            1,
        );
        assert_eq!(
            permits_module(&c, "autotrade", None).unwrap_err(),
            Deny::Recursion
        );
    }

    #[test]
    fn depth_is_checked_before_the_allowlist_runs_out() {
        let c = ctx(deps(&["kiwoom"], &[], &[], 1, 10), &["a", "b"], 1);
        assert_eq!(permits_module(&c, "kiwoom", None).unwrap_err(), Deny::Depth);
    }

    #[test]
    fn tools_have_their_own_allowlist() {
        let c = ctx(deps(&[], &[], &["cache_read"], 1, 10), &["autotrade"], 0);
        assert!(permits_tool(&c, "cache_read").is_ok());
        assert_eq!(
            permits_tool(&c, "write_file").unwrap_err(),
            Deny::NotDeclared
        );
    }

    #[test]
    fn the_budget_runs_out_and_stays_out() {
        let c = ctx(deps(&["kiwoom"], &[], &[], 1, 2), &["autotrade"], 0);
        assert!(consume_budget(&c).is_ok());
        assert!(consume_budget(&c).is_ok());
        assert_eq!(consume_budget(&c).unwrap_err(), Deny::Budget);
        assert_eq!(consume_budget(&c).unwrap_err(), Deny::Budget);
    }

    #[test]
    fn the_guard_registers_the_token_and_drop_removes_it() {
        let (guard, token) = ModuleCallGuard::enter(
            "autotrade".to_string(),
            vec!["autotrade".to_string()],
            0,
            deps(&["kiwoom"], &[], &[], 1, 10),
            true,
            60_000,
        );
        assert!(is_registered_token(&token));
        assert!(lookup(&token).unwrap().approved);
        drop(guard);
        assert!(!is_registered_token(&token));
        assert!(lookup(&token).is_none());
    }

    #[test]
    fn an_expired_token_stops_authenticating() {
        // Negative lifetime puts expiry in the past even after the grace period is added.
        let (_guard, token) = ModuleCallGuard::enter(
            "autotrade".to_string(),
            vec!["autotrade".to_string()],
            0,
            deps(&["kiwoom"], &[], &[], 1, 10),
            true,
            -(GRACE_MS + 1_000),
        );
        assert!(!is_registered_token(&token));
    }
}

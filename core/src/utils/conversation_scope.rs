//! Conversation-scoped tool-procedure state — one store for both tool paths.
//!
//! Two procedures need to remember what already happened before the current tool call:
//!
//! - **L1 grounding corpus** (Fact-Provenance Firewall): a declared opaque param (a stock code,
//!   an account id) must trace to a value the model actually observed — the user's prompt or a
//!   prior tool result — or the call is rejected with a resolve hint.
//! - **Discovery-first gate** (표준 절차 ②): a multi-action sysmod call runs only after
//!   `get_action_schema(module, action)` was fetched for that exact pair.
//!
//! Both were kept twice, in two different scopes. The FC path (`managers::ai`) held them
//! *turn-local* — a `Vec<String>` seeded with the prompt and a `HashSet<String>` of
//! `"module:action"` — so both died at turn end and every follow-up turn re-resolved the same
//! codes and re-fetched the same schemas. The MCP path (`infra::mcp_server`) held them keyed by
//! session token with a 30-minute window. Same two procedures, two lifetimes, two answers to the
//! same question.
//!
//! This module is the single store, per the user decision of 2026-08-12: **scope = the
//! conversation, window = 30 minutes, sliding**. The key is opaque on purpose — a caller passes
//! the conversation id when it knows one and a session token when it does not; the store only
//! needs a stable string to hang state on, and unifying the *shape* is what removes the drift.
//!
//! Sliding means a lookup is also a touch: asking `schema_ok` for a pair the model keeps using
//! restamps it, so a long working conversation never re-fetches a schema it is actively relying
//! on, while a pair fetched once and abandoned falls out of the window on schedule. The corpus
//! window slides in the other, simpler sense — a snapshot is the entries observed within the last
//! 30 minutes, so provenance ages out even while the conversation stays alive.
//!
//! Caps mirror the MCP accumulator this replaces (`mcp_server.rs` `observed_store`): 30-minute
//! TTL, 60 entries per scope, 256 KiB per entry, truncated on a char boundary because byte
//! slicing panics on multi-byte (Korean) content. Added on top, because a conversation-scoped
//! store outlives the session-scoped one it replaces: a global cap on how many conversations are
//! remembered at once, LRU by last touch, so a server that runs for weeks does not grow without
//! bound.
//!
//! Process-wide singleton: the deployed binary is one process and `infra` links `core`, so both
//! tool paths reach the same map without a handle having to be threaded through either of them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// How long a schema stamp or a corpus entry stays valid. Both procedures use one window so the
/// model does not have to hold two different notions of "recent".
pub const SCOPE_TTL: Duration = Duration::from_secs(30 * 60);

/// Corpus entries kept per scope — mirrors `OBSERVED_MAX` in `mcp_server.rs`.
pub const OBSERVED_MAX: usize = 60;

/// Bytes kept per corpus entry — mirrors `OBSERVED_TEXT_CAP` in `mcp_server.rs`. Identifier
/// provenance arrives in small lookup/grep results, not in huge numeric payloads, so the cap
/// bounds memory without losing codes.
pub const OBSERVED_TEXT_CAP: usize = 256 * 1024;

/// Distinct `module:action` pairs remembered per scope. The MCP store bounded these with the
/// corpus cap (60); a conversation that works across several modules can legitimately pass that,
/// and the entries are tiny, so the gate gets its own, larger cap.
pub const SCHEMA_SEEN_MAX: usize = 256;

/// Conversations remembered at once, process-wide. Over this, the least recently touched are
/// dropped. Losing a cold scope costs one re-resolve or one re-fetch, never correctness.
pub const MAX_SCOPES: usize = 200;

/// Produced-file receipts held per scope between the tool call and the turn's final assembly.
/// A turn that writes more than this many files is not a turn whose 21st card matters; the cap is
/// here so a runaway loop cannot grow the entry without bound.
pub const PRODUCED_MAX: usize = 20;

/// The discovery-first rejection, spoken identically on both transports.
///
/// It used to live twice — the FC copy had grown a thirty-minute clause the MCP copy never got,
/// which is exactly the dual-registry drift the shared store exists to end. The text is the next
/// move plus the one piece of state worth disclosing (how long the fetch counts); the WHY
/// paragraph it used to carry taught nothing the refusal itself does not already enforce.
pub fn discovery_reject(module: &str, action: &str) -> String {
    format!(
        "Standard procedure: call get_action_schema(\"{module}\", \"{action}\") first — it counts \
         for the next 30 minutes of this conversation — then invoke with exactly the parameters \
         it lists. Several schemas can be fetched in one round."
    )
}

/// A file a tool really produced — the receipt a file card is drawn from.
///
/// `url` is the only field that cannot be missing: it is the address the media store actually
/// wrote, and it is the membership test. `name` and `content_type` are advisory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProducedFile {
    pub url: String,
    pub name: String,
    pub content_type: Option<String>,
}

struct ScopeState {
    /// Provenance the model legitimately observed, oldest first, each stamped when recorded.
    observed: VecDeque<(Instant, String)>,
    /// `"module:action"` → the stamp of the last fetch *or* the last successful check.
    schema_seen: HashMap<String, Instant>,
    /// Files produced by tool calls that assemble no answer of their own (the CLI's own MCP
    /// loop), oldest first, waiting for the turn's final assembly to drain them.
    produced: VecDeque<(Instant, ProducedFile)>,
    /// Last read or write of this scope — the LRU key for `MAX_SCOPES`.
    last_touch: Instant,
}

impl ScopeState {
    fn new(now: Instant) -> Self {
        Self {
            observed: VecDeque::new(),
            schema_seen: HashMap::new(),
            produced: VecDeque::new(),
            last_touch: now,
        }
    }
}

fn store() -> MutexGuard<'static, HashMap<String, ScopeState>> {
    static STORE: OnceLock<Mutex<HashMap<String, ScopeState>>> = OnceLock::new();
    STORE
        .get_or_init(|| Mutex::new(HashMap::new()))
        // A panic while holding this lock must not take the grounding gate down with it: the
        // state is a cache of what was seen, so recovering the inner map is strictly better than
        // failing every subsequent call.
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The name component schemas are filed under.
///
/// Components are the other half of the same ladder (`search_components` →
/// `get_component_schema` → fence), and what a conversation has fetched is the same kind of fact
/// for both. Filing them here rather than in a second store means one window, one eviction, one
/// reader — the round brief lists both from `discovered_all`.
///
/// A reserved name rather than a real module: no module is called this, so a component entry can
/// never collide with `module:action`, and the discovery gate — which only ever asks about a
/// module the model named — never sees it.
pub const COMPONENT_PSEUDO_MODULE: &str = "render-component";

/// Canonical module name for the discovery gate. `get_action_schema` accepts dialects the gate's
/// raw-string keys never matched — a schema fetched as `sysmod_kma_weather` left the following
/// call on `kma-weather` rejected four times in one measured cron turn (2026-08-11). Record and
/// check both go through here so they cannot speak different names.
pub fn canon_module(module: &str) -> String {
    let m = module.trim();
    let m = m.strip_prefix("sysmod_").unwrap_or(m);
    let m = m.strip_prefix("sysmod-").unwrap_or(m);
    m.replace('_', "-")
}

fn gate_key(module: &str, action: &str) -> String {
    format!("{}:{}", canon_module(module), action.trim())
}

/// The scope key for a turn: the conversation when the caller knows it, else whatever stable
/// token it does have (an MCP session token). One helper so both paths derive the key the same
/// way and a conversation reached from either path lands on the same state.
pub fn scope_key(conversation_id: Option<&str>, fallback: &str) -> String {
    match conversation_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(cid) => format!("conv:{cid}"),
        None => format!("token:{fallback}"),
    }
}

// ── discovery-first gate ─────────────────────────────────────────────────────

/// Record that `get_action_schema(module, action)` was fetched in this scope.
///
/// Stamp on the *attempt*, as the MCP store did: a wrong module or action unlocks nothing the
/// model can actually call, and refusing to stamp a failed fetch would leave a model that
/// followed the procedure correctly unable to tell why it is still blocked.
pub fn record_schema(scope_key: &str, module: &str, action: &str) {
    record_schema_at(scope_key, module, action, Instant::now());
}

/// True when this scope fetched that schema within the window — **and restamps it**, so the
/// window slides for a pair the conversation keeps using.
pub fn schema_ok(scope_key: &str, module: &str, action: &str) -> bool {
    schema_ok_at(scope_key, module, action, Instant::now())
}

/// The actions of one module whose schema this scope has fetched and still holds.
///
/// The ladder ends by handing the caller a schema, and until now it handed it over as PROSE in a
/// tool result while the tool's own `parameters` stayed thin forever — so the API contract never
/// learned the shape and the model rebuilt it from memory, as a string (measured 2026-08-12:
/// identical prompt, thin schema → `sheets` arrives as a string twice, typed schema → a real
/// array). This is the list that lets the tool definition catch up with what the conversation
/// already discovered. Read-only: it does NOT slide the window (publishing a shape is not using
/// it) and it never creates a scope.
pub fn discovered_actions(scope_key: &str, module: &str) -> Vec<String> {
    let now = Instant::now();
    let mut map = store();
    let Some(state) = map.get_mut(scope_key) else {
        return Vec::new();
    };
    evict_schema(&mut state.schema_seen, now);
    let prefix = format!("{}:", canon_module(module));
    let mut out: Vec<String> = state
        .schema_seen
        .keys()
        .filter_map(|k| k.strip_prefix(&prefix).map(str::to_string))
        .filter(|a| !a.is_empty())
        .collect();
    out.sort();
    out
}

/// Every `(module, actions)` pair whose schema this scope holds, module-sorted.
///
/// [`discovered_actions`] answers for a module the caller already named, which is the shape the
/// tool-definition publisher needs. The round brief needs the other shape: it has no module in
/// mind and is reporting what is callable *right now*, so that a model holding a form does not
/// spend a round fetching it again. Read-only, like its sibling — publishing the list is not using
/// the entries, so the window does not slide and no scope is created.
pub fn discovered_all(scope_key: &str) -> Vec<(String, Vec<String>)> {
    let now = Instant::now();
    let mut map = store();
    let Some(state) = map.get_mut(scope_key) else {
        return Vec::new();
    };
    evict_schema(&mut state.schema_seen, now);
    let mut by_module: HashMap<String, Vec<String>> = HashMap::new();
    for key in state.schema_seen.keys() {
        // Keys are built by `gate_key` as `module:action`; a module name never contains ':' after
        // canonicalization, so the first separator is the right split point.
        let Some((module, action)) = key.split_once(':') else {
            continue;
        };
        if module.is_empty() || action.is_empty() {
            continue;
        }
        by_module
            .entry(module.to_string())
            .or_default()
            .push(action.to_string());
    }
    let mut out: Vec<(String, Vec<String>)> = by_module
        .into_iter()
        .map(|(m, mut actions)| {
            actions.sort();
            (m, actions)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ── grounding corpus ─────────────────────────────────────────────────────────

/// Append text the model legitimately observed (the user's prompt, an approved plan, a
/// successful tool result) to this scope's provenance corpus.
pub fn observe(scope_key: &str, text: &str) {
    observe_at(scope_key, text, Instant::now());
}

/// This scope's provenance corpus — entries observed within the window, oldest first. Hand
/// straight to `grounding::check_grounding`.
pub fn observed_snapshot(scope_key: &str) -> Vec<String> {
    observed_snapshot_at(scope_key, Instant::now())
}

// ── produced files ───────────────────────────────────────────────────────────
//
// A CLI model runs its tool calls inside its OWN loop, so the FC harvester in `managers::ai`
// never sees their results — a CLI turn that wrote a .docx produced no file card at all, while
// the identical FC turn did. The MCP path records the receipt here as it passes, and the turn's
// final assembly drains this scope and merges. Same store, same key, same window as the corpus.

/// The produced-file record carried by a successful tool result, or `None`.
///
/// One detector for both tool paths, because the second shape becomes the first before anyone
/// sees it: the docs module returns `data.media` itself, and a module that declares
/// `data._mediaImport` has it replaced by `data.media` when the framework carries the file into
/// the media store (`ModuleManager::export_declared_media`). So the address of a file that really
/// exists is always `data.media.url`, and it is always under `/user/media/` — that prefix is the
/// membership test, not a guess about the module.
///
/// `filenameHint` is preferred when a module supplies one (it is the human name the module chose),
/// then the slug, then the url's own basename — never the answer's prose.
pub fn produced_file_of_result(result: &serde_json::Value) -> Option<ProducedFile> {
    let media = result.get("data")?.get("media")?;
    let url = media.get("url")?.as_str()?.trim();
    if !url.starts_with("/user/media/") || url.len() <= "/user/media/".len() {
        return None;
    }
    let name = media
        .get("filenameHint")
        .or_else(|| media.get("slug"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| url.rsplit('/').next().unwrap_or(url).to_string());
    let content_type = media
        .get("contentType")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Some(ProducedFile {
        url: url.to_string(),
        name,
        content_type,
    })
}

/// Remember a file this scope produced. Deduped by url — one file made twice (a retry after a
/// timeout) is one card, and the same address reached through two tools is still one file.
pub fn record_produced_file(
    scope_key: &str,
    url: &str,
    name: &str,
    content_type: Option<&str>,
) {
    record_produced_file_at(
        scope_key,
        ProducedFile {
            url: url.trim().to_string(),
            name: name.trim().to_string(),
            content_type: content_type
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
        },
        Instant::now(),
    );
}

/// Take this scope's produced files and clear them — the turn's final assembly claims them once.
/// Draining rather than reading is what keeps a file from getting a second card on the next turn
/// of the same conversation.
pub fn drain_produced_files(scope_key: &str) -> Vec<ProducedFile> {
    drain_produced_files_at(scope_key, Instant::now())
}

// ── diagnostics ──────────────────────────────────────────────────────────────

/// Conversations currently held. For tests and operational curiosity — not a decision input.
pub fn scope_count() -> usize {
    store().len()
}

/// Drop one scope outright. Nothing in the turn paths needs this (the window and the LRU handle
/// lifetime); it exists so a conversation deletion can take its derived state with it.
pub fn forget(scope_key: &str) {
    store().remove(scope_key);
}

// ── time-injected internals (the public API is these with `Instant::now()`) ───
//
// The window is the whole behavior here, so the tests have to be able to move time. Threading an
// explicit `now` through the internals keeps that honest — no `cfg(test)` clock switch that lets
// the tested path differ from the shipped one.

fn record_schema_at(scope_key: &str, module: &str, action: &str, now: Instant) {
    let mut map = store();
    let state = map
        .entry(scope_key.to_string())
        .or_insert_with(|| ScopeState::new(now));
    state.last_touch = now;
    state.schema_seen.insert(gate_key(module, action), now);
    evict_schema(&mut state.schema_seen, now);
    enforce_scope_cap(&mut map, now);
}

fn schema_ok_at(scope_key: &str, module: &str, action: &str, now: Instant) -> bool {
    let mut map = store();
    // A miss must not create a scope: the gate is asked on every sysmod call, including the ones
    // it is about to reject, and a rejected call is no reason to start remembering a caller.
    let Some(state) = map.get_mut(scope_key) else {
        return false;
    };
    state.last_touch = now;
    evict_schema(&mut state.schema_seen, now);
    let key = gate_key(module, action);
    match state.schema_seen.get_mut(&key) {
        Some(stamp) => {
            *stamp = now; // sliding — using a schema keeps it fresh
            true
        }
        None => false,
    }
}

fn observe_at(scope_key: &str, text: &str, now: Instant) {
    let capped = truncate_on_char_boundary(text, OBSERVED_TEXT_CAP);
    let mut map = store();
    let state = map
        .entry(scope_key.to_string())
        .or_insert_with(|| ScopeState::new(now));
    state.last_touch = now;
    state.observed.push_back((now, capped));
    evict_observed(&mut state.observed, now);
    enforce_scope_cap(&mut map, now);
}

fn observed_snapshot_at(scope_key: &str, now: Instant) -> Vec<String> {
    let mut map = store();
    let Some(state) = map.get_mut(scope_key) else {
        return Vec::new();
    };
    state.last_touch = now;
    evict_observed(&mut state.observed, now);
    state.observed.iter().map(|(_, s)| s.clone()).collect()
}

fn record_produced_file_at(scope_key: &str, file: ProducedFile, now: Instant) {
    if file.url.is_empty() {
        return; // no address = no receipt; a card is a claim that the file is there
    }
    let mut map = store();
    let state = map
        .entry(scope_key.to_string())
        .or_insert_with(|| ScopeState::new(now));
    state.last_touch = now;
    evict_produced(&mut state.produced, now);
    if state.produced.iter().any(|(_, f)| f.url == file.url) {
        return; // deduped by address
    }
    state.produced.push_back((now, file));
    evict_produced(&mut state.produced, now);
    enforce_scope_cap(&mut map, now);
}

fn drain_produced_files_at(scope_key: &str, now: Instant) -> Vec<ProducedFile> {
    let mut map = store();
    // A drain must not create a scope: every turn's final assembly asks this, including the many
    // that produced nothing.
    let Some(state) = map.get_mut(scope_key) else {
        return Vec::new();
    };
    state.last_touch = now;
    evict_produced(&mut state.produced, now);
    state.produced.drain(..).map(|(_, f)| f).collect()
}

/// Cap to `max` bytes, backing up to a char boundary — byte slicing panics on multi-byte content
/// and this corpus is full of Korean tool output.
fn truncate_on_char_boundary(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Lazy eviction — expired entries off the front (the deque is stamp-ordered), then the size cap.
fn evict_observed(q: &mut VecDeque<(Instant, String)>, now: Instant) {
    while q
        .front()
        .is_some_and(|(t, _)| now.saturating_duration_since(*t) > SCOPE_TTL)
    {
        q.pop_front();
    }
    while q.len() > OBSERVED_MAX {
        q.pop_front();
    }
}

/// Same hygiene for the receipts — expired off the front (the deque is stamp-ordered), then the
/// size cap. A receipt older than the window belongs to a turn that already ended without
/// claiming it, and re-attaching it to a later turn would be a card for a file this turn did not
/// make.
fn evict_produced(q: &mut VecDeque<(Instant, ProducedFile)>, now: Instant) {
    while q
        .front()
        .is_some_and(|(t, _)| now.saturating_duration_since(*t) > SCOPE_TTL)
    {
        q.pop_front();
    }
    while q.len() > PRODUCED_MAX {
        q.pop_front();
    }
}

/// Lazy eviction for the gate — expired stamps, then the oldest stamps over the cap.
fn evict_schema(seen: &mut HashMap<String, Instant>, now: Instant) {
    seen.retain(|_, t| now.saturating_duration_since(*t) <= SCOPE_TTL);
    if seen.len() <= SCHEMA_SEEN_MAX {
        return;
    }
    let mut by_age: Vec<(Instant, String)> = seen.iter().map(|(k, t)| (*t, k.clone())).collect();
    by_age.sort_by_key(|(t, _)| *t);
    for (_, k) in by_age.into_iter().take(seen.len() - SCHEMA_SEEN_MAX) {
        seen.remove(&k);
    }
}

/// Global hygiene, only paid for when the map is actually over the cap: drop scopes whose whole
/// state has expired, then the least recently touched until the count fits.
fn enforce_scope_cap(map: &mut HashMap<String, ScopeState>, now: Instant) {
    if map.len() <= MAX_SCOPES {
        return;
    }
    map.retain(|_, s| now.saturating_duration_since(s.last_touch) <= SCOPE_TTL);
    if map.len() <= MAX_SCOPES {
        return;
    }
    let excess = map.len() - MAX_SCOPES;
    let mut by_age: Vec<(Instant, String)> = map
        .iter()
        .map(|(k, s)| (s.last_touch, k.clone()))
        .collect();
    by_age.sort_by_key(|(t, _)| *t);
    for (_, k) in by_age.into_iter().take(excess) {
        map.remove(&k);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The store is process-wide, and the LRU test deliberately overflows it, so the tests take
    /// the shared serialization lock rather than racing each other's scopes out of the map.
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        crate::utils::shared_test_lock()
    }

    fn mins(n: u64) -> Duration {
        Duration::from_secs(n * 60)
    }

    /// The whole point of sliding: a conversation that keeps calling an action never re-fetches
    /// its schema. Fetched at t0, used at t+29m, still good at t+58m — 58 minutes after the only
    /// actual fetch, because the check at 29 restamped it.
    #[test]
    fn a_used_schema_slides_past_the_original_window() {
        let _g = lock();
        let k = "test:slide";
        forget(k);
        let t0 = Instant::now();

        record_schema_at(k, "kiwoom", "ka10081", t0);
        assert!(schema_ok_at(k, "kiwoom", "ka10081", t0 + mins(29)));
        assert!(schema_ok_at(k, "kiwoom", "ka10081", t0 + mins(58)));
        // …and it keeps going as long as it keeps being used.
        assert!(schema_ok_at(k, "kiwoom", "ka10081", t0 + mins(87)));
        forget(k);
    }

    /// What the round brief publishes: everything callable right now, grouped and sorted, so a
    /// model holding a form does not spend a round fetching it again.
    #[test]
    fn discovered_all_groups_every_module_the_scope_holds() {
        let _g = lock();
        let k = "test:discovered-all";
        forget(k);
        let t0 = Instant::now();

        record_schema_at(k, "docs", "make_xlsx", t0);
        record_schema_at(k, "docs", "make_pdf", t0);
        // The dialect the gate canonicalizes — it must not surface as a second module.
        record_schema_at(k, "sysmod_kakao_map", "search-keyword", t0);

        let all = discovered_all(k);
        assert_eq!(
            all,
            vec![
                ("docs".to_string(), vec!["make_pdf".to_string(), "make_xlsx".to_string()]),
                ("kakao-map".to_string(), vec!["search-keyword".to_string()]),
            ]
        );
        forget(k);
    }

    /// Publishing the list is not using the entries — a form nobody called still ages out, or the
    /// brief would advertise a schema the gate has already forgotten.
    #[test]
    fn discovered_all_does_not_slide_the_window() {
        let _g = lock();
        let k = "test:discovered-all-ttl";
        forget(k);
        let t0 = Instant::now();

        record_schema_at(k, "docs", "make_xlsx", t0);
        assert_eq!(discovered_all(k).len(), 1);
        // Reading it repeatedly changes nothing about when it expires.
        assert_eq!(discovered_all(k).len(), 1);
        assert!(!schema_ok_at(k, "docs", "make_xlsx", t0 + mins(31)));
        forget(k);
    }

    /// The other half: a pair fetched once and abandoned falls out on schedule, so the gate
    /// stays a gate.
    #[test]
    fn an_untouched_schema_expires() {
        let _g = lock();
        let k = "test:expire-schema";
        forget(k);
        let t0 = Instant::now();

        record_schema_at(k, "kiwoom", "ka10081", t0);
        assert!(schema_ok_at(k, "kiwoom", "ka10081", t0 + mins(30)));
        // Untouched from t0 for over the window (the check above was at exactly the boundary and
        // restamped, so measure from there).
        let t1 = t0 + mins(30);
        assert!(!schema_ok_at(k, "kiwoom", "ka10081", t1 + mins(31)));
        forget(k);
    }

    /// A schema fetched under one dialect must unlock the call made under another — this is the
    /// measured cron failure (four rejects in one turn) that `canon_module` exists for.
    #[test]
    fn the_gate_speaks_one_module_name() {
        let _g = lock();
        let k = "test:canon";
        forget(k);
        let t0 = Instant::now();

        record_schema_at(k, "sysmod_kma_weather", "pwn-status", t0);
        assert!(schema_ok_at(k, "kma-weather", "pwn-status", t0));
        assert!(schema_ok_at(k, "kma_weather", "pwn-status", t0));
        assert!(schema_ok_at(k, "sysmod-kma-weather", "pwn-status", t0));
        // The action half is not normalized — a different action is a different contract.
        assert!(!schema_ok_at(k, "kma-weather", "vfct-status", t0));
        forget(k);
    }

    /// A miss is not a reason to start remembering a caller — every rejected sysmod call asks
    /// this question, and creating a scope per rejection is how the LRU fills with nothing.
    #[test]
    fn a_gate_miss_creates_no_scope() {
        let _g = lock();
        let k = "test:no-create";
        forget(k);
        assert!(!schema_ok(k, "kiwoom", "ka10081"));
        assert!(observed_snapshot(k).is_empty());
        assert!(!store().contains_key(k));
    }

    #[test]
    fn corpus_entries_leave_the_window() {
        let _g = lock();
        let k = "test:corpus-ttl";
        forget(k);
        let t0 = Instant::now();

        observe_at(k, "005930 삼성전자", t0);
        observe_at(k, "035720 카카오", t0 + mins(20));
        // Both still inside the window.
        assert_eq!(observed_snapshot_at(k, t0 + mins(25)).len(), 2);
        // The first has aged out, the second has not. Reading does NOT restamp corpus entries —
        // provenance ages by when it was observed, not by when it was last looked at.
        let later = observed_snapshot_at(k, t0 + mins(40));
        assert_eq!(later, vec!["035720 카카오".to_string()]);
        // Everything is gone once the window passes the newest entry.
        assert!(observed_snapshot_at(k, t0 + mins(51)).is_empty());
        forget(k);
    }

    #[test]
    fn the_corpus_keeps_the_newest_entries_and_drops_the_rest() {
        let _g = lock();
        let k = "test:corpus-cap";
        forget(k);
        let t0 = Instant::now();

        for i in 0..(OBSERVED_MAX + 15) {
            observe_at(k, &format!("entry-{i}"), t0 + Duration::from_millis(i as u64));
        }
        let snap = observed_snapshot_at(k, t0 + mins(1));
        assert_eq!(snap.len(), OBSERVED_MAX);
        // Oldest first, and the 15 that overflowed are the 15 oldest.
        assert_eq!(snap.first().unwrap(), "entry-15");
        assert_eq!(snap.last().unwrap(), &format!("entry-{}", OBSERVED_MAX + 14));
        forget(k);
    }

    /// Byte slicing a 256 KiB prefix out of Korean tool output panics on a multi-byte boundary.
    /// The cap has to back up to a char boundary — and the result must still be valid UTF-8 that
    /// carries the identifiers at the front of the payload.
    #[test]
    fn an_oversized_entry_is_capped_on_a_char_boundary() {
        let _g = lock();
        let k = "test:char-cap";
        forget(k);

        // "삼" is 3 bytes, so this string's length is not a multiple of the cap — the truncation
        // point lands mid-character unless it backs up.
        let big = "삼".repeat(OBSERVED_TEXT_CAP);
        observe(k, &big);
        let snap = observed_snapshot(k);
        assert_eq!(snap.len(), 1);
        let stored = &snap[0];
        assert!(stored.len() <= OBSERVED_TEXT_CAP);
        assert!(stored.len() > OBSERVED_TEXT_CAP - 4); // backed up at most one char
        assert!(stored.chars().all(|c| c == '삼'));
        // Under the cap, text is stored verbatim.
        forget(k);
        observe(k, "005930");
        assert_eq!(observed_snapshot(k), vec!["005930".to_string()]);
        forget(k);
    }

    /// Two conversations must not see each other's provenance or unlock each other's schemas —
    /// this is the same isolation the MCP session key gave, now stated per conversation.
    #[test]
    fn scopes_are_isolated() {
        let _g = lock();
        let (a, b) = ("test:iso-a", "test:iso-b");
        forget(a);
        forget(b);
        let t0 = Instant::now();

        observe_at(a, "005930", t0);
        record_schema_at(a, "kiwoom", "ka10081", t0);

        assert!(observed_snapshot_at(b, t0).is_empty());
        assert!(!schema_ok_at(b, "kiwoom", "ka10081", t0));
        assert_eq!(observed_snapshot_at(a, t0), vec!["005930".to_string()]);
        forget(a);
        forget(b);
    }

    /// A server that runs for weeks must not accumulate one scope per conversation forever. Over
    /// the cap, the least recently touched go first.
    #[test]
    fn the_conversation_count_is_bounded_lru() {
        let _g = lock();
        let t0 = Instant::now();
        let key = |i: usize| format!("test:lru-{i}");
        let total = MAX_SCOPES + 10;

        // Distinct, strictly increasing touches — all well inside the window, so this measures
        // the LRU and not the TTL.
        for i in 0..total {
            observe_at(&key(i), "x", t0 + Duration::from_millis(i as u64));
        }
        assert!(scope_count() <= MAX_SCOPES);
        // The newest survive; the oldest are gone.
        let now = t0 + Duration::from_millis(total as u64);
        assert_eq!(observed_snapshot_at(&key(total - 1), now), vec!["x".to_string()]);
        assert!(observed_snapshot_at(&key(0), now).is_empty());

        for i in 0..total {
            forget(&key(i));
        }
    }

    /// A scope whose whole state has expired is dropped by the same sweep, so a burst of dead
    /// conversations does not push out live ones.
    #[test]
    fn expired_scopes_are_swept_before_live_ones() {
        let _g = lock();
        let t0 = Instant::now();
        let key = |i: usize| format!("test:sweep-{i}");
        let live = "test:sweep-live";
        forget(live);

        for i in 0..MAX_SCOPES {
            observe_at(&key(i), "x", t0 + Duration::from_millis(i as u64));
        }
        // The live scope is touched an hour later — every scope above is expired by then, and
        // this insert is the one that takes the map over the cap and triggers the sweep.
        let t1 = t0 + mins(60);
        observe_at(live, "005930", t1);
        assert_eq!(observed_snapshot_at(live, t1), vec!["005930".to_string()]);
        // The dead ones went, not the live one.
        assert!(observed_snapshot_at(&key(0), t1).is_empty());

        forget(live);
        for i in 0..MAX_SCOPES {
            forget(&key(i));
        }
    }

    /// The gap this closes: a CLI turn's tool call produces the file inside the CLI's own loop,
    /// so the record has to survive until the turn assembles its answer. Drained once — a second
    /// drain is empty, or the same .docx gets a card on the next turn too.
    #[test]
    fn produced_files_are_recorded_once_and_drained_once() {
        let _g = lock();
        let k = "test:produced";
        forget(k);

        record_produced_file(k, "/user/media/a-1.docx", "보고서", Some("application/docx"));
        // Same address twice — one file, whatever route it arrived by.
        record_produced_file(k, "/user/media/a-1.docx", "보고서 (재시도)", None);
        record_produced_file(k, "/user/media/b-2.xlsx", "대시보드", None);
        // No address = no receipt.
        record_produced_file(k, "  ", "이름뿐", None);

        let drained = drain_produced_files(k);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].url, "/user/media/a-1.docx");
        assert_eq!(drained[0].name, "보고서");
        assert_eq!(drained[0].content_type.as_deref(), Some("application/docx"));
        assert_eq!(drained[1].url, "/user/media/b-2.xlsx");
        assert!(drained[1].content_type.is_none());
        // Drained means gone.
        assert!(drain_produced_files(k).is_empty());
        forget(k);
    }

    /// A drain on a scope nobody wrote to must not start remembering that caller — every turn's
    /// final assembly asks, and most turns produced nothing.
    #[test]
    fn draining_an_unknown_scope_creates_no_scope() {
        let _g = lock();
        let k = "test:produced-none";
        forget(k);
        assert!(drain_produced_files(k).is_empty());
        assert!(!store().contains_key(k));
    }

    /// The receipts age and cap on the same terms as the corpus: a record older than the window
    /// belongs to a turn that already ended, and a runaway loop cannot grow the entry unbounded.
    #[test]
    fn produced_files_expire_and_are_capped() {
        let _g = lock();
        let k = "test:produced-hygiene";
        forget(k);
        let t0 = Instant::now();

        record_produced_file_at(k, file("/user/media/old.pdf"), t0);
        record_produced_file_at(k, file("/user/media/new.pdf"), t0 + mins(20));
        let left = drain_produced_files_at(k, t0 + mins(40));
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].url, "/user/media/new.pdf");

        for i in 0..(PRODUCED_MAX + 5) {
            record_produced_file_at(
                k,
                file(&format!("/user/media/f{i}.pdf")),
                t0 + Duration::from_millis(i as u64),
            );
        }
        let capped = drain_produced_files_at(k, t0 + mins(1));
        assert_eq!(capped.len(), PRODUCED_MAX);
        // Oldest first, and the 5 that overflowed are the 5 oldest.
        assert_eq!(capped.first().unwrap().url, "/user/media/f5.pdf");
        forget(k);
    }

    fn file(url: &str) -> ProducedFile {
        ProducedFile {
            url: url.to_string(),
            name: url.rsplit('/').next().unwrap_or(url).to_string(),
            content_type: None,
        }
    }

    /// The detector both tool paths now share. A stored media record is a receipt; a plausible
    /// address with no file behind it is the fabricated-artifact turn (2026-08-12) and must yield
    /// nothing.
    #[test]
    fn the_detector_accepts_only_a_stored_media_record() {
        let f = produced_file_of_result(&serde_json::json!({
            "success": true,
            "data": { "media": {
                "slug": "samsung-brief-a1b2",
                "url": "/user/media/samsung-brief-a1b2.pdf",
                "contentType": "application/pdf"
            }}
        }))
        .expect("a stored media record is a produced file");
        assert_eq!(f.url, "/user/media/samsung-brief-a1b2.pdf");
        assert_eq!(f.name, "samsung-brief-a1b2");
        assert_eq!(f.content_type.as_deref(), Some("application/pdf"));

        // filenameHint wins over slug; with neither, the address names the file.
        let hinted = produced_file_of_result(&serde_json::json!({"data": {"media": {
            "slug": "x-9f", "url": "/user/media/x-9f.xlsx", "filenameHint": "삼성 대시보드"
        }}}))
        .unwrap();
        assert_eq!(hinted.name, "삼성 대시보드");
        let bare = produced_file_of_result(
            &serde_json::json!({"data": {"media": {"url": "/user/media/x-9f.xlsx"}}}),
        )
        .unwrap();
        assert_eq!(bare.name, "x-9f.xlsx");
        assert!(bare.content_type.is_none(), "an unknown type is omitted, not guessed");

        for shape in [
            serde_json::json!({"data": {"media": {"url": "https://example.com/report.pdf"}}}),
            serde_json::json!({"data": {"media": {"url": "/user/attachments/report.pdf"}}}),
            serde_json::json!({"data": {"media": {"url": "/user/media/"}}}),
            serde_json::json!({"data": {"media": {"slug": "no-url"}}}),
            serde_json::json!({"data": {"mediaExportError": "media import refused"}}),
            serde_json::json!({"data": {}}),
            serde_json::json!({"success": true}),
        ] {
            assert!(
                produced_file_of_result(&shape).is_none(),
                "not a stored file: {shape}"
            );
        }
    }

    /// The key derivation both paths will share: a conversation id when there is one, the
    /// caller's own token when there is not, and never a collision between the two namespaces.
    #[test]
    fn scope_key_prefers_the_conversation() {
        assert_eq!(scope_key(Some("conv-1"), "tok-9"), "conv:conv-1");
        assert_eq!(scope_key(None, "tok-9"), "token:tok-9");
        assert_eq!(scope_key(Some("   "), "tok-9"), "token:tok-9");
        assert_ne!(scope_key(Some("x"), "y"), scope_key(None, "x"));
    }
}

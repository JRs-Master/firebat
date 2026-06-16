//! Build Session — state store for the Project Builder app-build standard flow.
//!
//! Borrows the plan_store pattern (in-memory `Mutex<HashMap>` + file persistence). 30-day TTL =
//! unified with pending_tools/plan_store (single TTL for approval/pending cards, CLAUDE.md #1-9).
//!
//! Project Builder = the first **forced-flow engine** — the engine enforces the order of the
//! app-build steps (S1 requirements → S2 design → S3 refine → S4 implement). It is a **separate
//! layer** next to plan_mode (a flexible prompt prefix), not a replacement (forced procedure only
//! when the domain has a standard order = SDLC; arbitrary-task plans stay flexible).
//!
//! This module = **P1** (engine data + step state machine + persistence) plus the interactive
//! pause gate. The engine forces the step transitions; the content of each step is produced by the AI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 30 days — same as pending_tools/plan_store (single TTL for approval/pending cards, #1-9).
const SESSION_EXPIRE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_SIZE: usize = 50;

/// Standard app-build steps — the engine enforces the order. Per-tier skips (e.g. T1 skips Design)
/// are handled in next_for_tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildStep {
    Requirements, // S1 — requirements (feature selection) + tier classification
    Design,       // S2 — design (component vs html, theme/skin)
    Refine,       // S3 — final additive requests before building (forgotten/new) = pre-build checkpoint
    Implement,    // S4 — create / save / publish (LAST step)
    Done,         // complete
}

impl BuildStep {
    /// Linear next step. Per-tier branching is handled in next_for_tier.
    pub fn next(self) -> BuildStep {
        match self {
            BuildStep::Requirements => BuildStep::Design,
            BuildStep::Design => BuildStep::Refine,
            BuildStep::Refine => BuildStep::Implement,
            BuildStep::Implement | BuildStep::Done => BuildStep::Done,
        }
    }
    /// Per-tier next step. Design now stays for ALL tiers — apps/games are visual (theme·skin·color·layout
    /// is a real user choice), so "simple" ≠ "no design". (The AI keeps design light for trivial pages.)
    /// Was: T1 skipped Design (requirements→implement) — dropped 2026-06-08, the skip was too aggressive.
    pub fn next_for_tier(self, _tier: Option<BuildTier>) -> BuildStep {
        self.next()
    }
    /// step_outputs key — for storing the step output and checking the transition gate.
    pub fn key(self) -> &'static str {
        match self {
            BuildStep::Requirements => "requirements",
            BuildStep::Design => "design",
            BuildStep::Refine => "refine",
            BuildStep::Implement => "implement",
            BuildStep::Done => "done",
        }
    }
}

/// Complexity tier — classified by the AI in S1. Basis for path branching. (Variant names T1/T2/T3 serialize as-is.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BuildTier {
    T1, // simple page (render/html, no module)
    T2, // page that calls existing modules·services
    T3, // needs a new user module (code generation)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildStatus {
    Active,
    Completed,
    Abandoned,
}

/// One in-progress app-build.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSession {
    pub id: String,
    /// Owning conversation id — ai.rs looks it up via active_session_for_conv for cross-turn flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conv_id: Option<String>,
    /// Original user request.
    pub request: String,
    /// Set in S1 (None before classification).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<BuildTier>,
    pub step: BuildStep,
    pub status: BuildStatus,
    /// Per-step output (key = BuildStep::key — requirements/design/refine/implement).
    #[serde(default)]
    pub step_outputs: HashMap<String, serde_json::Value>,
    /// Interactive gate — when true, advance is rejected (awaiting the user's selection). Set by
    /// start_build/advance; cleared at the start of each user turn by ai.rs (reset_awaiting_for_conv),
    /// so advance can only happen once per turn.
    #[serde(default)]
    pub awaiting_user_input: bool,
    /// "Just do it all" (one-shot) mode — when true, advance bypasses the awaiting gate (the AI runs
    /// through to the end automatically). Chosen by the user from the stage card.
    #[serde(default)]
    pub auto_advance: bool,
    /// epoch ms.
    pub created_at: u64,
    pub updated_at: u64,
}

fn now_ms() -> u64 {
    crate::utils::time::now_ms_u64()
}

fn store_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("build-sessions.json")
}

fn store_lock() -> &'static Mutex<HashMap<String, BuildSession>> {
    static STORE: OnceLock<Mutex<HashMap<String, BuildSession>>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut map = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(store_file_path()) {
            if let Ok(arr) = serde_json::from_str::<Vec<BuildSession>>(&raw) {
                let now = now_ms();
                let expired_ms = SESSION_EXPIRE.as_millis() as u64;
                for s in arr {
                    if !s.id.is_empty() && now.saturating_sub(s.created_at) <= expired_ms {
                        map.insert(s.id.clone(), s);
                    }
                }
            }
        }
        Mutex::new(map)
    })
}

fn flush(map: &HashMap<String, BuildSession>) {
    let path = store_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let arr: Vec<&BuildSession> = map.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&arr) {
        let _ = std::fs::write(&path, json);
    }
}

fn cleanup_expired(map: &mut HashMap<String, BuildSession>) {
    let now = now_ms();
    let expired_ms = SESSION_EXPIRE.as_millis() as u64;
    let to_remove: Vec<String> = map
        .iter()
        .filter(|(_, s)| now.saturating_sub(s.created_at) > expired_ms)
        .map(|(k, _)| k.clone())
        .collect();
    for k in to_remove {
        map.remove(&k);
    }
}

/// Create a new build session — status Active, step Requirements (S1). Returns the id.
/// conv_id = owning conversation (for cross-turn lookup, injected by ai.rs). None = single-turn build.
pub fn create_session(conv_id: Option<&str>, request: &str) -> String {
    let id = format!("build_{}", uuid::Uuid::new_v4().simple());
    let Ok(mut map) = store_lock().lock() else {
        return id;
    };
    cleanup_expired(&mut map);
    if map.len() >= MAX_SIZE {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, s)| s.created_at)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }
    let now = now_ms();
    map.insert(
        id.clone(),
        BuildSession {
            id: id.clone(),
            conv_id: conv_id.map(String::from),
            request: request.to_string(),
            tier: None,
            step: BuildStep::Requirements,
            status: BuildStatus::Active,
            step_outputs: HashMap::new(),
            awaiting_user_input: true, // right after start_build = present feature options and await the user (blocks same-turn advance).
            auto_advance: false,
            created_at: now,
            updated_at: now,
        },
    );
    flush(&map);
    id
}

/// The in-progress (Active) build session for this conversation — for cross-turn step injection
/// (most recent one). Queried by ai.rs every turn.
pub fn active_session_for_conv(conv_id: &str) -> Option<BuildSession> {
    let mut map = store_lock().lock().ok()?;
    cleanup_expired(&mut map);
    map.values()
        .filter(|s| s.status == BuildStatus::Active && s.conv_id.as_deref() == Some(conv_id))
        .max_by_key(|s| s.updated_at)
        .cloned()
}

/// Bind the most-recent orphan (conv_id=None) Active session to this conversation, then return it.
///
/// **Admin-only fallback — the caller MUST NOT invoke this for hub turns.** start_build on the admin CLI
/// path runs via MCP without convId injection (only ai.rs FC dispatch and inject_hub_owner inject the
/// scope), so the session is created orphaned (conv_id=None) and active_session_for_conv misses it →
/// no build card + no cross-turn step injection. ai.rs calls this as a fallback for admin so the orphan
/// gets bound to the current conversation (single active build per turn → at most one orphan). Hub/FC
/// sessions are already conv-keyed so they never appear as orphans here; binding an admin orphan to a
/// hub scope would be a cross-tenant leak, hence the admin-only contract.
pub fn adopt_orphan_for_conv(conv_id: &str) -> Option<BuildSession> {
    if conv_id.is_empty() {
        return None;
    }
    let mut map = store_lock().lock().ok()?;
    cleanup_expired(&mut map);
    let orphan_id = map
        .values()
        .filter(|s| s.status == BuildStatus::Active && s.conv_id.is_none())
        .max_by_key(|s| s.created_at)
        .map(|s| s.id.clone())?;
    let s = map.get_mut(&orphan_id)?;
    s.conv_id = Some(conv_id.to_string());
    s.updated_at = now_ms();
    let cloned = s.clone();
    flush(&map);
    Some(cloned)
}

/// Look up a session (memory → file fallback).
pub fn get_session(id: &str) -> Option<BuildSession> {
    {
        let mut map = store_lock().lock().ok()?;
        cleanup_expired(&mut map);
        if let Some(s) = map.get(id) {
            return Some(s.clone());
        }
    }
    let raw = std::fs::read_to_string(store_file_path()).ok()?;
    let arr: Vec<BuildSession> = serde_json::from_str(&raw).ok()?;
    let now = now_ms();
    let expired_ms = SESSION_EXPIRE.as_millis() as u64;
    let mut found = None;
    let mut map = store_lock().lock().ok()?;
    for s in arr {
        if s.id.is_empty() || now.saturating_sub(s.created_at) > expired_ms {
            continue;
        }
        let is_target = s.id == id;
        let cloned = s.clone();
        map.insert(s.id.clone(), s);
        if is_target {
            found = Some(cloned);
        }
    }
    found
}

/// Mutate a session — auto-updates updated_at + flushes.
pub fn update_session(id: &str, f: impl FnOnce(&mut BuildSession)) -> Option<BuildSession> {
    let mut map = store_lock().lock().ok()?;
    let s = map.get_mut(id)?;
    f(s);
    s.updated_at = now_ms();
    let updated = s.clone();
    flush(&map);
    Some(updated)
}

/// Store the S1 tier classification result.
pub fn set_tier(id: &str, tier: BuildTier) -> Option<BuildSession> {
    update_session(id, |s| s.tier = Some(tier))
}

/// Store the current step output (the basis for passing the transition gate).
pub fn set_step_output(id: &str, output: serde_json::Value) -> Option<BuildSession> {
    update_session(id, |s| {
        let key = s.step.key().to_string();
        s.step_outputs.insert(key, output);
    })
}

/// Toggle "just do it all" (one-shot) mode — when true, advance bypasses the awaiting gate (runs to
/// the end). Chosen by the user from the stage card.
pub fn set_auto_advance(id: &str, auto: bool) -> Option<BuildSession> {
    update_session(id, |s| s.auto_advance = auto)
}

/// Called by ai.rs at the start of each user turn — clears the awaiting gate of the (most recent)
/// active session, allowing one advance this turn.
/// (Interactive step enforcement: start/advance lock with awaiting=true, and this unlocks on the next user turn.)
/// Returns `was_awaiting` — true means the user is replying to options we presented last turn (so the AI
/// should advance, not re-present). False means no pending presentation (fresh/mid-step).
pub fn reset_awaiting_for_conv(conv_id: &str) -> bool {
    let Ok(mut map) = store_lock().lock() else {
        return false;
    };
    let target_id = map
        .values()
        .filter(|s| s.status == BuildStatus::Active && s.conv_id.as_deref() == Some(conv_id))
        .max_by_key(|s| s.updated_at)
        .map(|s| s.id.clone());
    if let Some(id) = target_id {
        let changed = match map.get_mut(&id) {
            Some(s) if s.awaiting_user_input => {
                s.awaiting_user_input = false;
                true
            }
            _ => false,
        };
        if changed {
            flush(&map);
        }
        return changed;
    }
    false
}

/// Advance to the next step — gate: the current step must have an output. Per-tier skips in next_for_tier.
pub fn advance_step(id: &str) -> Result<BuildStep, String> {
    let mut map = store_lock().lock().map_err(|_| "lock failed".to_string())?;
    let s = map.get_mut(id).ok_or_else(|| format!("build session '{id}' not found"))?;
    if s.status != BuildStatus::Active {
        return Err("This build session is already finished.".to_string());
    }
    // Interactive gate — if already advanced this turn (awaiting), reject = one step per turn (await the
    // user's selection). In "just do it all" (auto_advance) mode, bypass = run to the end (one-shot).
    if s.awaiting_user_input && !s.auto_advance {
        return Err("Awaiting the user's selection — present the step's options as suggest chips and wait for the user's response. Only one step advances per turn.".to_string());
    }
    if !s.step_outputs.contains_key(s.step.key()) {
        return Err(format!(
            "The current step ({}) has no output yet, so it cannot advance.",
            s.step.key()
        ));
    }
    let next = s.step.next_for_tier(s.tier);
    s.step = next;
    if next == BuildStep::Done {
        s.status = BuildStatus::Completed;
    } else if !s.auto_advance {
        // Present the next step's options, then await the user's response (cleared next user turn by ai.rs). In auto mode, keep going.
        s.awaiting_user_input = true;
    }
    s.updated_at = now_ms();
    flush(&map);
    Ok(next)
}

/// End the session (completed/abandoned).
pub fn finish_session(id: &str, completed: bool) -> Option<BuildSession> {
    update_session(id, |s| {
        s.status = if completed {
            BuildStatus::Completed
        } else {
            BuildStatus::Abandoned
        };
    })
}

/// Per-step AI instruction — returned as the tool result to focus the AI on that step (the engine
/// forces the flow). Each interactive step = present options as suggest chips, then stop.
pub fn step_prompt(step: BuildStep, tier: Option<BuildTier>) -> String {
    match step {
        BuildStep::Requirements => "S1 Feature selection: based on the user's request, present the options as suggest chips in ONE set (+ string-chip shortcuts 'proceed with the recommendation' / 'just do it all'). \
**Choose the chip type that fits the choice — your call**: when several features are combinable, use a multi-select `toggle` so the user checks many then submits once; when it is a single mutually-exclusive pick, plain string chips are fine. **Ask everything in this one set — do NOT split into follow-up questions across turns.** \
At the same time classify the complexity tier — T1=simple page (render/html, no external module) / T2=calls existing modules·services / T3=needs a new user module (code generation). \
**Do NOT call advance_build before the user responds** (the engine allows only one step per turn). The next step is Design. \
When the user responds (toggle submit or a shortcut), call advance_build(tier, output=chosen features, auto=true if the user picked 'just do it all')."
            .to_string(),
        BuildStep::Design => {
            let tier_hint = match tier {
                Some(BuildTier::T1) => "T1: render components vs a custom HTML app + color/theme/layout options. No external module.",
                Some(BuildTier::T2) => "T2: data-source module (sysmod etc.) + design options.",
                Some(BuildTier::T3) => "T3: new user module I/O·logic + design options.",
                None => "tier undecided — classify in S1 first.",
            };
            format!("S2 Design selection: **present design/theme options as suggest chips** and let the user choose (include 'proceed with the recommendation'). {tier_hint} \
**Prefer render components for standard UIs**: tables, charts, galleries (carousel/slideshow), KPIs (metric/grid), forms, tabs, accordions, lists, maps → use the built-in render components. They are consistent, centrally maintained, and already interactive (table = row search + column toggle + click-to-sort; carousel/slideshow nav; etc.) — so platform-wide UI fixes reach every page. Build a **custom HTML app (`html` component) only when the UI is genuinely bespoke** that components can't express — a game, a novel canvas/animation, custom interaction logic. Don't hand-roll an HTML table/gallery/form when a component exists (it re-invents UI, drifts in style, and misses the maintained behavior). \
**Chip types — pick per the choice's nature, do NOT hardcode single vs multi**: the MAIN theme/style is normally ONE pick → use a single-select toggle (a toggle with single:true — a radio: one choice, submitted together with other groups) so it can coexist with auxiliary groups under one submit. If multiple themes can sensibly apply together, use a multi-select toggle instead (no single flag). Add a separate multi-select toggle for genuinely combinable auxiliary options ONLY IF useful — your call whether to offer them. Do NOT use plain string chips for the main theme (a string chip sends immediately and cannot combine with other groups in one submit); reserve string chips for standalone shortcuts like 'proceed with the recommendation'. \
**No advance_build before selection** — present the chips and wait. The next step is Refine (final additions). When the user chooses, call advance_build(output=design choice).")
        }
        BuildStep::Refine => "S3 Refine — final additions before building (NOT a post-build fix loop). Proactively suggest \
commonly-missed extras for THIS app type as suggest chips — \
use a **multi-select toggle so several can be picked**, plus a free-text **input** for the user's own additions, plus a **'없음 / 바로 만들기' skip** option. \
**Do NOT call advance_build before the user responds.** When the user picks additions or skips, call advance_build(output=chosen additions or 'none') to start the build."
            .to_string(),
        BuildStep::Implement => "S4 Implementation (LAST step): build it exactly per the chosen features·design·additions. \
T1/T2 = create·publish the page via save_page. T3 = generate the user module code, then the page. \
**save_page is the final action — call it and STOP. Do NOT call advance_build after save_page** \
(the build completes when the user approves the page; there is no further stage). If the build's data changes periodically \
(quotes·weather·news etc.), you may propose a recurring-refresh cron (schedule_task) alongside."
            .to_string(),
        BuildStep::Done => "The build is complete.".to_string(),
    }
}

/// For debugging / tests.
pub fn clear_sessions_in_memory() {
    if let Ok(mut map) = store_lock().lock() {
        map.clear();
    }
}

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

struct ScopeState {
    /// Provenance the model legitimately observed, oldest first, each stamped when recorded.
    observed: VecDeque<(Instant, String)>,
    /// `"module:action"` → the stamp of the last fetch *or* the last successful check.
    schema_seen: HashMap<String, Instant>,
    /// Last read or write of this scope — the LRU key for `MAX_SCOPES`.
    last_touch: Instant,
}

impl ScopeState {
    fn new(now: Instant) -> Self {
        Self {
            observed: VecDeque::new(),
            schema_seen: HashMap::new(),
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

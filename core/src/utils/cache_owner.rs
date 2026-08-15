//! Who a cached tool result belongs to — the scope whose ending is what deletes it.
//!
//! A cache entry is worth keeping exactly as long as somebody can still name its key. That is not
//! a duration, it is a scope: a cron run's keys are unreachable the moment the run returns, and a
//! conversation's keys stay reachable until the conversation itself is gone. Wall-clock was
//! standing in for both because the entry had nowhere to record which one it was.
//!
//! So the entry records an owner and one call — `drop_owner` — deletes everything that owner had.
//! Time stops being the mechanism and becomes one owner among others (`None` = nobody claimed it,
//! so the sweeper's clock decides). Any future trigger — a setting changed, a series invalidated —
//! plugs in by calling the same function; none of them needs a new concept.
//!
//! Ambient rather than an argument: `SysmodCacheAdapter::data` is reached through four different
//! call paths (auto-cache from the sandbox, the WS sink, module.rs, the timeseries branch), and
//! none of them knows or should know about conversations. This mirrors `cron_context::CRON_JOB`
//! and `hub_context::CURRENT_HUB` — facts about the turn, read where they matter.

tokio::task_local! {
    /// The owner to stamp on entries produced in this task, if any. Unset = time-owned.
    static CACHE_OWNER: Option<String>;
}

/// Owner key for a conversation's working set — dies with the conversation, not with a clock.
pub fn conversation(conversation_id: &str) -> String {
    format!("conv:{}", conversation_id.trim())
}

/// Owner key for one cron run. The run id separates today's run from tomorrow's, so finishing a
/// run cannot delete the next one's entries if the two ever overlap.
pub fn cron_run(job_id: &str, run_id: &str) -> String {
    format!("cron:{}:{}", job_id.trim(), run_id.trim())
}

/// Run `fut` with everything it caches attributed to `owner`.
pub async fn scope<F: std::future::Future>(owner: String, fut: F) -> F::Output {
    CACHE_OWNER.scope(Some(owner), fut).await
}

/// The owner for entries written right now — `None` outside any scope, which is the time-owned
/// case the sweeper handles.
pub fn current() -> Option<String> {
    CACHE_OWNER.try_with(|o| o.clone()).ok().flatten()
}

/// Attribute what `fut` caches to a chat conversation — the shared entry point for BOTH tool
/// paths, so the FC loop and the MCP handler cannot come to different conclusions about who owns
/// a chat's working set. They already have (twice today, in the gate maps and the level fallback);
/// one function is the only thing that stops it.
///
/// Two cases pass through untouched, and both matter:
/// - **already owned** — a cron turn is inside its run's scope, and its CLI loop authenticates
///   with a token that may be bound to some conversation. Re-entering here would hand the run's
///   entries to that conversation, where nothing would ever delete them.
/// - **no conversation** — stdio, an internal dispatch, a turn with no chat behind it. Nobody
///   owns it, so the clock does, exactly as before.
pub async fn in_conversation<F: std::future::Future>(
    conversation_id: Option<&str>,
    fut: F,
) -> F::Output {
    if current().is_some() {
        return fut.await;
    }
    match conversation_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => scope(conversation(id), fut).await,
        None => fut.await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_name_their_scope() {
        assert_eq!(conversation("abc"), "conv:abc");
        assert_eq!(cron_run("btc-trend", "17"), "cron:btc-trend:17");
        // Whitespace would otherwise make two spellings of one owner, and `drop_owner` matches
        // exactly — half the entries would survive their scope.
        assert_eq!(conversation(" abc "), "conv:abc");
    }

    /// A cron run's CLI loop authenticates with a token that may name a conversation. If the
    /// conversation won its entries would move to a scope that never ends for them, so the run's
    /// ownership has to win — this is the rule both tool paths share.
    #[tokio::test]
    async fn a_run_keeps_its_entries_even_when_a_conversation_is_named() {
        let run = cron_run("btc-trend", "17");
        let seen = scope(run.clone(), in_conversation(Some("conv-1"), async { current() })).await;
        assert_eq!(seen, Some(run));
    }

    #[tokio::test]
    async fn a_chat_call_is_owned_by_its_conversation_and_a_nameless_one_by_nobody() {
        assert_eq!(
            in_conversation(Some("conv-1"), async { current() }).await.as_deref(),
            Some("conv:conv-1")
        );
        assert_eq!(in_conversation(None, async { current() }).await, None);
        // A blank id is not an id — it would become one owner every conversation shares.
        assert_eq!(in_conversation(Some("  "), async { current() }).await, None);
    }

    #[tokio::test]
    async fn outside_a_scope_nobody_owns_the_entry() {
        assert_eq!(current(), None);
        let seen = scope(conversation("c1"), async { current() }).await;
        assert_eq!(seen.as_deref(), Some("conv:c1"));
        // And the scope does not leak past its future.
        assert_eq!(current(), None);
    }
}

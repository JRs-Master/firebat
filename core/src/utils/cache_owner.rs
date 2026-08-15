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

    #[tokio::test]
    async fn outside_a_scope_nobody_owns_the_entry() {
        assert_eq!(current(), None);
        let seen = scope(conversation("c1"), async { current() }).await;
        assert_eq!(seen.as_deref(), Some("conv:c1"));
        // And the scope does not leak past its future.
        assert_eq!(current(), None);
    }
}

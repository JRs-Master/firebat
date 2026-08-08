//! Cron execution identity — who is running, not when.
//!
//! The first version was a process-wide counter (a port of the TS
//! `globalThis.__firebatCronAgentJobId` pattern): while ANY cron job was mid-run, every surface's
//! approval check read "cron" and skipped the card. With a five-minute trading schedule that
//! window was effectively always open, and it was measured being crossed — four MCP sells
//! executed with no card while a cron happened to be running (2026-08-06).
//!
//! The counter was process-wide for a real reason, not neglect: a cron agent turn drives a CLI
//! model, and that model's MCP loop arrives as fresh HTTP requests carrying the same shared
//! internal token as any chat turn. The server had nothing to tell them apart by, so time stood
//! in for identity. The repair gives it identity instead:
//!
//! - **in-process**: the job's execution future runs inside a task-local scope. Every gate on
//!   the await chain reads it; a concurrent request from anywhere else reads nothing. (The cron
//!   execution chain is inline awaits throughout — the only spawns nearby are the streaming
//!   relay, the post-run notify hook and the chat turn runner, none of them on a gate path.)
//! - **cross-process** (the CLI's MCP loop): the turn gets its own token, registered while the
//!   turn lives — the hub turn-token pattern — and the MCP server resolves it back to the job
//!   and wraps that one request in the same scope. A chat CLI turn keeps the shared internal
//!   token and therefore no cron identity, which is the entire point.

use std::collections::BTreeMap;
use std::sync::RwLock;

tokio::task_local! {
    /// The cron job id whose execution tree this task belongs to. `None` is set by the MCP
    /// request wrapper for non-cron turns; unset (outside any scope) also means "not cron".
    pub static CRON_JOB: Option<String>;
}

/// Run `fut` as part of `job_id`'s execution — gates on the await chain see a cron identity.
pub async fn scope<F: std::future::Future>(job_id: String, fut: F) -> F::Output {
    CRON_JOB.scope(Some(job_id), fut).await
}

/// Whether THIS task belongs to a cron job's execution. A chat turn, or an admin request that
/// merely happens while a schedule is firing, reads false — that concurrency was the hole.
pub fn is_cron_context_active() -> bool {
    CRON_JOB
        .try_with(|j| j.is_some())
        .unwrap_or(false)
}

/// The job id itself, for logs and provenance.
pub fn active_job_id() -> Option<String> {
    CRON_JOB.try_with(|j| j.clone()).ok().flatten()
}

// ── turn tokens — the cron identity's ride across the process boundary ─────────────────────────

/// token → job id, registered while the turn lives. Same shape as `HUB_CONTEXTS`.
static CRON_TURN_TOKENS: RwLock<BTreeMap<String, String>> = RwLock::new(BTreeMap::new());

/// RAII — `enter` issues and registers a per-turn token, drop unregisters it. The guard must
/// live as long as the turn does: the CLI child authenticates with this token on every round.
pub struct CronTurnGuard {
    token: String,
}

impl CronTurnGuard {
    pub fn enter(job_id: &str) -> (Self, String) {
        let token = new_turn_token(job_id);
        if let Ok(mut m) = CRON_TURN_TOKENS.write() {
            m.insert(token.clone(), job_id.to_string());
        }
        (Self { token: token.clone() }, token)
    }
}

impl Drop for CronTurnGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = CRON_TURN_TOKENS.write() {
            m.remove(&self.token);
        }
    }
}

/// Unlike the hub variant this carries a random suffix: a hub turn token is only ever handed to
/// the visitor's own turn, but a cron token stands in for approval bypass, so it must not be
/// derivable from the job id and the clock.
fn new_turn_token(job_id: &str) -> String {
    use rand::RngCore;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut buf = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut buf);
    format!(
        "cronturn-{}-{}-{}",
        n,
        hex::encode(buf),
        job_id.chars().take(48).collect::<String>()
    )
}

/// The job a registered turn token belongs to — the MCP server's third auth source, and what it
/// wraps the request scope with.
pub fn job_of_turn_token(token: &str) -> Option<String> {
    CRON_TURN_TOKENS
        .read()
        .ok()
        .and_then(|m| m.get(token).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn identity_lives_inside_the_scope_and_nowhere_else() {
        assert!(!is_cron_context_active());
        scope("job-1".to_string(), async {
            assert!(is_cron_context_active());
            assert_eq!(active_job_id().as_deref(), Some("job-1"));
        })
        .await;
        assert!(!is_cron_context_active());
    }

    #[tokio::test]
    async fn a_concurrent_task_sees_no_identity() {
        // The exact hole the counter had: another task running at the same time must read false.
        let running = scope("job-2".to_string(), async {
            tokio::task::yield_now().await;
            is_cron_context_active()
        });
        let bystander = async {
            tokio::task::yield_now().await;
            is_cron_context_active()
        };
        let (inside, outside) = tokio::join!(running, bystander);
        assert!(inside);
        assert!(!outside);
    }

    #[test]
    fn turn_tokens_register_and_unregister_with_the_guard() {
        let (guard, token) = CronTurnGuard::enter("job-3");
        assert_eq!(job_of_turn_token(&token).as_deref(), Some("job-3"));
        drop(guard);
        assert_eq!(job_of_turn_token(&token), None);
    }

    #[test]
    fn two_turns_of_the_same_job_get_distinct_tokens() {
        let (_g1, t1) = CronTurnGuard::enter("job-4");
        let (_g2, t2) = CronTurnGuard::enter("job-4");
        assert_ne!(t1, t2);
    }
}

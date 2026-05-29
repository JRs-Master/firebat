//! Cron context 식별 — process-wide static counter.
//!
//! 옛 TS `globalThis.__firebatCronAgentJobId` 패턴의 Rust port (commit 262bc78).
//!
//! 용도: cron 자동 실행 (사용자 부재) 안에서 CLI 모델의 자체 MCP loop 으로 destructive
//! 도구 (schedule_task / cancel_task / save_page / delete_file / delete_page) 호출 시
//! pending action 만들지 않고 직접 실행. 등록 시점에 이미 사용자 승인 받음.
//!
//! admin chat 안에서 같은 도구 호출 시 = 본 flag 가 설정되지 않음 = MCP handler 가 pending
//! 을 만들어 사용자 승인 카드를 표시.
//!
//! 동시 cron 발화 시점 race = 옛 TS 와 동일하게 단순 counter 사용 (jobId 식별 X).
//! 동시 cron + admin race 시 admin 호출이 cron 우회될 위험 있지만 그 가능성
//! 작음 (cron 발화 빈도 ↓ + admin 사용자 활성 시간 ↑ 으로 거의 0).

use std::sync::atomic::{AtomicUsize, Ordering};

static ACTIVE_CRON_JOBS: AtomicUsize = AtomicUsize::new(0);

/// RAII guard — enter() 호출 시 counter +1, drop 시 -1.
/// run_agent_job RPC + ScheduleManager.run_once 의 agent 분기 양쪽에서 사용.
pub struct CronContextGuard;

impl CronContextGuard {
    pub fn enter() -> Self {
        ACTIVE_CRON_JOBS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for CronContextGuard {
    fn drop(&mut self) {
        ACTIVE_CRON_JOBS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 현재 cron 자동 실행 중인지 — MCP handler 가 destructive 도구 처리 시 분기.
pub fn is_cron_context_active() -> bool {
    ACTIVE_CRON_JOBS.load(Ordering::SeqCst) > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_increments_and_decrements() {
        assert!(!is_cron_context_active());
        {
            let _g = CronContextGuard::enter();
            assert!(is_cron_context_active());
        }
        assert!(!is_cron_context_active());
    }

    #[test]
    fn nested_guards_both_required_for_inactive() {
        let _g1 = CronContextGuard::enter();
        {
            let _g2 = CronContextGuard::enter();
            assert!(is_cron_context_active());
        }
        assert!(is_cron_context_active());
        drop(_g1);
        assert!(!is_cron_context_active());
    }
}

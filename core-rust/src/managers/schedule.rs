//! ScheduleManager — 크론/예약 CRUD facade.
//!
//! 옛 TS `core/managers/schedule-manager.ts` Rust 재구현 (Phase B-13 minimum).
//!
//! Phase B-13 minimum:
//! - schedule / cancel / update / list / getLogs / clearLogs / triggerNow / consumeNotifications
//! - on_trigger 콜백 등록 (BIBLE: cron 콜백도 Core facade 경유)
//! - timezone CRUD
//!
//! Phase B-16+ 후속:
//! - handle_trigger (runWhen 평가 / retry / oneShot 자동 취소 / notify hook / pipeline 위임)
//! - TaskManager + AiManager + sandbox + resolveCallTarget 박힌 후 활성

use std::sync::Arc;

use crate::adapters::cron::TokioCronAdapter;
use crate::ports::{
    CronJobInfo, CronLogEntry, CronNotification, CronScheduleOptions, CronTriggerCallback,
    ICronPort, InfraResult,
};

pub struct ScheduleManager {
    cron: Arc<TokioCronAdapter>,
}

impl ScheduleManager {
    pub fn new(cron: Arc<TokioCronAdapter>) -> Self {
        Self { cron }
    }

    pub async fn schedule(
        &self,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()> {
        // pipeline 검증은 Phase B-14 TaskManager 박힌 후 Core facade 에서 수행.
        // agent 모드 검증도 Phase B-16 AiManager 박힌 후 Core facade 에서.
        // 매니저 차원에서는 어댑터 위임만.
        if let (None, None, None) = (
            opts.cron_time.as_ref(),
            opts.run_at.as_ref(),
            opts.delay_sec,
        ) {
            return Err(
                "schedule: cronTime / runAt / delaySec 중 하나는 반드시 지정하세요"
                    .to_string(),
            );
        }
        self.cron.schedule_with_spawn(job_id, target_path, opts).await
    }

    pub async fn cancel(&self, job_id: &str) -> InfraResult<()> {
        self.cron.cancel(job_id).await
    }

    pub async fn update(
        &self,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()> {
        let _ = self.cron.cancel(job_id).await; // 미존재 OK
        self.schedule(job_id, target_path, opts).await
    }

    pub async fn trigger_now(&self, job_id: &str) -> InfraResult<()> {
        self.cron.trigger_now(job_id).await
    }

    pub fn list(&self) -> Vec<CronJobInfo> {
        self.cron.list()
    }

    pub fn get_logs(&self, limit: Option<usize>) -> Vec<CronLogEntry> {
        self.cron.get_logs(limit)
    }

    pub fn clear_logs(&self) {
        self.cron.clear_logs()
    }

    pub fn consume_notifications(&self) -> Vec<CronNotification> {
        self.cron.consume_notifications()
    }

    pub fn set_timezone(&self, tz: &str) {
        self.cron.set_timezone(tz);
    }

    pub fn get_timezone(&self) -> String {
        self.cron.get_timezone()
    }

    pub fn on_trigger(&self, callback: CronTriggerCallback) {
        self.cron.on_trigger(callback);
    }

    /// 부팅 시 영속 잡 복원 — main.rs 가 호출.
    pub async fn restore(&self) {
        self.cron.restore().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manager() -> (ScheduleManager, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let jobs = dir.path().join("jobs.json");
        let logs = dir.path().join("logs.json");
        let notes = dir.path().join("notes.json");
        let cron = TokioCronAdapter::new(jobs, logs, notes, "Asia/Seoul").unwrap();
        (ScheduleManager::new(cron), dir)
    }

    #[tokio::test]
    async fn schedule_invalid_no_time_rejected() {
        let (mgr, _dir) = manager();
        let result = mgr
            .schedule("j", "/p", CronScheduleOptions::default())
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn schedule_list_cancel_via_manager() {
        let (mgr, _dir) = manager();
        mgr.schedule(
            "j1",
            "/p",
            CronScheduleOptions {
                cron_time: Some("0 0 * * * *".to_string()),
                title: Some("test".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let list = mgr.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].options.title.as_deref(), Some("test"));

        mgr.cancel("j1").await.unwrap();
        assert!(mgr.list().is_empty());
    }

    #[tokio::test]
    async fn timezone_default_and_override() {
        let (mgr, _dir) = manager();
        assert_eq!(mgr.get_timezone(), "Asia/Seoul");
        mgr.set_timezone("UTC");
        assert_eq!(mgr.get_timezone(), "UTC");
    }
}

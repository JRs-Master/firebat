//! ScheduleManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::ports::{CronScheduleOptions, ICronPort};
use firebat_infra::adapters::cron::TokioCronAdapter;

fn make_manager() -> (ScheduleManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let jobs = dir.path().join("jobs.json");
    let logs = dir.path().join("logs.json");
    let notes = dir.path().join("notes.json");
    let cron: Arc<dyn ICronPort> = TokioCronAdapter::new(jobs, logs, notes, "Asia/Seoul").unwrap();
    (ScheduleManager::new(cron), dir)
}

#[tokio::test]
async fn schedule_invalid_no_time_rejected() {
    let (mgr, _dir) = make_manager();
    let result = mgr
        .schedule("j", "/p", CronScheduleOptions::default())
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn schedule_list_cancel_via_manager() {
    let (mgr, _dir) = make_manager();
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
    let (mgr, _dir) = make_manager();
    assert_eq!(mgr.get_timezone(), "Asia/Seoul");
    mgr.set_timezone("UTC");
    assert_eq!(mgr.get_timezone(), "UTC");
}

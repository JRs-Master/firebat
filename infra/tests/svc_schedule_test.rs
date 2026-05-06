//! ScheduleService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::ports::ICronPort;
use firebat_core::proto::{
    schedule_service_server::ScheduleService, Empty, JsonArgs, StringRequest,
};
use firebat_core::services::schedule::ScheduleServiceImpl;
use firebat_infra::adapters::cron::TokioCronAdapter;

fn service() -> (ScheduleServiceImpl, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let jobs = dir.path().join("jobs.json");
    let logs = dir.path().join("logs.json");
    let notes = dir.path().join("notes.json");
    let cron: Arc<dyn ICronPort> =
        TokioCronAdapter::new(jobs, logs, notes, "Asia/Seoul").unwrap();
    let mgr = Arc::new(ScheduleManager::new(cron));
    (ScheduleServiceImpl::new(mgr), dir)
}

#[tokio::test]
async fn schedule_then_list_via_grpc() {
    let (svc, _dir) = service();
    let resp = svc
        .schedule_cron(Request::new(JsonArgs {
            raw: serde_json::json!({
                "jobId": "g1",
                "targetPath": "/p",
                "cronTime": "0 0 * * * *"
            })
            .to_string(),
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    let list = svc
        .list_cron(Request::new(Empty {}))
        .await
        .unwrap()
        .into_inner();
    let parsed: serde_json::Value = serde_json::from_str(&list.raw).unwrap();
    assert_eq!(parsed.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn cancel_unknown_returns_error() {
    let (svc, _dir) = service();
    let resp = svc
        .cancel_cron(Request::new(StringRequest {
            value: "none".to_string(),
        }))
        .await
        .unwrap();
    let status = resp.into_inner();
    assert!(!status.ok);
}

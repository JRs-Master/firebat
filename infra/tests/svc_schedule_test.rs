//! ScheduleService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::ports::ICronPort;
use firebat_core::proto::{
    schedule_service_server::ScheduleService, Empty, ScheduleCronRequest, StringRequest,
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
        .schedule_cron(Request::new(ScheduleCronRequest {
            job_id: Some("g1".to_string()),
            target_path: "/p".to_string(),
            mode: "cron".to_string(),
            cron_time: Some("0 0 * * * *".to_string()),
            run_at: None,
            delay_sec: None,
            start_at: None,
            end_at: None,
            input_data_json: None,
            pipeline_json: None,
            title: None,
            description: None,
            one_shot: None,
            run_when_json: None,
            retry_json: None,
            notify_json: None,
            execution_mode: None,
            agent_prompt: None,
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    let list = svc
        .list_cron(Request::new(Empty {}))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(list.jobs.len(), 1);
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

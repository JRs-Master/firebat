//! ScheduleService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::ports::ICronPort;
use firebat_core::proto::{
    schedule_service_server::ScheduleService, CancelCronRequest, ListCronRequest,
    ScheduleCronRequest,
};
use firebat_core::grpc::schedule::ScheduleServiceImpl;
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
    svc.schedule_cron(Request::new(ScheduleCronRequest {
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

    let list = svc
        .list_cron(Request::new(ListCronRequest {}))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(list.jobs.len(), 1);
}

#[tokio::test]
async fn cancel_unknown_returns_error() {
    let (svc, _dir) = service();
    // ICronPort.cancel 시그니처 `InfraResult<bool>` — Ok(false) = 미존재.
    // service impl 가 NotFound 으로 매핑.
    let err = svc
        .cancel_cron(Request::new(CancelCronRequest {
            job_id: "none".to_string(),
            owner: None,
        }))
        .await
        .err()
        .expect("cancel_cron 미존재 jobId 시 에러 응답 기대");
    assert_eq!(err.code(), tonic::Code::NotFound);
}

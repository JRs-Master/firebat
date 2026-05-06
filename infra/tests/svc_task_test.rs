//! TaskService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use serde_json::json;
use tonic::Request;

use firebat_core::managers::task::{StubTaskExecutor, TaskExecutor, TaskManager};
use firebat_core::ports::ILogPort;
use firebat_core::proto::{task_service_server::TaskService, JsonArgs};
use firebat_core::services::task::TaskServiceImpl;
use firebat_infra::adapters::log::ConsoleLogAdapter;

fn service() -> TaskServiceImpl {
    let executor: Arc<dyn TaskExecutor> = Arc::new(StubTaskExecutor);
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = Arc::new(TaskManager::new(executor, log));
    TaskServiceImpl::new(mgr)
}

#[tokio::test]
async fn run_condition_only_pipeline_via_grpc() {
    let svc = service();
    let body = json!({
        "steps": [
            {"type": "CONDITION", "field": "x", "op": "exists"}
        ]
    });
    let resp = svc
        .run(Request::new(JsonArgs {
            raw: body.to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    // x 가 prev=null 에 없으므로 unmet → conditionMet=false 결과
    assert_eq!(parsed["success"], json!(true));
    assert_eq!(parsed["data"]["conditionMet"], json!(false));
}

#[tokio::test]
async fn run_validate_failure_returns_error() {
    let svc = service();
    let body = json!({
        "steps": [
            {"type": "EXECUTE", "path": ""}
        ]
    });
    let resp = svc
        .run(Request::new(JsonArgs {
            raw: body.to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert_eq!(parsed["success"], json!(false));
    assert!(parsed["error"].as_str().unwrap().contains("EXECUTE"));
}

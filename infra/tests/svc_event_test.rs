//! EventService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tonic::Request;

use firebat_core::managers::event::{EventManager, FirebatEvent};
use firebat_core::ports::ILogPort;
use firebat_core::proto::{event_service_server::EventService, NumberRequest};
use firebat_core::services::event::EventServiceImpl;
use firebat_infra::adapters::log::ConsoleLogAdapter;

#[tokio::test]
async fn list_audit_log_via_grpc() {
    let logger: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let manager = Arc::new(EventManager::new(logger));
    let service = EventServiceImpl::new(manager.clone());

    // 이벤트 3개 발행
    manager.emit(FirebatEvent {
        event_type: "x".to_string(),
        data: serde_json::json!({}),
    });
    manager.emit(FirebatEvent {
        event_type: "y".to_string(),
        data: serde_json::json!({}),
    });
    manager.emit(FirebatEvent {
        event_type: "z".to_string(),
        data: serde_json::json!({"v": 1}),
    });

    let resp = service
        .list_audit_log(Request::new(NumberRequest { value: 10 }))
        .await
        .unwrap();
    let log: Vec<serde_json::Value> = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(log[2]["event"]["type"], "z");
}

//! gRPC EventService impl — EventManager wrapping.
//!
//! Phase B: ListAuditLog 만 동작 (audit log 조회). Subscribe streaming RPC 는 추후
//! 박힘 (proto 의 stream JsonValue Subscribe 추가 필요).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::event::EventManager;
use crate::proto::{event_service_server::EventService, JsonValue, NumberRequest};

pub struct EventServiceImpl {
    manager: Arc<EventManager>,
}

impl EventServiceImpl {
    pub fn new(manager: Arc<EventManager>) -> Self {
        Self { manager }
    }
}

#[tonic::async_trait]
impl EventService for EventServiceImpl {
    async fn list_audit_log(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let limit = req.into_inner().value.max(0) as usize;
        let log = self.manager.list_audit_log(limit);
        let raw = serde_json::to_string(&log)
            .map_err(|e| TonicStatus::internal(format!("audit log 직렬화 실패: {e}")))?;
        Ok(Response::new(JsonValue { raw }))
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::log::ConsoleLogAdapter;
    use crate::managers::event::FirebatEvent;
    use crate::ports::ILogPort;

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
}

//! gRPC EventService impl — EventManager wrapping.
//!
//! Phase B: ListAuditLog 만 동작 (audit log 조회). Subscribe streaming RPC 는 추후
//! 설정 (proto 의 stream JsonValue Subscribe 추가 필요).

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

// Tests 이관 — `infra/tests/svc_event_test.rs` (integration test).

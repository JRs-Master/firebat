//! gRPC EventService impl — EventManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! 2026-05-15 unique RPC message — Empty/StringRequest/RawJsonPb 등 shared 폐기 + RPC 별 명시 message.
//! ListAuditLog 는 audit log 엔트리 배열 (동적 domain struct) → JSON 직렬화 raw 유지.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::event::EventManager;
use crate::proto::{
    event_service_server::EventService, EventListAuditLogRequest, EventListAuditLogResponse,
};

pub struct EventServiceImpl {
    manager: Arc<EventManager>,
}

impl EventServiceImpl {
    pub fn new(manager: Arc<EventManager>) -> Self {
        Self { manager }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl EventService for EventServiceImpl {
    async fn list_audit_log(
        &self,
        req: Request<EventListAuditLogRequest>,
    ) -> Result<Response<EventListAuditLogResponse>, TonicStatus> {
        let limit = req.into_inner().limit.max(0) as usize;
        let log = self.manager.list_audit_log(limit);
        Ok(Response::new(EventListAuditLogResponse {
            raw_json: to_raw_json(&log),
        }))
    }
}

// Tests 이관 — `infra/tests/svc_event_test.rs` (integration test).

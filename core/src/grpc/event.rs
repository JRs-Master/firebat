//! gRPC EventService impl — EventManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! 2026-05-15 unique RPC message — Empty/StringRequest/RawJsonPb 등 shared 폐기 + RPC 별 명시 message.
//! ListAuditLog 는 audit log 엔트리 배열 (동적 domain struct) → JSON 직렬화 raw 유지.
//! Subscribe — 실시간 이벤트 server-stream (Rust EventManager → Frontend SSE 다리).

use std::pin::Pin;
use std::sync::Arc;
use tokio_stream::Stream;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::event::{EventFilter, EventManager, FirebatEvent};
use crate::proto::{
    event_service_server::EventService, EventListAuditLogRequest, EventListAuditLogResponse,
    EventStreamPb, EventSubscribeRequest,
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

/// 스트림 drop(클라이언트 끊김·정상 종료) 시 자동 unsubscribe — 죽은 listener 누수 방지.
struct UnsubGuard {
    manager: Arc<EventManager>,
    id: u64,
}
impl Drop for UnsubGuard {
    fn drop(&mut self) {
        self.manager.unsubscribe(self.id);
    }
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

    type SubscribeStream =
        Pin<Box<dyn Stream<Item = Result<EventStreamPb, TonicStatus>> + Send + 'static>>;

    /// 실시간 이벤트 구독 — EventManager 에 listener 등록 → 매 emit 을 server-stream 으로 forward.
    /// EventManager listener 는 sync `Fn(&FirebatEvent)` 라 unbounded mpsc 로 async stream 에 브리지.
    /// 이벤트는 작고 드물어 unbounded 로 backpressure 부담 없음. 끊김 시 guard 가 unsubscribe.
    async fn subscribe(
        &self,
        _req: Request<EventSubscribeRequest>,
    ) -> Result<Response<Self::SubscribeStream>, TonicStatus> {
        let (tx, rx) =
            tokio::sync::mpsc::unbounded_channel::<Result<EventStreamPb, TonicStatus>>();
        let manager = self.manager.clone();
        let sub_id = manager.subscribe(
            EventFilter::All,
            Arc::new(move |ev: &FirebatEvent| {
                // rx drop 후엔 send 가 조용히 실패 — guard 가 곧 unsubscribe.
                let _ = tx.send(Ok(EventStreamPb {
                    r#type: ev.event_type.clone(),
                    data_json: ev.data.to_string(),
                }));
            }),
        );
        let guard_mgr = manager.clone();
        let stream = async_stream::stream! {
            let _guard = UnsubGuard { manager: guard_mgr, id: sub_id };
            let mut rx = rx;
            while let Some(item) = rx.recv().await {
                yield item;
            }
        };
        Ok(Response::new(Box::pin(stream)))
    }
}

// Tests 이관 — `infra/tests/svc_event_test.rs` (integration test).

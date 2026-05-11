//! gRPC EpisodicService impl — EpisodicManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! EventRecord 는 embedding 벡터 포함 도메인 타입이므로 조회 계열은 RawJsonPb.
//! SaveEvent 결과는 FactSaveResultPb 재사용 (id + skipped + similarity 동일 구조).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::episodic::EpisodicManager;
use crate::ports::{EventSearchOpts, ListRecentOpts, SaveEventInput, UpdateEventPatch};
use crate::proto::{
    episodic_service_server::EpisodicService, Empty, EpisodicLinkEntityRequest,
    EpisodicListByEntityRequest, EpisodicListRecentRequest, EpisodicSaveEventRequest,
    EpisodicSearchEventsRequest, EpisodicUpdateEventRequest, FactSaveResultPb, NumberRequest,
    RawJsonPb, Status,
};

pub struct EpisodicServiceImpl {
    manager: Arc<EpisodicManager>,
}

impl EpisodicServiceImpl {
    pub fn new(manager: Arc<EpisodicManager>) -> Self {
        Self { manager }
    }
}

fn ok_status() -> Response<Status> {
    Response::new(Status {
        ok: true,
        error: String::new(),
        error_code: String::new(),
    })
}

fn err_status(msg: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: String::new(),
    })
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

#[tonic::async_trait]
impl EpisodicService for EpisodicServiceImpl {
    async fn save_event(
        &self,
        req: Request<EpisodicSaveEventRequest>,
    ) -> Result<Response<FactSaveResultPb>, TonicStatus> {
        let args = req.into_inner();
        let context = args
            .context_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        match self
            .manager
            .save_event(SaveEventInput {
                event_type: args.event_type,
                title: args.title,
                description: args.description,
                who: args.who,
                context,
                occurred_at: args.occurred_at,
                entity_ids: args.entity_ids,
                source_conv_id: args.source_conv_id,
                ttl_days: args.ttl_days,
                dedup_threshold: args.dedup_threshold,
            })
            .await
        {
            Ok((id, skipped, sim)) => Ok(Response::new(FactSaveResultPb {
                id,
                skipped,
                similarity: sim,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn update_event(
        &self,
        req: Request<EpisodicUpdateEventRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        let context = args
            .context_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let entity_ids = args
            .entity_ids_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        match self.manager.update_event(
            args.id,
            UpdateEventPatch {
                event_type: args.event_type,
                title: args.title,
                description: args.description,
                who: args.who,
                context,
                occurred_at: args.occurred_at,
                entity_ids,
                ttl_days: args.ttl_days,
            },
        ) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete_event(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let id = req.into_inner().value;
        match self.manager.delete_event(id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_event(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let id = req.into_inner().value;
        match self.manager.get_event(id) {
            Ok(rec) => Ok(Response::new(raw_json(&rec))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn search_events(
        &self,
        req: Request<EpisodicSearchEventsRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let opts: EventSearchOpts = if args.opts_json.is_empty() {
            EventSearchOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.search_events(opts).await {
            Ok(list) => Ok(Response::new(raw_json(&list))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_recent(
        &self,
        req: Request<EpisodicListRecentRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let opts: ListRecentOpts = if args.opts_json.is_empty() {
            ListRecentOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.list_recent_events(opts) {
            Ok(list) => Ok(Response::new(raw_json(&list))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_by_entity(
        &self,
        req: Request<EpisodicListByEntityRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .list_events_by_entity(
                args.entity_id,
                args.limit.map(|v| v as usize),
                args.offset.map(|v| v as usize),
            )
            .await
        {
            Ok(list) => Ok(Response::new(raw_json(&list))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn link_entity(
        &self,
        req: Request<EpisodicLinkEntityRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        match self.manager.link_entity(args.event_id, args.entity_id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn unlink_entity(
        &self,
        req: Request<EpisodicLinkEntityRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        match self.manager.unlink_entity(args.event_id, args.entity_id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn cleanup_expired(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        match self.manager.cleanup_expired() {
            Ok(n) => Ok(Response::new(NumberRequest { value: n })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_episodic_test.rs` (integration test).

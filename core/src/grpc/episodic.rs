//! gRPC EpisodicService impl — EpisodicManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! EventRecord 는 embedding 벡터 포함 도메인 타입 — 조회 계열은 raw_json string.
//! 2026-05-15: buf STANDARD lint 정공 — 매 RPC unique Request/Response message.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::episodic::EpisodicManager;
use crate::ports::{EventSearchOpts, ListRecentOpts, SaveEventInput, UpdateEventPatch};
use crate::proto::{
    episodic_service_server::EpisodicService, EpisodicCleanupExpiredRequest,
    EpisodicCleanupExpiredResponse, EpisodicDeleteEventRequest, EpisodicDeleteEventResponse,
    EpisodicGetEventRequest, EpisodicGetEventResponse, EpisodicLinkEntityRequest,
    EpisodicLinkEntityResponse, EpisodicListByEntityRequest, EpisodicListByEntityResponse,
    EpisodicListRecentRequest, EpisodicListRecentResponse, EpisodicSaveEventRequest,
    EpisodicSaveEventResponse, EpisodicSearchEventsRequest, EpisodicSearchEventsResponse,
    EpisodicUnlinkEntityRequest, EpisodicUnlinkEntityResponse, EpisodicUpdateEventRequest,
    EpisodicUpdateEventResponse,
};

pub struct EpisodicServiceImpl {
    manager: Arc<EpisodicManager>,
}

impl EpisodicServiceImpl {
    pub fn new(manager: Arc<EpisodicManager>) -> Self {
        Self { manager }
    }
}

fn raw_json_string(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl EpisodicService for EpisodicServiceImpl {
    async fn save_event(
        &self,
        req: Request<EpisodicSaveEventRequest>,
    ) -> Result<Response<EpisodicSaveEventResponse>, TonicStatus> {
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
            Ok((id, skipped, sim)) => Ok(Response::new(EpisodicSaveEventResponse {
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
    ) -> Result<Response<EpisodicUpdateEventResponse>, TonicStatus> {
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
        self.manager
            .update_event(
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
            )
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EpisodicUpdateEventResponse {}))
    }

    async fn delete_event(
        &self,
        req: Request<EpisodicDeleteEventRequest>,
    ) -> Result<Response<EpisodicDeleteEventResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_event(id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EpisodicDeleteEventResponse {}))
    }

    async fn get_event(
        &self,
        req: Request<EpisodicGetEventRequest>,
    ) -> Result<Response<EpisodicGetEventResponse>, TonicStatus> {
        let id = req.into_inner().id;
        match self.manager.get_event(id) {
            Ok(rec) => Ok(Response::new(EpisodicGetEventResponse {
                raw_json: raw_json_string(&rec),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn search_events(
        &self,
        req: Request<EpisodicSearchEventsRequest>,
    ) -> Result<Response<EpisodicSearchEventsResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts: EventSearchOpts = if args.opts_json.is_empty() {
            EventSearchOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.search_events(opts).await {
            Ok(list) => Ok(Response::new(EpisodicSearchEventsResponse {
                raw_json: raw_json_string(&list),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_recent(
        &self,
        req: Request<EpisodicListRecentRequest>,
    ) -> Result<Response<EpisodicListRecentResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts: ListRecentOpts = if args.opts_json.is_empty() {
            ListRecentOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.list_recent_events(opts) {
            Ok(list) => Ok(Response::new(EpisodicListRecentResponse {
                raw_json: raw_json_string(&list),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_by_entity(
        &self,
        req: Request<EpisodicListByEntityRequest>,
    ) -> Result<Response<EpisodicListByEntityResponse>, TonicStatus> {
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
            Ok(list) => Ok(Response::new(EpisodicListByEntityResponse {
                raw_json: raw_json_string(&list),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn link_entity(
        &self,
        req: Request<EpisodicLinkEntityRequest>,
    ) -> Result<Response<EpisodicLinkEntityResponse>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .link_entity(args.event_id, args.entity_id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EpisodicLinkEntityResponse {}))
    }

    async fn unlink_entity(
        &self,
        req: Request<EpisodicUnlinkEntityRequest>,
    ) -> Result<Response<EpisodicUnlinkEntityResponse>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .unlink_entity(args.event_id, args.entity_id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EpisodicUnlinkEntityResponse {}))
    }

    async fn cleanup_expired(
        &self,
        _req: Request<EpisodicCleanupExpiredRequest>,
    ) -> Result<Response<EpisodicCleanupExpiredResponse>, TonicStatus> {
        match self.manager.cleanup_expired() {
            Ok(n) => Ok(Response::new(EpisodicCleanupExpiredResponse {
                cleaned: n,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_episodic_test.rs` (integration test).

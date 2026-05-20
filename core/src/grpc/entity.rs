//! gRPC EntityService impl — EntityManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! EntityRecord / FactRecord 는 embedding 벡터 포함 도메인 타입 — 조회 계열은 raw_json string.
//! Save 결과 (id + created) 와 FactSave 결과 (id + skipped + similarity) 는 typed message.
//! 2026-05-15: buf STANDARD lint 정공 — 매 RPC unique Request/Response message.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::entity::EntityManager;
use crate::ports::{
    EntitySearchOpts, FactSearchOpts, SaveEntityInput, SaveFactInput, TimelineOpts,
    UpdateEntityPatch, UpdateFactPatch,
};
use crate::proto::{
    entity_service_server::EntityService, EntityCleanupExpiredFactsRequest,
    EntityCleanupExpiredFactsResponse, EntityDeleteFactRequest, EntityDeleteFactResponse,
    EntityDeleteRequest, EntityDeleteResponse, EntityFactSaveRequest, EntityFactSaveResponse,
    EntityFactUpdateRequest, EntityFactUpdateResponse, EntityFindByNameRequest,
    EntityFindByNameResponse, EntityGetFactRequest, EntityGetFactResponse, EntityGetRequest,
    EntityGetResponse, EntityRetrieveContextRequest, EntityRetrieveContextResponse,
    EntitySaveRequest, EntitySaveResponse, EntitySearchFactsRequest, EntitySearchFactsResponse,
    EntitySearchRequest, EntitySearchResponse, EntityTimelineRequest, EntityTimelineResponse,
    EntityUpdateRequest, EntityUpdateResponse,
};

pub struct EntityServiceImpl {
    manager: Arc<EntityManager>,
}

impl EntityServiceImpl {
    pub fn new(manager: Arc<EntityManager>) -> Self {
        Self { manager }
    }
}

fn raw_json_string(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl EntityService for EntityServiceImpl {
    async fn save(
        &self,
        req: Request<EntitySaveRequest>,
    ) -> Result<Response<EntitySaveResponse>, TonicStatus> {
        let args = req.into_inner();
        let metadata = args
            .metadata_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let result = self
            .manager
            .save_entity(SaveEntityInput {
                name: args.name,
                entity_type: args.entity_type,
                aliases: args.aliases,
                metadata,
                source_conv_id: args.source_conv_id,
                owner: args.owner.filter(|s| !s.is_empty()),
            })
            .await;
        match result {
            Ok((id, created)) => Ok(Response::new(EntitySaveResponse { id, created })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn update(
        &self,
        req: Request<EntityUpdateRequest>,
    ) -> Result<Response<EntityUpdateResponse>, TonicStatus> {
        let args = req.into_inner();
        let aliases = args
            .aliases_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let metadata = args
            .metadata_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        self.manager
            .update_entity(
                args.id,
                UpdateEntityPatch {
                    name: args.name,
                    entity_type: args.entity_type,
                    aliases,
                    metadata,
                },
            )
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EntityUpdateResponse {}))
    }

    async fn delete(
        &self,
        req: Request<EntityDeleteRequest>,
    ) -> Result<Response<EntityDeleteResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_entity(id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EntityDeleteResponse {}))
    }

    async fn get(
        &self,
        req: Request<EntityGetRequest>,
    ) -> Result<Response<EntityGetResponse>, TonicStatus> {
        let id = req.into_inner().id;
        match self.manager.get_entity(id) {
            Ok(rec) => Ok(Response::new(EntityGetResponse {
                raw_json: raw_json_string(&rec),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn find_by_name(
        &self,
        req: Request<EntityFindByNameRequest>,
    ) -> Result<Response<EntityFindByNameResponse>, TonicStatus> {
        let name = req.into_inner().name;
        match self.manager.find_entity_by_name(&name) {
            Ok(rec) => Ok(Response::new(EntityFindByNameResponse {
                raw_json: raw_json_string(&rec),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn search(
        &self,
        req: Request<EntitySearchRequest>,
    ) -> Result<Response<EntitySearchResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts: EntitySearchOpts = if args.opts_json.is_empty() {
            EntitySearchOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.search_entities(opts).await {
            Ok(list) => Ok(Response::new(EntitySearchResponse {
                raw_json: raw_json_string(&list),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn save_fact(
        &self,
        req: Request<EntityFactSaveRequest>,
    ) -> Result<Response<EntityFactSaveResponse>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .save_fact(SaveFactInput {
                entity_id: args.entity_id,
                content: args.content,
                fact_type: args.fact_type,
                occurred_at: args.occurred_at,
                tags: args.tags,
                source_conv_id: args.source_conv_id,
                ttl_days: args.ttl_days,
                dedup_threshold: args.dedup_threshold,
            })
            .await
        {
            Ok((id, skipped, sim)) => Ok(Response::new(EntityFactSaveResponse {
                id,
                skipped,
                similarity: sim,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn update_fact(
        &self,
        req: Request<EntityFactUpdateRequest>,
    ) -> Result<Response<EntityFactUpdateResponse>, TonicStatus> {
        let args = req.into_inner();
        let tags = args
            .tags_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        self.manager
            .update_fact(
                args.id,
                UpdateFactPatch {
                    content: args.content,
                    fact_type: args.fact_type,
                    occurred_at: args.occurred_at,
                    tags,
                    ttl_days: args.ttl_days,
                },
            )
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EntityFactUpdateResponse {}))
    }

    async fn delete_fact(
        &self,
        req: Request<EntityDeleteFactRequest>,
    ) -> Result<Response<EntityDeleteFactResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_fact(id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(EntityDeleteFactResponse {}))
    }

    async fn get_fact(
        &self,
        req: Request<EntityGetFactRequest>,
    ) -> Result<Response<EntityGetFactResponse>, TonicStatus> {
        let id = req.into_inner().id;
        match self.manager.get_fact(id) {
            Ok(rec) => Ok(Response::new(EntityGetFactResponse {
                raw_json: raw_json_string(&rec),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_timeline(
        &self,
        req: Request<EntityTimelineRequest>,
    ) -> Result<Response<EntityTimelineResponse>, TonicStatus> {
        let args = req.into_inner();
        match self.manager.get_entity_timeline(
            args.entity_id,
            TimelineOpts {
                limit: args.limit.map(|v| v as usize),
                offset: args.offset.map(|v| v as usize),
                order_by: args.order_by,
                owner: args.owner.filter(|s| !s.is_empty()),
            },
        ) {
            Ok(list) => Ok(Response::new(EntityTimelineResponse {
                raw_json: raw_json_string(&list),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn search_facts(
        &self,
        req: Request<EntitySearchFactsRequest>,
    ) -> Result<Response<EntitySearchFactsResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts: FactSearchOpts = if args.opts_json.is_empty() {
            FactSearchOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.search_facts(opts).await {
            Ok(list) => Ok(Response::new(EntitySearchFactsResponse {
                raw_json: raw_json_string(&list),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn retrieve_context(
        &self,
        req: Request<EntityRetrieveContextRequest>,
    ) -> Result<Response<EntityRetrieveContextResponse>, TonicStatus> {
        let args = req.into_inner();
        let entity_limit = args.entity_limit.map(|v| v as usize).unwrap_or(5);
        let facts_per_entity = args.facts_per_entity.map(|v| v as usize).unwrap_or(5);
        match self
            .manager
            .retrieve_context(&args.query, entity_limit, facts_per_entity)
            .await
        {
            Ok(pairs) => {
                let json: Vec<serde_json::Value> = pairs
                    .into_iter()
                    .map(|(e, facts)| {
                        serde_json::json!({"entity": e, "recentFacts": facts})
                    })
                    .collect();
                Ok(Response::new(EntityRetrieveContextResponse {
                    raw_json: raw_json_string(&json),
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn cleanup_expired_facts(
        &self,
        _req: Request<EntityCleanupExpiredFactsRequest>,
    ) -> Result<Response<EntityCleanupExpiredFactsResponse>, TonicStatus> {
        match self.manager.cleanup_expired() {
            Ok(n) => Ok(Response::new(EntityCleanupExpiredFactsResponse {
                cleaned: n,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_entity_test.rs` (integration test).

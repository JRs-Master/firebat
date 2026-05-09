//! gRPC EntityService impl — EntityManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! EntityRecord / FactRecord 는 embedding 벡터 포함 도메인 타입이므로 조회 계열은 RawJsonPb.
//! Save 결과 (id + created) 와 FactSave 결과 (id + skipped + similarity) 는 typed message.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::entity::EntityManager;
use crate::ports::{
    EntitySearchOpts, FactSearchOpts, SaveEntityInput, SaveFactInput, TimelineOpts,
    UpdateEntityPatch, UpdateFactPatch,
};
use crate::proto::{
    entity_service_server::EntityService, Empty, EntitySaveResultPb, FactSaveResultPb, JsonArgs,
    NumberRequest, RawJsonPb, Status, StringRequest,
};

pub struct EntityServiceImpl {
    manager: Arc<EntityManager>,
}

impl EntityServiceImpl {
    pub fn new(manager: Arc<EntityManager>) -> Self {
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
impl EntityService for EntityServiceImpl {
    async fn save(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<EntitySaveResultPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            name: String,
            #[serde(rename = "type")]
            entity_type: String,
            #[serde(default)]
            aliases: Vec<String>,
            #[serde(default)]
            metadata: Option<serde_json::Value>,
            #[serde(rename = "sourceConvId", default)]
            source_conv_id: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("save args: {e}")))?;
        let result = self
            .manager
            .save_entity(SaveEntityInput {
                name: args.name,
                entity_type: args.entity_type,
                aliases: args.aliases,
                metadata: args.metadata,
                source_conv_id: args.source_conv_id,
            })
            .await;
        match result {
            Ok((id, created)) => Ok(Response::new(EntitySaveResultPb { id, created })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn update(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            id: i64,
            #[serde(default)]
            name: Option<String>,
            #[serde(rename = "type", default)]
            entity_type: Option<String>,
            #[serde(default)]
            aliases: Option<Vec<String>>,
            #[serde(default)]
            metadata: Option<serde_json::Value>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("update args: {e}")))?;
        match self.manager.update_entity(
            args.id,
            UpdateEntityPatch {
                name: args.name,
                entity_type: args.entity_type,
                aliases: args.aliases,
                metadata: args.metadata,
            },
        ) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete(&self, req: Request<NumberRequest>) -> Result<Response<Status>, TonicStatus> {
        let id = req.into_inner().value;
        match self.manager.delete_entity(id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get(&self, req: Request<NumberRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let id = req.into_inner().value;
        match self.manager.get_entity(id) {
            Ok(rec) => Ok(Response::new(raw_json(&rec))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn find_by_name(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let name = req.into_inner().value;
        match self.manager.find_entity_by_name(&name) {
            Ok(rec) => Ok(Response::new(raw_json(&rec))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn search(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        let opts: EntitySearchOpts = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("search args: {e}")))?;
        match self.manager.search_entities(opts).await {
            Ok(list) => Ok(Response::new(raw_json(&list))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn save_fact(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<FactSaveResultPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            #[serde(rename = "entityId")]
            entity_id: i64,
            content: String,
            #[serde(rename = "factType", default)]
            fact_type: Option<String>,
            #[serde(rename = "occurredAt", default)]
            occurred_at: Option<i64>,
            #[serde(default)]
            tags: Vec<String>,
            #[serde(rename = "sourceConvId", default)]
            source_conv_id: Option<String>,
            #[serde(rename = "ttlDays", default)]
            ttl_days: Option<i64>,
            #[serde(rename = "dedupThreshold", default)]
            dedup_threshold: Option<f64>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("save_fact args: {e}")))?;
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
            Ok((id, skipped, sim)) => Ok(Response::new(FactSaveResultPb {
                id,
                skipped,
                similarity: sim,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn update_fact(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            id: i64,
            #[serde(default)]
            content: Option<String>,
            #[serde(rename = "factType", default)]
            fact_type: Option<String>,
            #[serde(rename = "occurredAt", default)]
            occurred_at: Option<i64>,
            #[serde(default)]
            tags: Option<Vec<String>>,
            #[serde(rename = "ttlDays", default)]
            ttl_days: Option<i64>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("update_fact args: {e}")))?;
        match self.manager.update_fact(
            args.id,
            UpdateFactPatch {
                content: args.content,
                fact_type: args.fact_type,
                occurred_at: args.occurred_at,
                tags: args.tags,
                ttl_days: args.ttl_days,
            },
        ) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete_fact(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let id = req.into_inner().value;
        match self.manager.delete_fact(id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_fact(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let id = req.into_inner().value;
        match self.manager.get_fact(id) {
            Ok(rec) => Ok(Response::new(raw_json(&rec))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_timeline(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            #[serde(rename = "entityId")]
            entity_id: i64,
            #[serde(default)]
            limit: Option<usize>,
            #[serde(default)]
            offset: Option<usize>,
            #[serde(rename = "orderBy", default)]
            order_by: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("get_timeline args: {e}")))?;
        match self.manager.get_entity_timeline(
            args.entity_id,
            TimelineOpts {
                limit: args.limit,
                offset: args.offset,
                order_by: args.order_by,
            },
        ) {
            Ok(list) => Ok(Response::new(raw_json(&list))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn search_facts(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        let opts: FactSearchOpts = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("search_facts args: {e}")))?;
        match self.manager.search_facts(opts).await {
            Ok(list) => Ok(Response::new(raw_json(&list))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn retrieve_context(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            query: String,
            #[serde(rename = "entityLimit", default = "default_5")]
            entity_limit: usize,
            #[serde(rename = "factsPerEntity", default = "default_5")]
            facts_per_entity: usize,
        }
        fn default_5() -> usize {
            5
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("retrieve_context args: {e}")))?;
        match self
            .manager
            .retrieve_context(&args.query, args.entity_limit, args.facts_per_entity)
            .await
        {
            Ok(pairs) => {
                let json: Vec<serde_json::Value> = pairs
                    .into_iter()
                    .map(|(e, facts)| {
                        serde_json::json!({"entity": e, "recentFacts": facts})
                    })
                    .collect();
                Ok(Response::new(raw_json(&json)))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn cleanup_expired_facts(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        match self.manager.cleanup_expired() {
            Ok(n) => Ok(Response::new(NumberRequest { value: n })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_entity_test.rs` (integration test).

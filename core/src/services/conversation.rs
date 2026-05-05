//! gRPC ConversationService impl — ConversationManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::conversation::ConversationManager;
use crate::ports::IDatabasePort;
use crate::proto::{
    conversation_service_server::ConversationService, BoolRequest, JsonArgs, JsonValue, NumberRequest,
    Status, StringRequest,
};

pub struct ConversationServiceImpl {
    manager: Arc<ConversationManager>,
    /// IDatabasePort (옵션) — shared_conversations 테이블 RPC (create_share / get_share /
    /// cleanup_expired_shares). 미박힘 시 stub 반환.
    db: Option<Arc<dyn IDatabasePort>>,
}

impl ConversationServiceImpl {
    pub fn new(manager: Arc<ConversationManager>) -> Self {
        Self {
            manager,
            db: None,
        }
    }

    /// IDatabasePort 박은 채로 부팅 — 공유 대화 RPC 활성.
    pub fn with_db(mut self, db: Arc<dyn IDatabasePort>) -> Self {
        self.db = Some(db);
        self
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
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

#[tonic::async_trait]
impl ConversationService for ConversationServiceImpl {
    async fn list(&self, req: Request<StringRequest>) -> Result<Response<JsonValue>, TonicStatus> {
        let owner = req.into_inner().value;
        json_response(&self.manager.list(&owner))
    }

    async fn get(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args { owner: String, id: String }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("get args: {e}")))?;
        json_response(&self.manager.get(&args.owner, &args.id))
    }

    async fn save(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            owner: String,
            id: String,
            title: String,
            messages: serde_json::Value,
            #[serde(default, rename = "createdAt")]
            created_at: Option<i64>,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("save args: {e}"))),
        };
        match self
            .manager
            .save(&args.owner, &args.id, &args.title, &args.messages, args.created_at)
            .await
        {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args { owner: String, id: String }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("delete args: {e}"))),
        };
        match self.manager.delete(&args.owner, &args.id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn is_deleted(&self, req: Request<JsonArgs>) -> Result<Response<BoolRequest>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args { owner: String, id: String }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("is_deleted args: {e}")))?;
        Ok(Response::new(BoolRequest {
            value: self.manager.is_deleted(&args.owner, &args.id),
        }))
    }

    async fn search_history(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            owner: String,
            query: String,
            #[serde(rename = "currentConvId", default)]
            current_conv_id: Option<String>,
            #[serde(default)]
            limit: Option<usize>,
            #[serde(rename = "withinDays", default)]
            within_days: Option<i64>,
            #[serde(rename = "minScore", default)]
            min_score: Option<f32>,
            #[serde(rename = "includeBlocks", default)]
            include_blocks: bool,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("search_history args: {e}")))?;
        let opts = crate::managers::conversation::SearchHistoryOpts {
            current_conv_id: args.current_conv_id,
            limit: args.limit,
            within_days: args.within_days,
            min_score: args.min_score,
            include_blocks: args.include_blocks,
        };
        match self.manager.search_history(&args.owner, &args.query, opts).await {
            Ok(matches) => json_response(&matches),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_cli_session(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args { conversation_id: String, current_model: String }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("args: {e}")))?;
        let session_id = self.manager.get_cli_session(&args.conversation_id, &args.current_model);
        json_response(&session_id)
    }

    async fn set_cli_session(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args { conversation_id: String, session_id: String, model: String }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("args: {e}"))),
        };
        if self.manager.set_cli_session(&args.conversation_id, &args.session_id, &args.model) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_cli_session 실패"))
        }
    }

    async fn create_share(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let Some(db) = &self.db else {
            return Err(TonicStatus::failed_precondition(
                "create_share: IDatabasePort 미박음",
            ));
        };
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            #[serde(rename = "type")]
            share_type: String,
            title: String,
            messages: Vec<serde_json::Value>,
            #[serde(default)]
            owner: Option<String>,
            #[serde(rename = "sourceConvId", default)]
            source_conv_id: Option<String>,
            #[serde(rename = "ttlMs")]
            ttl_ms: i64,
            #[serde(rename = "dedupKey", default)]
            dedup_key: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("create_share args: {e}")))?;
        let input = crate::ports::CreateShareInput {
            share_type: args.share_type,
            title: args.title,
            messages: args.messages,
            owner: args.owner,
            source_conv_id: args.source_conv_id,
            ttl_ms: args.ttl_ms,
            dedup_key: args.dedup_key,
        };
        match db.create_share(&input) {
            Ok(result) => json_response(&serde_json::json!({
                "slug": result.slug,
                "expiresAt": result.expires_at,
                "reused": result.reused,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_share(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let Some(db) = &self.db else {
            return json_response(&serde_json::Value::Null);
        };
        let slug = req.into_inner().value;
        match db.get_share(&slug) {
            Some(record) => json_response(&record),
            None => json_response(&serde_json::Value::Null),
        }
    }

    async fn cleanup_expired_shares(
        &self,
        _req: Request<crate::proto::Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        let Some(db) = &self.db else {
            return Ok(Response::new(NumberRequest { value: 0 }));
        };
        Ok(Response::new(NumberRequest {
            value: db.cleanup_expired_shares(),
        }))
    }
}

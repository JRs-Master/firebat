//! gRPC ConversationService impl — ConversationManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::conversation::ConversationManager;
use crate::proto::{
    conversation_service_server::ConversationService, BoolRequest, JsonArgs, JsonValue, NumberRequest,
    Status, StringRequest,
};

pub struct ConversationServiceImpl {
    manager: Arc<ConversationManager>,
}

impl ConversationServiceImpl {
    pub fn new(manager: Arc<ConversationManager>) -> Self {
        Self { manager }
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
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-15+ 후속 — shared_conversations 테이블 + dedup_key 패턴
        json_response(&serde_json::json!({"_phase": "B-15 stub"}))
    }

    async fn get_share(
        &self,
        _req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&serde_json::Value::Null)
    }

    async fn cleanup_expired_shares(
        &self,
        _req: Request<crate::proto::Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        Ok(Response::new(NumberRequest { value: 0 }))
    }
}

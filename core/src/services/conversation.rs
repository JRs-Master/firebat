//! gRPC ConversationService impl — ConversationManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 박혀 core port/manager struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::conversation::{ConversationManager, HistorySearchMatch};
use crate::ports::{ConversationRecord, ConversationSummary, IDatabasePort, SharedConversationRecord};
use crate::proto::{
    conversation_service_server::ConversationService, BoolRequest, ConversationListPb,
    ConversationRecordPb, ConversationSummaryPb, Empty, HistorySearchMatchPb,
    HistorySearchResultPb, JsonArgs, NumberRequest, OptionalStringPb, ShareResultPb,
    SharedConversationPb, Status, StringRequest,
};

pub struct ConversationServiceImpl {
    manager: Arc<ConversationManager>,
    /// IDatabasePort (옵션) — shared_conversations 테이블 RPC (create_share / get_share /
    /// cleanup_expired_shares). 미설정 시 stub 반환.
    db: Option<Arc<dyn IDatabasePort>>,
}

impl ConversationServiceImpl {
    pub fn new(manager: Arc<ConversationManager>) -> Self {
        Self {
            manager,
            db: None,
        }
    }

    /// IDatabasePort 설정한 채로 부팅 — 공유 대화 RPC 활성.
    pub fn with_db(mut self, db: Arc<dyn IDatabasePort>) -> Self {
        self.db = Some(db);
        self
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

// ─── proto ↔ core struct 변환 ─────────────────────────────────────────────

impl From<ConversationSummary> for ConversationSummaryPb {
    fn from(s: ConversationSummary) -> Self {
        ConversationSummaryPb {
            id: s.id,
            title: s.title,
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

impl From<ConversationRecord> for ConversationRecordPb {
    fn from(r: ConversationRecord) -> Self {
        ConversationRecordPb {
            id: r.id,
            title: r.title,
            messages_json: serde_json::to_string(&r.messages)
                .unwrap_or_else(|_| "[]".to_string()),
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

impl From<HistorySearchMatch> for HistorySearchMatchPb {
    fn from(m: HistorySearchMatch) -> Self {
        HistorySearchMatchPb {
            conv_id: m.conv_id,
            conv_title: m.conv_title,
            msg_idx: m.msg_idx,
            role: m.role,
            content_preview: m.content_preview,
            created_at: m.created_at,
            score: m.score,
            blocks_json: m
                .blocks
                .as_ref()
                .and_then(|b| serde_json::to_string(b).ok()),
        }
    }
}

impl From<SharedConversationRecord> for SharedConversationPb {
    fn from(r: SharedConversationRecord) -> Self {
        SharedConversationPb {
            slug: r.slug,
            share_type: r.share_type,
            title: r.title,
            messages_json: serde_json::to_string(&r.messages)
                .unwrap_or_else(|_| "[]".to_string()),
            created_at: r.created_at,
            expires_at: r.expires_at,
        }
    }
}

#[tonic::async_trait]
impl ConversationService for ConversationServiceImpl {
    async fn list(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<ConversationListPb>, TonicStatus> {
        let owner = req.into_inner().value;
        let items = self.manager.list(&owner).into_iter().map(Into::into).collect();
        Ok(Response::new(ConversationListPb { items }))
    }

    async fn get(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<ConversationRecordPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            owner: String,
            id: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("get args: {e}")))?;
        Ok(Response::new(
            self.manager
                .get(&args.owner, &args.id)
                .map(Into::into)
                .unwrap_or_default(),
        ))
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
        struct Args {
            owner: String,
            id: String,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("delete args: {e}"))),
        };
        match self.manager.delete(&args.owner, &args.id) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn is_deleted(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            owner: String,
            id: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("is_deleted args: {e}")))?;
        Ok(Response::new(BoolRequest {
            value: self.manager.is_deleted(&args.owner, &args.id),
        }))
    }

    async fn search_history(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<HistorySearchResultPb>, TonicStatus> {
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
            Ok(matches) => {
                let pb_matches = matches.into_iter().map(Into::into).collect();
                Ok(Response::new(HistorySearchResultPb { matches: pb_matches }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_cli_session(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<OptionalStringPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            conversation_id: String,
            current_model: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("args: {e}")))?;
        let session_id = self.manager.get_cli_session(&args.conversation_id, &args.current_model);
        Ok(Response::new(OptionalStringPb {
            value: session_id.clone().unwrap_or_default(),
            present: session_id.is_some(),
        }))
    }

    async fn set_cli_session(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            conversation_id: String,
            session_id: String,
            model: String,
        }
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
    ) -> Result<Response<ShareResultPb>, TonicStatus> {
        let Some(db) = &self.db else {
            return Err(TonicStatus::failed_precondition(
                "create_share: IDatabasePort 미설정",
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
            Ok(result) => Ok(Response::new(ShareResultPb {
                slug: result.slug,
                expires_at: result.expires_at,
                reused: result.reused,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_share(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<SharedConversationPb>, TonicStatus> {
        let Some(db) = &self.db else {
            return Ok(Response::new(SharedConversationPb::default()));
        };
        let slug = req.into_inner().value;
        Ok(Response::new(
            db.get_share(&slug)
                .map(Into::into)
                .unwrap_or_default(),
        ))
    }

    async fn cleanup_expired_shares(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        let Some(db) = &self.db else {
            return Ok(Response::new(NumberRequest { value: 0 }));
        };
        Ok(Response::new(NumberRequest {
            value: db.cleanup_expired_shares(),
        }))
    }
}

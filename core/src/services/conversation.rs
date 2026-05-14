//! gRPC ConversationService impl — ConversationManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port/manager struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::conversation::{ConversationManager, HistorySearchMatch};
use crate::ports::{ConversationRecord, ConversationSummary, IDatabasePort, SharedConversationRecord};
use crate::proto::{
    conversation_service_server::ConversationService, BoolRequest, ConversationCreateShareRequest,
    ConversationGetCliSessionRequest, ConversationListPb, ConversationOwnerIdRequest,
    ConversationRecordPb, ConversationSaveRequest, ConversationSearchHistoryRequest,
    ConversationSetCliSessionRequest, ConversationSummaryPb, Empty, HistorySearchMatchPb,
    HistorySearchResultPb, NumberRequest, OptionalStringPb, ShareResultPb, SharedConversationPb,
    StringRequest,
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
        req: Request<ConversationOwnerIdRequest>,
    ) -> Result<Response<ConversationRecordPb>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(
            self.manager
                .get(&args.owner, &args.id)
                .map(Into::into)
                .unwrap_or_default(),
        ))
    }

    async fn save(&self, req: Request<ConversationSaveRequest>) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        let messages: serde_json::Value = serde_json::from_str(&args.messages_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("save messages_json: {e}")))?;
        self.manager
            .save(&args.owner, &args.id, &args.title, &messages, args.created_at)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn delete(&self, req: Request<ConversationOwnerIdRequest>) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .delete(&args.owner, &args.id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn is_deleted(
        &self,
        req: Request<ConversationOwnerIdRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(BoolRequest {
            value: self.manager.is_deleted(&args.owner, &args.id),
        }))
    }

    async fn search_history(
        &self,
        req: Request<ConversationSearchHistoryRequest>,
    ) -> Result<Response<HistorySearchResultPb>, TonicStatus> {
        let args = req.into_inner();
        let opts = crate::managers::conversation::SearchHistoryOpts {
            current_conv_id: args.current_conv_id,
            limit: args.limit.map(|v| v as usize),
            within_days: args.within_days,
            min_score: args.min_score.map(|v| v as f32),
            include_blocks: args.include_blocks.unwrap_or(false),
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
        req: Request<ConversationGetCliSessionRequest>,
    ) -> Result<Response<OptionalStringPb>, TonicStatus> {
        let args = req.into_inner();
        let session_id = self.manager.get_cli_session(&args.conversation_id, &args.current_model);
        Ok(Response::new(OptionalStringPb {
            value: session_id.clone().unwrap_or_default(),
            present: session_id.is_some(),
        }))
    }

    async fn set_cli_session(
        &self,
        req: Request<ConversationSetCliSessionRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        if self.manager.set_cli_session(&args.conversation_id, &args.session_id, &args.model) {
            Ok(Response::new(Empty {}))
        } else {
            Err(TonicStatus::internal("set_cli_session 실패"))
        }
    }

    async fn create_share(
        &self,
        req: Request<ConversationCreateShareRequest>,
    ) -> Result<Response<ShareResultPb>, TonicStatus> {
        let Some(db) = &self.db else {
            return Err(TonicStatus::failed_precondition(
                "create_share: IDatabasePort 미설정",
            ));
        };
        let args = req.into_inner();
        let messages: Vec<serde_json::Value> = match serde_json::from_str(&args.messages_json) {
            Ok(v) => v,
            Err(e) => return Err(TonicStatus::invalid_argument(format!("create_share messages_json: {e}"))),
        };
        const DEFAULT_SHARE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
        let input = crate::ports::CreateShareInput {
            share_type: args.share_type,
            title: args.title,
            messages,
            owner: args.owner,
            source_conv_id: args.source_conv_id,
            ttl_ms: args.ttl_ms.unwrap_or(DEFAULT_SHARE_TTL_MS),
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

    async fn list_deleted(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<ConversationListPb>, TonicStatus> {
        let owner = req.into_inner().value;
        let items = self
            .manager
            .list_deleted(&owner)
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ConversationListPb { items }))
    }

    async fn restore(&self, req: Request<ConversationOwnerIdRequest>) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .restore(&args.owner, &args.id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn permanent_delete(
        &self,
        req: Request<ConversationOwnerIdRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .permanent_delete(&args.owner, &args.id)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn cleanup_old_deleted(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        // 30일 retention — internal cron 이 호출. 응답: 삭제된 conversation 개수.
        const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
        Ok(Response::new(NumberRequest {
            value: self.manager.cleanup_old_deleted(RETENTION_MS),
        }))
    }
}

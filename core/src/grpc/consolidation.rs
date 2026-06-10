//! gRPC ConsolidationService impl — ConsolidationManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! AskLlmText → ConsolidationAskLlmTextResponse (단순 텍스트), GetMemoryStats → MemoryStatsPb.
//! Consolidate / ConsolidateInactive → 중첩 구조 raw_json field.
//! 2026-05-15: 옛 공유 타입 (Empty / RawJsonPb / LlmTextResultPb) → RPC 별 unique
//! Request/Response 분리 (buf STANDARD lint RPC_REQUEST_RESPONSE_UNIQUE).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::consolidation::{ConsolidationManager, ExtractionResult};
use crate::proto::{
    consolidation_service_server::ConsolidationService, ConsolidationAskLlmTextRequest,
    ConsolidationAskLlmTextResponse, ConsolidationConsolidateInactiveRequest,
    ConsolidationConsolidateInactiveResponse, ConsolidationConsolidateRequest,
    ConsolidationConsolidateResponse, ConsolidationGetMemoryStatsRequest, MemoryStatsPb,
};

pub struct ConsolidationServiceImpl {
    manager: Arc<ConsolidationManager>,
}

impl ConsolidationServiceImpl {
    pub fn new(manager: Arc<ConsolidationManager>) -> Self {
        Self { manager }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl ConsolidationService for ConsolidationServiceImpl {
    async fn ask_llm_text(
        &self,
        req: Request<ConsolidationAskLlmTextRequest>,
    ) -> Result<Response<ConsolidationAskLlmTextResponse>, TonicStatus> {
        let args = req.into_inner();
        let opts = crate::ports::LlmCallOpts {
            model: args.model,
            thinking_level: args.thinking_level,
            system_prompt: args.system_prompt,
            ..Default::default()
        };
        match self.manager.ask_llm_text(&args.prompt, &opts).await {
            Ok(text) => Ok(Response::new(ConsolidationAskLlmTextResponse { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    /// 두 entry point union — 옛 TS 의 `Core.consolidateConversation({owner, convId})` (LLM 자동 추출)
    /// + `ConsolidationManager.saveExtracted({extracted})` (미리 추출된 save 전용) 를 한 RPC 에 흡수.
    /// frontend "이 대화 정리" 버튼은 `{conversationId, owner}` 만 전달 → LLM 자동 추출 분기.
    /// AI 도구 (consolidate_conversation) 도 같은 분기. extracted 가 포함된 호출은 save 전용 분기.
    async fn consolidate(
        &self,
        req: Request<ConsolidationConsolidateRequest>,
    ) -> Result<Response<ConsolidationConsolidateResponse>, TonicStatus> {
        let args = req.into_inner();
        // 분기 1: conversation_id 가 포함된 자동 추출 (LLM 호출) — frontend "이 대화 정리" 버튼 + AI 도구
        if let Some(conv_id) = args.conversation_id {
            let owner = args.owner.unwrap_or_else(|| "admin".to_string());
            return match self
                .manager
                .consolidate_conversation(&owner, &conv_id, args.model_id.as_deref())
                .await
            {
                Ok(outcome) => Ok(Response::new(ConsolidationConsolidateResponse {
                    raw_json: to_raw_json(&outcome),
                })),
                Err(e) => Err(TonicStatus::internal(e)),
            };
        }
        // 분기 2: extracted 가 포함된 save 전용
        let extracted: Option<ExtractionResult> = args
            .extracted_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let Some(extracted) = extracted else {
            return Err(TonicStatus::invalid_argument(
                "consolidate args: conversation_id 또는 extracted_json 필요",
            ));
        };
        match self
            .manager
            .save_extracted(
                extracted,
                args.source_conv_id.as_deref(),
                args.fact_dedup_threshold,
                args.event_dedup_threshold,
                args.owner.as_deref().filter(|o| !o.is_empty() && *o != "admin"), // save 전용 분기도 owner scope 전달
            )
            .await
        {
            Ok(outcome) => Ok(Response::new(ConsolidationConsolidateResponse {
                raw_json: to_raw_json(&outcome),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn consolidate_inactive(
        &self,
        req: Request<ConsolidationConsolidateInactiveRequest>,
    ) -> Result<Response<ConsolidationConsolidateInactiveResponse>, TonicStatus> {
        let args = req.into_inner();
        let result = self
            .manager
            .consolidate_inactive_conversations(
                args.owner.as_deref(),
                args.inactivity_ms,
                args.limit_per_run.map(|v| v as usize),
            )
            .await;
        Ok(Response::new(ConsolidationConsolidateInactiveResponse {
            raw_json: to_raw_json(&result),
        }))
    }

    async fn get_memory_stats(
        &self,
        _req: Request<ConsolidationGetMemoryStatsRequest>,
    ) -> Result<Response<MemoryStatsPb>, TonicStatus> {
        match self.manager.get_memory_stats() {
            Ok(stats) => {
                let entities_by_type_json = serde_json::to_string(&stats.entities_by_type)
                    .unwrap_or_else(|_| "[]".to_string());
                let events_by_type_json = serde_json::to_string(&stats.events_by_type)
                    .unwrap_or_else(|_| "[]".to_string());
                Ok(Response::new(MemoryStatsPb {
                    entities: stats.entities,
                    facts: stats.facts,
                    events: stats.events,
                    entities_by_type_json,
                    events_by_type_json,
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_consolidation_test.rs` (integration test).

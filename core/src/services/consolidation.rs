//! gRPC ConsolidationService impl — ConsolidationManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! AskLlmText → LlmTextResultPb (단순 텍스트), GetMemoryStats → MemoryStatsPb.
//! Consolidate / ConsolidateInactive → 중첩 구조이므로 RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::consolidation::{ConsolidationManager, ExtractionResult};
use crate::proto::{
    consolidation_service_server::ConsolidationService, Empty, JsonArgs, LlmTextResultPb,
    MemoryStatsPb, RawJsonPb,
};

pub struct ConsolidationServiceImpl {
    manager: Arc<ConsolidationManager>,
}

impl ConsolidationServiceImpl {
    pub fn new(manager: Arc<ConsolidationManager>) -> Self {
        Self { manager }
    }
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

#[tonic::async_trait]
impl ConsolidationService for ConsolidationServiceImpl {
    async fn ask_llm_text(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<LlmTextResultPb>, TonicStatus> {
        // 옛 TS Core.askLlmText 1:1 — set_ai_hook 설정되어 있을 때만 활성.
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            prompt: String,
            #[serde(default)]
            model: Option<String>,
            #[serde(rename = "thinkingLevel", default)]
            thinking_level: Option<String>,
            #[serde(rename = "systemPrompt", default)]
            system_prompt: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("ask_llm_text args: {e}")))?;
        let opts = crate::ports::LlmCallOpts {
            model: args.model,
            thinking_level: args.thinking_level,
            system_prompt: args.system_prompt,
            ..Default::default()
        };
        match self.manager.ask_llm_text(&args.prompt, &opts).await {
            Ok(text) => Ok(Response::new(LlmTextResultPb { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    /// 두 entry point union — 옛 TS 의 `Core.consolidateConversation({owner, convId})` (LLM 자동 추출)
    /// + `ConsolidationManager.saveExtracted({extracted})` (미리 추출된 save 전용) 를 한 RPC 에 흡수.
    /// frontend "이 대화 정리" 버튼은 `{conversationId, owner}` 만 전달 → LLM 자동 추출 분기.
    /// AI 도구 (consolidate_conversation) 도 같은 분기. extracted 가 포함된 호출은 save 전용 분기.
    async fn consolidate(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize, Default)]
        struct Args {
            /// 자동 추출 분기 — 사용자 "리콜 버튼" + AI 도구. 옛 TS Core.consolidateConversation 1:1.
            #[serde(rename = "conversationId", default)]
            conversation_id: Option<String>,
            #[serde(default)]
            owner: Option<String>,
            #[serde(rename = "modelId", default)]
            model_id: Option<String>,
            /// 미리 추출 save 분기 — Phase B-16+ LLM 호출 후 같은 흐름으로 합류.
            #[serde(default)]
            extracted: Option<ExtractionResult>,
            #[serde(rename = "sourceConvId", default)]
            source_conv_id: Option<String>,
            #[serde(rename = "factDedupThreshold", default)]
            fact_dedup_threshold: Option<f64>,
            #[serde(rename = "eventDedupThreshold", default)]
            event_dedup_threshold: Option<f64>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("consolidate args: {e}")))?;

        // 분기 1: conversationId 가 포함된 자동 추출 (LLM 호출) — frontend "이 대화 정리" 버튼 + AI 도구
        if let Some(conv_id) = args.conversation_id {
            let owner = args.owner.unwrap_or_else(|| "admin".to_string());
            return match self
                .manager
                .consolidate_conversation(&owner, &conv_id, args.model_id.as_deref())
                .await
            {
                Ok(outcome) => Ok(Response::new(raw_json(&outcome))),
                Err(e) => Err(TonicStatus::internal(e)),
            };
        }
        // 분기 2: extracted 가 포함된 save 전용
        let Some(extracted) = args.extracted else {
            return Err(TonicStatus::invalid_argument(
                "consolidate args: conversationId 또는 extracted 필요",
            ));
        };
        match self
            .manager
            .save_extracted(
                extracted,
                args.source_conv_id.as_deref(),
                args.fact_dedup_threshold,
                args.event_dedup_threshold,
            )
            .await
        {
            Ok(outcome) => Ok(Response::new(raw_json(&outcome))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn consolidate_inactive(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        // 옛 TS consolidateInactiveConversations 1:1 — 매 6시간 cron 호출.
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize, Default)]
        struct Args {
            #[serde(default)]
            owner: Option<String>,
            #[serde(rename = "inactivityMs", default)]
            inactivity_ms: Option<i64>,
            #[serde(rename = "limitPerRun", default)]
            limit_per_run: Option<usize>,
        }
        let args: Args = if raw.is_empty() {
            Args::default()
        } else {
            serde_json::from_str(&raw).unwrap_or_default()
        };
        let result = self
            .manager
            .consolidate_inactive_conversations(
                args.owner.as_deref(),
                args.inactivity_ms,
                args.limit_per_run,
            )
            .await;
        Ok(Response::new(raw_json(&result)))
    }

    async fn get_memory_stats(
        &self,
        _req: Request<Empty>,
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

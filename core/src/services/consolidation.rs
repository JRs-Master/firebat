//! gRPC ConsolidationService impl — ConsolidationManager wrapping.
//!
//! Phase B-12 minimum: save_extracted (consolidate) + get_memory_stats 활성.
//! AskLlmText / ConsolidateInactive 는 Phase B-16+ AiManager + ILlmPort 박힌 후 활성.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::consolidation::{ConsolidationManager, ExtractionResult};
use crate::proto::{
    consolidation_service_server::ConsolidationService, Empty, JsonArgs, JsonValue,
};

pub struct ConsolidationServiceImpl {
    manager: Arc<ConsolidationManager>,
}

impl ConsolidationServiceImpl {
    pub fn new(manager: Arc<ConsolidationManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl ConsolidationService for ConsolidationServiceImpl {
    async fn ask_llm_text(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS Core.askLlmText 1:1 — set_ai_hook 박혀있을 때만 활성.
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
            Ok(text) => json_response(&serde_json::json!({"text": text})),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    /// 미리 추출된 JSON (entity / fact / event) 일괄 save.
    /// AI Phase B-16+ 에서는 LLM 호출 후 같은 메서드 흐름으로 합류.
    async fn consolidate(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            extracted: ExtractionResult,
            #[serde(rename = "sourceConvId", default)]
            source_conv_id: Option<String>,
            #[serde(rename = "factDedupThreshold", default)]
            fact_dedup_threshold: Option<f64>,
            #[serde(rename = "eventDedupThreshold", default)]
            event_dedup_threshold: Option<f64>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("consolidate args: {e}")))?;
        match self
            .manager
            .save_extracted(
                args.extracted,
                args.source_conv_id.as_deref(),
                args.fact_dedup_threshold,
                args.event_dedup_threshold,
            )
            .await
        {
            Ok(outcome) => json_response(&outcome),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn consolidate_inactive(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
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
        json_response(&result)
    }

    async fn get_memory_stats(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        match self.manager.get_memory_stats() {
            Ok(stats) => json_response(&stats),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::memory::SqliteMemoryAdapter;
    use crate::managers::entity::EntityManager;
    use crate::managers::episodic::EpisodicManager;
    use crate::ports::{IEntityPort, IEpisodicPort};

    fn service() -> ConsolidationServiceImpl {
        let adapter = Arc::new(SqliteMemoryAdapter::new_in_memory().unwrap());
        let entity_port: Arc<dyn IEntityPort> = adapter.clone();
        let episodic_port: Arc<dyn IEpisodicPort> = adapter;
        let entity_mgr = Arc::new(EntityManager::new(entity_port));
        let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));
        let mgr = Arc::new(ConsolidationManager::new(entity_mgr, episodic_mgr));
        ConsolidationServiceImpl::new(mgr)
    }

    #[tokio::test]
    async fn consolidate_then_stats_via_grpc() {
        let svc = service();
        let extracted_args = serde_json::json!({
            "extracted": {
                "entities": [{"name": "X", "type": "stock"}],
                "facts": [{"entityName": "X", "content": "1주 매수"}],
                "events": []
            }
        });
        let resp = svc
            .consolidate(Request::new(JsonArgs {
                raw: extracted_args.to_string(),
            }))
            .await
            .unwrap();
        let outcome: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(outcome["saved"]["entities"].as_array().unwrap().len(), 1);
        assert_eq!(outcome["saved"]["facts"].as_array().unwrap().len(), 1);

        let stats_resp = svc
            .get_memory_stats(Request::new(Empty {}))
            .await
            .unwrap();
        let stats: serde_json::Value = serde_json::from_str(&stats_resp.into_inner().raw).unwrap();
        assert_eq!(stats["entities"], 1);
        assert_eq!(stats["facts"], 1);
    }
}

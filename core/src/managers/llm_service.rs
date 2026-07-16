//! LlmService — leaf domain service over `ILlmPort` for plain text generation.
//!
//! Extracted from AiManager (2026-06-26, Hexagonal+DDD+Mediator decomposition). Orchestrators
//! that only need a one-shot LLM completion (Consolidation extraction, Task-pipeline
//! `LlmTransform`) depend on THIS leaf instead of the AiManager orchestrator — removing the
//! orchestrator→orchestrator coupling (violation (a)). AiManager (the chat orchestrator) keeps
//! the multi-turn tool loop; this leaf is just the plain `ask_text`.

use std::sync::Arc;

use crate::managers::cost::CostManager;
use crate::ports::{ILlmPort, InfraResult, LlmCallOpts};

/// Leaf service: plain text completion over the LLM port. No tools, no cross-manager calls.
/// (Cost recording = metering bus, EventManager 분류와 동일한 cross-cutting — 도메인 결합 아님.
/// 이게 없어 consolidation/LLM_TRANSFORM worker 호출이 비용탭에 invisible 이었음, 2026-07-06 갭.)
pub struct LlmService {
    llm: Arc<dyn ILlmPort>,
    cost: Option<Arc<CostManager>>,
}

impl LlmService {
    pub fn new(llm: Arc<dyn ILlmPort>) -> Self {
        Self { llm, cost: None }
    }

    /// Metering hook — 설정 시 매 ask_text 사용량을 llm_costs 에 누적 (category "worker").
    pub fn with_cost(mut self, cost: Arc<CostManager>) -> Self {
        self.cost = Some(cost);
        self
    }

    /// Plain text completion — no tool loop. (Former `AiManager::ask_text`, 1:1.)
    pub async fn ask_text(&self, prompt: &str, opts: &LlmCallOpts) -> InfraResult<String> {
        let response = self.llm.ask_text(prompt, opts).await?;
        if let Some(cost) = &self.cost {
            let _ = cost.record(
                &response.model_id,
                response.tokens_in.unwrap_or(0),
                response.tokens_out.unwrap_or(0),
                response.cached_tokens.unwrap_or(0),
                response.cost_usd.unwrap_or(0.0),
                Some("worker"),
            );
        }
        Ok(response.text)
    }

    pub fn get_model_id(&self) -> String {
        self.llm.get_model_id()
    }
}

//! LlmService — leaf domain service over `ILlmPort` for plain text generation.
//!
//! Extracted from AiManager (2026-06-26, Hexagonal+DDD+Mediator decomposition). Orchestrators
//! that only need a one-shot LLM completion (Consolidation extraction, Task-pipeline
//! `LlmTransform`) depend on THIS leaf instead of the AiManager orchestrator — removing the
//! orchestrator→orchestrator coupling (violation (a)). AiManager (the chat orchestrator) keeps
//! the multi-turn tool loop; this leaf is just the plain `ask_text`.

use std::sync::Arc;

use crate::ports::{ILlmPort, InfraResult, LlmCallOpts};

/// Leaf service: plain text completion over the LLM port. No tools, no cross-manager calls.
pub struct LlmService {
    llm: Arc<dyn ILlmPort>,
}

impl LlmService {
    pub fn new(llm: Arc<dyn ILlmPort>) -> Self {
        Self { llm }
    }

    /// Plain text completion — no tool loop. (Former `AiManager::ask_text`, 1:1.)
    pub async fn ask_text(&self, prompt: &str, opts: &LlmCallOpts) -> InfraResult<String> {
        Ok(self.llm.ask_text(prompt, opts).await?.text)
    }

    pub fn get_model_id(&self) -> String {
        self.llm.get_model_id()
    }
}

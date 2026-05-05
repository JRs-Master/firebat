//! LLM model meta — Phase B-4 cutover 시 옛 infra/llm/config 에서 core 로 이동.
//!
//! 데이터 (LlmModelConfig + builtin_models) 만 core 에서 보유 — service / manager 가
//! UI 노출용으로 직접 사용. 실제 API 호출 (format handlers) 는 infra crate 에 남음.

pub mod config;

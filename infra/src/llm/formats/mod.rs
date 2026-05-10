//! LLM format 핸들러 — 옛 TS infra/llm/formats/*.ts 1:1 port.
//!
//! 4 API + 3 CLI = 7 핸들러. 각 핸들러는 FormatHandler trait 구현.
//! openai-chat 폐기 (2026-05-10) — 모든 OpenAI 모델 Responses API 사용. legacy stale.

pub mod common;
pub mod gemini_shared;
pub mod cli_image_helper;
pub mod anthropic;
pub mod openai_responses;
pub mod gemini_native;
pub mod vertex_gemini;
pub mod cli_claude_code;
pub mod cli_codex;
pub mod cli_gemini;

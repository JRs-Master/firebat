//! LLM format 핸들러 — 옛 TS infra/llm/formats/*.ts 1:1 port.
//!
//! 5 API + 3 CLI = 8 핸들러. 각 핸들러는 FormatHandler trait 구현.

pub mod common;
pub mod gemini_shared;
pub mod anthropic;
pub mod openai_responses;
pub mod openai_chat;
pub mod gemini_native;
pub mod vertex_gemini;
pub mod cli_claude_code;
pub mod cli_codex;
pub mod cli_gemini;

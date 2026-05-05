//! LLM 통합 인프라 — Phase B-17 LLM 8 format 실 wiring.
//!
//! 옛 TS infra/llm/ 1:1 port:
//! - ConfigDrivenAdapter (config-adapter.ts) — JSON config + format 핸들러 분기
//! - LlmModelConfig (configs/*.json) — 모델당 1개 config
//! - 5 API + 3 CLI 포맷 핸들러 — formats/*.rs
//!
//! 원칙: 프로바이더별 개별 어댑터 금지 — config + 핸들러 조합으로 모든 LLM 지원.
//! 새 모델 도입 시 JSON config 1개만 추가 (코드 변경 0).

pub mod config;
pub mod adapter;
pub mod formats;
pub mod component_registry;
pub mod component_search_index;

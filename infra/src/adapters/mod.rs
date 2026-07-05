//! Infra adapters — IStoragePort, IVaultPort 등의 실 구현체.
//!
//! Phase B 진행하며 17 어댑터 설정.

pub mod storage;
pub mod vault;
pub mod auth;
pub mod log;
pub mod database;
pub mod sandbox;
pub mod token_provider;
pub mod ws_api;
pub mod ws_stream;
pub mod timeseries;
pub mod library;
pub mod hub;
pub mod mcp_client;
pub mod memory;
pub mod cron;
pub mod media;
pub mod llm;
pub mod network;
// cache (SysmodCacheAdapter) 는 file I/O 만 의존 → core/utils/sysmod_cache.rs 로 이동.
pub mod tracing_log;
pub mod log_buffer;
pub mod embedder;
pub mod image_gen;
pub mod image_processor;
pub mod notifier_telegram;
// prompt_loader 폐기 (2026-05-16) — 시스템 prompt 영역은 `firebat_core::i18n` 의 통합 다국어
// service 안에서 `system/prompts/{name}/lang/{lang}.md` 자동 scan + `prompt.{name}` lookup.
pub mod embedder_cache;
pub mod config;

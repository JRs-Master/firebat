//! Infra adapters — IStoragePort, IVaultPort 등의 실 구현체.
//!
//! Phase B 진행하며 17 어댑터 설정.

pub mod storage;
pub mod vault;
pub mod auth;
pub mod log;
pub mod database;
pub mod sandbox;
#[cfg(target_os = "linux")]
pub mod sandbox_linux_cgroups;
pub mod mcp_client;
pub mod memory;
pub mod cron;
pub mod media;
pub mod llm;
pub mod network;
// cache (SysmodCacheAdapter) 는 file I/O 만 의존 → core/utils/sysmod_cache.rs 로 이동.
pub mod tracing_log;
pub mod embedder;
pub mod image_gen;
pub mod image_processor;
pub mod notifier_telegram;
pub mod prompt_loader;

//! Infra adapters — IStoragePort, IVaultPort 등의 실 구현체.
//!
//! Phase B 진행하며 17 어댑터 박힘.

pub mod storage;
pub mod vault;
pub mod auth;
pub mod log;
pub mod database;
pub mod sandbox;
pub mod mcp_client;
pub mod memory;
pub mod cron;
pub mod media;
pub mod llm;
pub mod cache;
pub mod tracing_log;
pub mod embedder;
pub mod image_gen;
pub mod image_processor;

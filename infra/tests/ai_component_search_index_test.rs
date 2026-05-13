//! Integration tests for `core::managers::ai::component_search_index::ComponentSearchIndex`.
//! Phase B-post audit E4 — public-API async tests inline 이관.
//!
//! 보존 inline tests (`cosine_basic` / `sha1_changes_with_embed_version`) — private fn `cosine` /
//! `sha1_hash` 사용.

use std::sync::{Mutex, OnceLock};
use std::sync::Arc;

use firebat_core::managers::ai::component_search_index::{
    ComponentSearchIndex, ComponentSearchOpts,
};
use firebat_core::ports::{IEmbedderCachePort, IEmbedderPort};
use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
use firebat_infra::adapters::embedder_cache::FileEmbedderCacheAdapter;

/// FIREBAT_DATA_DIR env var 직렬화 — 한 binary 안 모든 test 가 같은 lock 사용.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn ensure_temp_data_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("FIREBAT_DATA_DIR", dir.path());
    }
    dir
}

#[tokio::test]
async fn empty_query_returns_empty() {
    let _g = env_lock();
    let dir = ensure_temp_data_dir();
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let cache_port: Arc<dyn IEmbedderCachePort> = Arc::new(FileEmbedderCacheAdapter::new(dir.path()));
    let idx = ComponentSearchIndex::new(embedder, cache_port);
    let result = idx.query("", ComponentSearchOpts::default()).await.unwrap();
    assert!(result.is_empty());
}

#[tokio::test]
async fn query_returns_top_5_default() {
    let _g = env_lock();
    let dir = ensure_temp_data_dir();
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let cache_port: Arc<dyn IEmbedderCachePort> = Arc::new(FileEmbedderCacheAdapter::new(dir.path()));
    let idx = ComponentSearchIndex::new(embedder, cache_port);
    let result = idx
        .query("주식 차트", ComponentSearchOpts::default())
        .await
        .unwrap();
    assert_eq!(result.len(), 5);
    // 점수 내림차순
    for w in result.windows(2) {
        assert!(w[0].score >= w[1].score);
    }
}

#[tokio::test]
async fn query_respects_limit() {
    let _g = env_lock();
    let dir = ensure_temp_data_dir();
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let cache_port: Arc<dyn IEmbedderCachePort> = Arc::new(FileEmbedderCacheAdapter::new(dir.path()));
    let idx = ComponentSearchIndex::new(embedder, cache_port);
    let result = idx
        .query(
            "table 표",
            ComponentSearchOpts {
                limit: Some(3),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.len(), 3);
}

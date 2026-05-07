//! Integration tests for `core::managers::ai::tool_search_index::ToolSearchIndex`.
//! Phase B-post audit E4 — public-API tests inline 이관.
//!
//! 보존 inline tests (`categorize_tool_by_name` / `categorize_tool_by_capability` /
//! `cosine_dot_product`) — private fn `categorize_tool` / `cosine` 사용.

use std::sync::{Mutex, OnceLock};
use std::sync::Arc;

use firebat_core::managers::ai::tool_search_index::{ToolSearchIndex, ToolSearchOpts, ALWAYS_INCLUDE};
use firebat_core::ports::{IEmbedderPort, ToolDefinition};
use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;

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

fn tool(name: &str, desc: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: desc.to_string(),
        input_schema: None,
    }
}

fn no_capability(_: &str) -> Option<String> {
    None
}

#[tokio::test]
async fn empty_query_returns_empty() {
    let _g = env_lock();
    let _dir = ensure_temp_data_dir();
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let idx = ToolSearchIndex::new(embedder);
    let tools = vec![tool("sysmod_kiwoom", "주식")];
    let result = idx
        .query("", &tools, ToolSearchOpts::default(), &no_capability)
        .await
        .unwrap();
    assert!(result.selected_tool_names.is_empty());
}

#[test]
fn list_categories_returns_10() {
    let cats = ToolSearchIndex::list_categories();
    assert_eq!(cats.len(), 10); // 옛 TS 의 11개 → Rust 10개 (mail-read merge 검토 후 옛 TS 와 동일 11개)
    let ids: Vec<&str> = cats.iter().map(|(id, _)| id.as_str()).collect();
    assert!(ids.contains(&"stock"));
    assert!(ids.contains(&"crypto"));
    assert!(ids.contains(&"memory"));
}

#[test]
fn always_include_constants() {
    assert!(ALWAYS_INCLUDE.contains(&"render_alert"));
    assert!(ALWAYS_INCLUDE.contains(&"render_callout"));
    assert!(ALWAYS_INCLUDE.contains(&"suggest"));
}

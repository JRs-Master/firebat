//! Integration tests for `core::managers::ai::tool_router::ToolRouter`.
//! Phase B-post audit E4 — inline tests 이관.
//!
//! 보존 inline tests (`record_turn_success_resets_cache_ids` /
//! `record_components_cache_id_ignores_negative` / `cleanup_stale_routings_works`) — private field
//! `session_last_routing` / `last_route_cache_ids` + private struct `LastRouting` 사용.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::sync::Arc;

use firebat_core::managers::ai::tool_router::ToolRouter;
use firebat_core::ports::{IEmbedderPort, IVaultPort, ToolDefinition};
use firebat_core::vault_keys::{VK_SYSTEM_AI_ASSISTANT_MODEL, VK_SYSTEM_AI_ROUTER_ENABLED};
use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

/// FIREBAT_DATA_DIR env var 변경하는 test 직렬화용 — 한 binary 안 모든 test 가 같은 lock 사용.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn make_router_with_vault() -> (ToolRouter, Arc<dyn IVaultPort>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let router = ToolRouter::new(vault.clone());
    (router, vault, dir)
}

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: String::new(),
        input_schema: None,
    }
}

#[test]
fn is_enabled_default_false() {
    let (r, _v, _dir) = make_router_with_vault();
    assert!(!r.is_enabled());
}

#[test]
fn is_enabled_true_when_vault_set() {
    let (r, vault, _dir) = make_router_with_vault();
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "true");
    assert!(r.is_enabled());
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "1");
    assert!(r.is_enabled());
}

#[test]
fn is_enabled_false_for_other_values() {
    let (r, vault, _dir) = make_router_with_vault();
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "false");
    assert!(!r.is_enabled());
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "0");
    assert!(!r.is_enabled());
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "yes"); // 옛 TS 와 같이 true/1 만 ON
    assert!(!r.is_enabled());
}

#[test]
fn assistant_model_default_gemini_flash_lite() {
    let (r, _v, _dir) = make_router_with_vault();
    assert_eq!(r.get_assistant_model(), "gemini-3.1-flash-lite-preview");
}

#[test]
fn assistant_model_override_via_vault() {
    let (r, vault, _dir) = make_router_with_vault();
    vault.set_secret(VK_SYSTEM_AI_ASSISTANT_MODEL, "gemini-3-flash-preview");
    assert_eq!(r.get_assistant_model(), "gemini-3-flash-preview");
}

#[test]
fn is_gemini_api_recognizes_prefix() {
    assert!(ToolRouter::is_gemini_api("gemini-3-pro"));
    assert!(ToolRouter::is_gemini_api("gemini-3.1-flash-preview"));
    assert!(!ToolRouter::is_gemini_api("gpt-5"));
    assert!(!ToolRouter::is_gemini_api("claude-sonnet-4-6"));
    assert!(!ToolRouter::is_gemini_api("cli-codex"));
}

#[tokio::test]
async fn select_tools_returns_all_in_backbone_mode() {
    let (r, _v, _dir) = make_router_with_vault();
    let tools = vec![tool("save_page"), tool("image_gen"), tool("render_table")];
    let result = r
        .select_tools(
            tools.clone(),
            "삼성전자 시세 알려줘",
            "gemini-3-pro",
            &HashSet::new(),
            None,
        )
        .await;
    // backbone — 모든 도구 그대로
    assert_eq!(result.tools.len(), 3);
    assert!(result.needs_previous_context.is_none());
}

#[tokio::test]
async fn select_tools_empty_query_returns_all() {
    let (r, _v, _dir) = make_router_with_vault();
    let tools = vec![tool("save_page")];
    let result = r
        .select_tools(tools, "", "gpt-5", &HashSet::new(), None)
        .await;
    assert_eq!(result.tools.len(), 1);
}

#[tokio::test]
async fn select_tools_falls_back_when_search_index_missing() {
    // ToolSearchIndex 미박음 + 토글 ON + Gemini → fallback (모든 도구 그대로)
    let (r, vault, _dir) = make_router_with_vault();
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "true");
    let tools = vec![tool("save_page"), tool("image_gen")];
    let result = r
        .select_tools(
            tools.clone(),
            "주식 차트 그려줘",
            "gemini-3-pro",
            &HashSet::new(),
            None,
        )
        .await;
    assert_eq!(result.tools.len(), 2);
}

#[tokio::test]
async fn select_tools_falls_back_when_toggle_off() {
    // search_index 박혀있어도 토글 OFF → fallback
    let _g = env_lock();
    let dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("FIREBAT_DATA_DIR", dir.path());
    }
    let (r, _vault, _vault_dir) = make_router_with_vault();
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let r = r.with_embedder(embedder);
    // 토글 미설정 → fallback (모든 도구)
    let tools = vec![tool("sysmod_kiwoom"), tool("save_page"), tool("image_gen")];
    let result = r
        .select_tools(
            tools.clone(),
            "주식 차트",
            "gemini-3-pro",
            &HashSet::new(),
            None,
        )
        .await;
    assert_eq!(result.tools.len(), 3);
}

#[tokio::test]
async fn select_tools_falls_back_for_non_gemini() {
    // 토글 ON + search_index 박힘 + GPT 모델 → fallback (Gemini API 만 활성)
    let _g = env_lock();
    let dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("FIREBAT_DATA_DIR", dir.path());
    }
    let (r, vault, _vault_dir) = make_router_with_vault();
    vault.set_secret(VK_SYSTEM_AI_ROUTER_ENABLED, "true");
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let r = r.with_embedder(embedder);
    let tools = vec![tool("save_page"), tool("image_gen")];
    let result = r
        .select_tools(
            tools.clone(),
            "이미지 만들어줘",
            "gpt-5",
            &HashSet::new(),
            None,
        )
        .await;
    // GPT — fallback (옛 TS hosted MCP 만 도구 좁히지 않음)
    assert_eq!(result.tools.len(), 2);
}

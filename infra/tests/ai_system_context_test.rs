//! SystemContextGatherer integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::ai::system_context::SystemContextGatherer;
use firebat_core::managers::mcp::McpManager;
use firebat_core::managers::module::ModuleManager;
use firebat_core::ports::{IMcpClientPort, ISandboxPort, IStoragePort, IVaultPort};
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

async fn setup() -> (SystemContextGatherer, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let sandbox: Arc<dyn ISandboxPort> =
        Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
    let mcp_client: Arc<dyn IMcpClientPort> =
        Arc::new(McpClientFileAdapter::new(dir.path().join("mcp.json")).unwrap());

    let module = Arc::new(ModuleManager::new(sandbox, storage, vault));
    let mcp = Arc::new(McpManager::new(mcp_client));
    (SystemContextGatherer::new(module, mcp), dir)
}

#[tokio::test]
async fn empty_workspace_returns_empty_string() {
    let (g, _dir) = setup().await;
    let ctx = g.gather().await;
    assert!(ctx.is_empty());
}

#[tokio::test]
async fn system_module_with_description_appears() {
    let (g, dir) = setup().await;
    // system/modules/test-mod/config.json 저장
    let mod_dir = dir.path().join("system/modules/test-mod");
    std::fs::create_dir_all(&mod_dir).unwrap();
    std::fs::write(
        mod_dir.join("config.json"),
        r#"{"name": "test-mod", "description": "테스트 모듈입니다", "capability": "web-scrape"}"#,
    )
    .unwrap();

    let ctx = g.gather().await;
    assert!(ctx.contains("sysmod_test_mod"));
    assert!(ctx.contains("테스트 모듈입니다"));
    assert!(ctx.contains("web-scrape"));
}

#[tokio::test]
async fn module_without_description_falls_back() {
    let (g, dir) = setup().await;
    let mod_dir = dir.path().join("system/modules/no-desc");
    std::fs::create_dir_all(&mod_dir).unwrap();
    std::fs::write(mod_dir.join("config.json"), r#"{"name": "no-desc"}"#).unwrap();
    let ctx = g.gather().await;
    assert!(ctx.contains("(설명 없음)"));
}

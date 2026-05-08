//! McpManager integration test — 옛 core inline tests 이관.

use std::collections::HashMap;
use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::mcp::McpManager;
use firebat_core::ports::{IMcpClientPort, McpServerConfig, McpTransport};
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;

fn make_manager() -> (McpManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    let client: Arc<dyn IMcpClientPort> = Arc::new(McpClientFileAdapter::new(path).unwrap());
    (McpManager::new(client), dir)
}

#[tokio::test]
async fn add_list_remove_via_manager() {
    let (mgr, _dir) = make_manager();
    mgr.add_server(McpServerConfig {
        name: "n1".to_string(),
        transport: McpTransport::Stdio,
        command: Some("cmd".to_string()),
        args: vec![],
        env: HashMap::new(),
        url: None,
        enabled: true,
    })
    .await
    .unwrap();

    assert_eq!(mgr.list_servers().len(), 1);
    mgr.remove_server("n1").await.unwrap();
    assert!(mgr.list_servers().is_empty());
}

#[tokio::test]
async fn list_all_tools_empty_when_no_servers() {
    let (mgr, _dir) = make_manager();
    let tools = mgr.list_all_tools().await.unwrap();
    assert!(tools.is_empty());
}

#[tokio::test]
async fn call_tool_unknown_server_errors() {
    let (mgr, _dir) = make_manager();
    let r = mgr.call_tool("missing", "x", &serde_json::json!({})).await;
    assert!(r.is_err());
    let err = r.unwrap_err();
    assert!(err.contains("미등록") || err.contains("missing"), "got: {err}");
}

#[tokio::test]
async fn list_tools_disabled_server_errors() {
    let (mgr, _dir) = make_manager();
    mgr.add_server(McpServerConfig {
        name: "off".to_string(),
        transport: McpTransport::Stdio,
        command: Some("nonexistent-cmd".to_string()),
        args: vec![],
        env: HashMap::new(),
        url: None,
        enabled: false,
    })
    .await
    .unwrap();
    let r = mgr.list_tools("off").await;
    assert!(r.is_err());
    assert!(r.unwrap_err().contains("비활성"));
}

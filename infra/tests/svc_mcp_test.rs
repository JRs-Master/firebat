//! McpService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::managers::mcp::McpManager;
use firebat_core::ports::{IMcpClientPort, McpServerConfig, McpTransport};
use firebat_core::proto::{mcp_service_server::McpService, Empty, JsonArgs};
use firebat_core::services::mcp::McpServiceImpl;
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;

fn make_service() -> (McpServiceImpl, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    let client: Arc<dyn IMcpClientPort> = Arc::new(McpClientFileAdapter::new(path).unwrap());
    let mgr = Arc::new(McpManager::new(client));
    (McpServiceImpl::new(mgr), dir)
}

#[tokio::test]
async fn add_then_list_via_grpc() {
    let (svc, _dir) = make_service();

    let cfg = serde_json::json!({
        "name": "g1",
        "transport": "stdio",
        "command": "npx",
        "args": ["server"],
        "enabled": true
    });
    let resp = svc
        .add_server(Request::new(JsonArgs {
            raw: cfg.to_string(),
        }))
        .await
        .unwrap();
    assert!(resp.into_inner().ok);

    let list = svc
        .list_servers(Request::new(Empty {}))
        .await
        .unwrap()
        .into_inner();
    let parsed: Vec<McpServerConfig> = serde_json::from_str(&list.raw).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].name, "g1");
    assert_eq!(parsed[0].transport, McpTransport::Stdio);
}

#[tokio::test]
async fn add_invalid_config_returns_error_status() {
    let (svc, _dir) = make_service();
    let resp = svc
        .add_server(Request::new(JsonArgs {
            raw: "not-json".to_string(),
        }))
        .await
        .unwrap();
    let status = resp.into_inner();
    assert!(!status.ok);
    assert!(status.error.contains("config"));
}

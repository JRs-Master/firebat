//! McpManager — 외부 MCP 서버 (Gmail / Slack / 카톡 등) 등록·연결·도구 호출 facade.
//!
//! 옛 TS `core/managers/mcp-manager.ts` Rust 재구현. IMcpClientPort 위에 설정된 thin facade —
//! Core 매니저는 인프라 직접 호출 X (BIBLE 원칙).
//!
//! Phase B-11 minimum:
//! - listServers / addServer / removeServer 활성 (JSON 파일 영속)
//! - listTools / callTool 은 어댑터 stub — Phase B-15+ 에서 rmcp crate 설정된 후 활성

use std::sync::Arc;

use crate::ports::{IMcpClientPort, InfraResult, McpServerConfig, McpToolInfo};

pub struct McpManager {
    client: Arc<dyn IMcpClientPort>,
}

impl McpManager {
    pub fn new(client: Arc<dyn IMcpClientPort>) -> Self {
        Self { client }
    }

    pub fn list_servers(&self) -> Vec<McpServerConfig> {
        self.client.list_servers()
    }

    pub async fn add_server(&self, config: McpServerConfig) -> InfraResult<()> {
        self.client.add_server(config).await
    }

    pub async fn remove_server(&self, name: &str) -> InfraResult<()> {
        self.client.remove_server(name).await
    }

    pub async fn list_tools(&self, server_name: &str) -> InfraResult<Vec<McpToolInfo>> {
        self.client.list_tools(server_name).await
    }

    pub async fn list_all_tools(&self) -> InfraResult<Vec<McpToolInfo>> {
        self.client.list_all_tools().await
    }

    pub async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        self.client.call_tool(server_name, tool_name, args).await
    }

    pub async fn disconnect_all(&self) {
        self.client.disconnect_all().await
    }
}

// Tests 이관 — `infra/tests/mcp_manager_test.rs` (integration test).

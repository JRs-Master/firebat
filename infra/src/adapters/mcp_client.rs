//! McpClientFileAdapter — IMcpClientPort 의 Phase B-11 minimum 구현.
//!
//! Phase B-11 minimum:
//! - 서버 설정 영속 (`data/mcp-servers.json`) — listServers / addServer / removeServer
//! - listTools / callTool 은 stub — Phase B-15+ 에서 `rmcp` crate (stdio + sse) 박힌 후 활성
//!
//! 옛 TS `infra/mcp-client/index.ts` 의 동등 기능. Rust 전환 후엔 rmcp 가 표준 client.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use firebat_core::ports::{IMcpClientPort, InfraResult, McpServerConfig, McpToolInfo};

pub struct McpClientFileAdapter {
    config_path: PathBuf,
    servers: Mutex<HashMap<String, McpServerConfig>>,
}

impl McpClientFileAdapter {
    pub fn new(config_path: PathBuf) -> InfraResult<Self> {
        let servers = if config_path.exists() {
            let raw = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("MCP servers 파일 read 실패: {e}"))?;
            // 빈 파일 또는 invalid JSON 일 때 silent skip — 옛 TS 패턴.
            serde_json::from_str::<Vec<McpServerConfig>>(&raw)
                .unwrap_or_default()
                .into_iter()
                .map(|c| (c.name.clone(), c))
                .collect()
        } else {
            HashMap::new()
        };
        Ok(Self {
            config_path,
            servers: Mutex::new(servers),
        })
    }

    fn flush(&self, servers: &HashMap<String, McpServerConfig>) -> InfraResult<()> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("MCP servers 디렉토리 생성 실패: {e}"))?;
        }
        let list: Vec<&McpServerConfig> = servers.values().collect();
        let raw = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("MCP servers 직렬화 실패: {e}"))?;
        std::fs::write(&self.config_path, raw)
            .map_err(|e| format!("MCP servers 파일 write 실패: {e}"))?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl IMcpClientPort for McpClientFileAdapter {
    fn list_servers(&self) -> Vec<McpServerConfig> {
        let guard = self.servers.lock().unwrap();
        let mut list: Vec<McpServerConfig> = guard.values().cloned().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        list
    }

    async fn add_server(&self, config: McpServerConfig) -> InfraResult<()> {
        if config.name.trim().is_empty() {
            return Err("MCP 서버 name 누락".to_string());
        }
        let mut guard = self.servers.lock().unwrap();
        guard.insert(config.name.clone(), config);
        self.flush(&guard)
    }

    async fn remove_server(&self, name: &str) -> InfraResult<()> {
        let mut guard = self.servers.lock().unwrap();
        if guard.remove(name).is_none() {
            return Err(format!("MCP 서버 {} 미등록", name));
        }
        self.flush(&guard)
    }

    async fn list_tools(&self, _server_name: &str) -> InfraResult<Vec<McpToolInfo>> {
        // Phase B-15+ — rmcp crate 박힌 후 활성. 현재는 빈 배열 반환 (Throw 안 함, BIBLE 원칙).
        Ok(Vec::new())
    }

    async fn list_all_tools(&self) -> InfraResult<Vec<McpToolInfo>> {
        Ok(Vec::new())
    }

    async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        _args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        Err(format!(
            "MCP callTool — Phase B-15+ 후속 (rmcp 미박음). server={server_name} tool={tool_name}"
        ))
    }

    async fn disconnect_all(&self) {
        // Phase B-15+ — 자식 process kill / sse close. 현재는 no-op.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use firebat_core::ports::McpTransport;
    use tempfile::tempdir;

    fn make_adapter() -> (McpClientFileAdapter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp-servers.json");
        let adapter = McpClientFileAdapter::new(path).unwrap();
        (adapter, dir)
    }

    #[tokio::test]
    async fn add_list_remove_roundtrip() {
        let (adapter, _dir) = make_adapter();

        adapter
            .add_server(McpServerConfig {
                name: "gmail".to_string(),
                transport: McpTransport::Stdio,
                command: Some("npx".to_string()),
                args: vec!["@modelcontextprotocol/server-gmail".to_string()],
                env: HashMap::new(),
                url: None,
                enabled: true,
            })
            .await
            .unwrap();

        let list = adapter.list_servers();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "gmail");
        assert_eq!(list[0].transport, McpTransport::Stdio);

        adapter.remove_server("gmail").await.unwrap();
        assert!(adapter.list_servers().is_empty());
    }

    #[tokio::test]
    async fn add_persists_to_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp.json");

        {
            let adapter = McpClientFileAdapter::new(path.clone()).unwrap();
            adapter
                .add_server(McpServerConfig {
                    name: "slack".to_string(),
                    transport: McpTransport::Sse,
                    command: None,
                    args: vec![],
                    env: HashMap::new(),
                    url: Some("https://example.com/mcp".to_string()),
                    enabled: true,
                })
                .await
                .unwrap();
        }

        // 새 어댑터 인스턴스로 재로드 — 영속 검증.
        let adapter = McpClientFileAdapter::new(path).unwrap();
        let list = adapter.list_servers();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].url.as_deref(), Some("https://example.com/mcp"));
    }

    #[tokio::test]
    async fn remove_unknown_returns_error() {
        let (adapter, _dir) = make_adapter();
        let result = adapter.remove_server("none").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn list_tools_returns_empty_during_phase_b11() {
        let (adapter, _dir) = make_adapter();
        let tools = adapter.list_tools("any").await.unwrap();
        assert!(tools.is_empty());
    }

    #[tokio::test]
    async fn call_tool_returns_phase_error() {
        let (adapter, _dir) = make_adapter();
        let result = adapter
            .call_tool("any", "tool", &serde_json::json!({}))
            .await;
        assert!(result.is_err());
    }
}

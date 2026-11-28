//! McpManager — 외부 MCP 서버 (Gmail / Slack / 카톡 등) 등록·연결·도구 호출 facade.
//!
//! 옛 TS `core/managers/mcp-manager.ts` Rust 재구현. IMcpClientPort 위에 설정된 thin facade —
//! Core 매니저는 인프라 직접 호출 X (BIBLE 원칙).
//!
//! A remote server that wants a login gets a token: the manager keeps it in the vault and the
//! server config names only the vault key (`token_secret`), so the token is never listed to the
//! settings screen nor written to `mcp-servers.json`. The adapter reads it when it connects.

use std::sync::Arc;

use crate::ports::{
    IMcpClientPort, IVaultPort, InfraResult, McpServerConfig, McpToolInfo, McpTransport,
};

pub struct McpManager {
    client: Arc<dyn IMcpClientPort>,
    vault: Option<Arc<dyn IVaultPort>>,
}

impl McpManager {
    pub fn new(client: Arc<dyn IMcpClientPort>) -> Self {
        Self { client, vault: None }
    }

    /// Where server tokens are kept. Without it a token is refused, never written elsewhere.
    pub fn with_vault(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.vault = Some(vault);
        self
    }

    /// The vault key a server's token lives under (declared in proto/vault-keys.json).
    pub fn token_key(server_name: &str) -> String {
        crate::vault_keys::vk_mcp_server_token(server_name)
    }

    pub fn list_servers(&self) -> Vec<McpServerConfig> {
        self.client.list_servers()
    }

    /// Register or replace a server. `token` (remote servers only) is kept in the vault; with no
    /// token, a server registered again keeps the token it already had — changing its address
    /// must not log it out. A stdio server takes its secrets through `env`, so it holds no token.
    pub async fn add_server(
        &self,
        mut config: McpServerConfig,
        token: Option<String>,
    ) -> InfraResult<()> {
        let key = Self::token_key(&config.name);
        let token = token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        let had_token = self
            .client
            .list_servers()
            .into_iter()
            .any(|c| c.name == config.name && c.token_secret.is_some());
        if config.transport == McpTransport::Stdio {
            if token.is_some() {
                return Err(format!(
                    "MCP {}: a token is sent to a remote server (sse · http) — a stdio server takes its secrets through env",
                    config.name
                ));
            }
            config.token_secret = None;
            self.client.add_server(config).await?;
            if had_token {
                self.forget_token(&key);
            }
            return Ok(());
        }
        config.token_secret = match token {
            Some(t) => {
                let vault = self
                    .vault
                    .as_ref()
                    .ok_or_else(|| format!("MCP {}: no vault to keep the token in", config.name))?;
                if !vault.set_secret(&key, &t) {
                    return Err(format!("MCP {}: the vault refused the token", config.name));
                }
                Some(key)
            }
            None if had_token => Some(key),
            None => None,
        };
        self.client.add_server(config).await
    }

    pub async fn remove_server(&self, name: &str) -> InfraResult<()> {
        let had_token = self
            .client
            .list_servers()
            .into_iter()
            .any(|c| c.name == name && c.token_secret.is_some());
        self.client.remove_server(name).await?;
        if had_token {
            self.forget_token(&Self::token_key(name));
        }
        Ok(())
    }

    fn forget_token(&self, key: &str) {
        if let Some(vault) = &self.vault {
            vault.delete_secret(key);
        }
    }

    pub async fn list_tools(&self, server_name: &str) -> InfraResult<Vec<McpToolInfo>> {
        self.client.list_tools(server_name).await
    }

    pub async fn list_all_tools(&self) -> InfraResult<Vec<McpToolInfo>> {
        self.client.list_all_tools().await
    }

    /// The servers as a model needs them: each one's name and how it is reached, and an enabled one's tools as it publishes them
    /// (name · description · inputSchema) — what `mcp_call` takes. Listing the servers alone left the model guessing tool names
    /// (2026-11-28: seven guesses at 맑곰, every one "not found", while its nine tools stood ready). A server that cannot be
    /// reached says why in place of its tools. The config's `env` is not listed: a stdio server's secrets live there.
    pub async fn servers_with_tools(&self) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        for cfg in self.client.list_servers() {
            let mut entry = serde_json::json!({
                "name": cfg.name,
                "transport": cfg.transport,
                "enabled": cfg.enabled,
            });
            if let Some(url) = &cfg.url {
                entry["url"] = serde_json::json!(url);
            }
            if let Some(command) = &cfg.command {
                entry["command"] = serde_json::json!(command);
            }
            if cfg.enabled {
                match self.client.list_tools(&cfg.name).await {
                    Ok(tools) => {
                        entry["tools"] = serde_json::Value::Array(
                            tools
                                .into_iter()
                                .map(|t| serde_json::json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema }))
                                .collect(),
                        );
                    }
                    Err(e) => entry["error"] = serde_json::json!(e),
                }
            }
            out.push(entry);
        }
        out
    }

    /// A tool of an outside server. Called by a name the server does not have, the answer names the ones it does — the next
    /// call can be the right one instead of another guess.
    pub async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        match self.client.call_tool(server_name, tool_name, args).await {
            Ok(value) => Ok(value),
            Err(e) => {
                if let Ok(tools) = self.client.list_tools(server_name).await {
                    if !tools.iter().any(|t| t.name == tool_name) {
                        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
                        return Err(format!(
                            "MCP {server_name} has no tool `{tool_name}` — its tools: {}. list_mcp_servers gives each one's description and arguments.",
                            names.join(", ")
                        ));
                    }
                }
                Err(e)
            }
        }
    }

    pub async fn disconnect_all(&self) {
        self.client.disconnect_all().await
    }
}

// Tests 이관 — `infra/tests/mcp_manager_test.rs` (integration test).

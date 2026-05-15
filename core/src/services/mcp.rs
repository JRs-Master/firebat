//! gRPC McpService impl — McpManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.
//!
//! 2026-05-15 unique RPC message — Empty/StringRequest/RawJsonPb shared 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::mcp::McpManager;
use crate::ports::McpToolInfo;
use crate::proto::{
    mcp_service_server::McpService, McpAddServerRequest, McpAddServerResponse,
    McpCallToolRequest, McpCallToolResponse, McpListAllToolsRequest, McpListServersRequest,
    McpListServersResponse, McpListToolsRequest, McpRemoveServerRequest, McpRemoveServerResponse,
    McpListAllToolsResponse, McpListToolsResponse, McpToolInfoPb,
};

pub struct McpServiceImpl {
    manager: Arc<McpManager>,
}

impl McpServiceImpl {
    pub fn new(manager: Arc<McpManager>) -> Self {
        Self { manager }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

// ─── proto ↔ core port struct 변환 ─────────────────────────────────────────

impl From<McpToolInfo> for McpToolInfoPb {
    fn from(t: McpToolInfo) -> Self {
        McpToolInfoPb {
            server: t.server,
            name: t.name,
            description: t.description,
            input_schema_json: t
                .input_schema
                .as_ref()
                .and_then(|s| serde_json::to_string(s).ok()),
        }
    }
}

#[tonic::async_trait]
impl McpService for McpServiceImpl {
    async fn list_servers(
        &self,
        _req: Request<McpListServersRequest>,
    ) -> Result<Response<McpListServersResponse>, TonicStatus> {
        Ok(Response::new(McpListServersResponse {
            raw_json: to_raw_json(&self.manager.list_servers()),
        }))
    }

    async fn add_server(
        &self,
        req: Request<McpAddServerRequest>,
    ) -> Result<Response<McpAddServerResponse>, TonicStatus> {
        let args = req.into_inner();
        let transport = match args.transport.as_str() {
            "stdio" => crate::ports::McpTransport::Stdio,
            "sse" => crate::ports::McpTransport::Sse,
            other => {
                return Err(TonicStatus::invalid_argument(format!(
                    "unknown transport: {other}"
                )));
            }
        };
        let env: std::collections::HashMap<String, String> = if args.env_json.is_empty() {
            std::collections::HashMap::new()
        } else {
            serde_json::from_str(&args.env_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("env_json: {e}")))?
        };
        let config = crate::ports::McpServerConfig {
            name: args.name,
            transport,
            command: args.command,
            args: args.args,
            env,
            url: args.url,
            enabled: args.enabled,
        };
        self.manager
            .add_server(config)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(McpAddServerResponse {}))
    }

    async fn remove_server(
        &self,
        req: Request<McpRemoveServerRequest>,
    ) -> Result<Response<McpRemoveServerResponse>, TonicStatus> {
        let name = req.into_inner().name;
        self.manager
            .remove_server(&name)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(McpRemoveServerResponse {}))
    }

    async fn list_tools(
        &self,
        req: Request<McpListToolsRequest>,
    ) -> Result<Response<McpListToolsResponse>, TonicStatus> {
        let server_name = req.into_inner().server;
        match self.manager.list_tools(&server_name).await {
            Ok(tools) => {
                let pb_tools = tools.into_iter().map(Into::into).collect();
                Ok(Response::new(McpListToolsResponse { tools: pb_tools }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_all_tools(
        &self,
        _req: Request<McpListAllToolsRequest>,
    ) -> Result<Response<McpListAllToolsResponse>, TonicStatus> {
        match self.manager.list_all_tools().await {
            Ok(tools) => {
                let pb_tools = tools.into_iter().map(Into::into).collect();
                Ok(Response::new(McpListAllToolsResponse { tools: pb_tools }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn call_tool(
        &self,
        req: Request<McpCallToolRequest>,
    ) -> Result<Response<McpCallToolResponse>, TonicStatus> {
        let args = req.into_inner();
        let arguments: serde_json::Value = if args.arguments_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args.arguments_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("arguments_json: {e}")))?
        };
        match self
            .manager
            .call_tool(&args.server, &args.tool, &arguments)
            .await
        {
            Ok(value) => Ok(Response::new(McpCallToolResponse {
                raw_json: to_raw_json(&value),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_mcp_test.rs` (integration test).

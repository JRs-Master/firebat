//! gRPC McpService impl — McpManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::mcp::McpManager;
use crate::ports::McpToolInfo;
use crate::proto::{
    mcp_service_server::McpService, Empty, McpAddServerRequest, McpCallToolRequest, McpToolInfoPb, McpToolListPb, RawJsonPb,
    StringRequest,
};

pub struct McpServiceImpl {
    manager: Arc<McpManager>,
}

impl McpServiceImpl {
    pub fn new(manager: Arc<McpManager>) -> Self {
        Self { manager }
    }
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
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
        _req: Request<Empty>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        Ok(Response::new(raw_json(&self.manager.list_servers())))
    }

    async fn add_server(&self, req: Request<McpAddServerRequest>) -> Result<Response<Empty>, TonicStatus> {
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
        Ok(Response::new(Empty {}))
    }

    async fn remove_server(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let name = req.into_inner().value;
        self.manager
            .remove_server(&name)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn list_tools(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<McpToolListPb>, TonicStatus> {
        let server_name = req.into_inner().value;
        match self.manager.list_tools(&server_name).await {
            Ok(tools) => {
                let pb_tools = tools.into_iter().map(Into::into).collect();
                Ok(Response::new(McpToolListPb { tools: pb_tools }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_all_tools(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<McpToolListPb>, TonicStatus> {
        match self.manager.list_all_tools().await {
            Ok(tools) => {
                let pb_tools = tools.into_iter().map(Into::into).collect();
                Ok(Response::new(McpToolListPb { tools: pb_tools }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn call_tool(
        &self,
        req: Request<McpCallToolRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
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
            Ok(value) => Ok(Response::new(raw_json(&value))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_mcp_test.rs` (integration test).

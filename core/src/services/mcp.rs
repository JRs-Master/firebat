//! gRPC McpService impl — McpManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::mcp::McpManager;
use crate::ports::McpToolInfo;
use crate::proto::{
    mcp_service_server::McpService, Empty, JsonArgs, McpToolInfoPb, McpToolListPb, RawJsonPb,
    Status, StringRequest,
};

pub struct McpServiceImpl {
    manager: Arc<McpManager>,
}

impl McpServiceImpl {
    pub fn new(manager: Arc<McpManager>) -> Self {
        Self { manager }
    }
}

fn ok_status() -> Response<Status> {
    Response::new(Status {
        ok: true,
        error: String::new(),
        error_code: String::new(),
    })
}

fn err_status(msg: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: String::new(),
    })
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

    async fn add_server(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        let config: crate::ports::McpServerConfig = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("add_server config: {e}"))),
        };
        match self.manager.add_server(config).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn remove_server(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let name = req.into_inner().value;
        match self.manager.remove_server(&name).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
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
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            server: String,
            tool: String,
            #[serde(default)]
            args: serde_json::Value,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("call_tool args: {e}")))?;
        match self
            .manager
            .call_tool(&args.server, &args.tool, &args.args)
            .await
        {
            Ok(value) => Ok(Response::new(raw_json(&value))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_mcp_test.rs` (integration test).

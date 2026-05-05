//! gRPC McpService impl — McpManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::mcp::McpManager;
use crate::proto::{
    mcp_service_server::McpService, Empty, JsonArgs, JsonValue, Status, StringRequest,
};

pub struct McpServiceImpl {
    manager: Arc<McpManager>,
}

impl McpServiceImpl {
    pub fn new(manager: Arc<McpManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
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

#[tonic::async_trait]
impl McpService for McpServiceImpl {
    async fn list_servers(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&self.manager.list_servers())
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
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let server_name = req.into_inner().value;
        match self.manager.list_tools(&server_name).await {
            Ok(tools) => json_response(&tools),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_all_tools(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        match self.manager.list_all_tools().await {
            Ok(tools) => json_response(&tools),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn call_tool(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
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
            Ok(value) => json_response(&value),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
    use crate::ports::{IMcpClientPort, McpTransport};
    use tempfile::tempdir;

    fn make_service() -> (McpServiceImpl, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let client: Arc<dyn IMcpClientPort> =
            Arc::new(McpClientFileAdapter::new(path).unwrap());
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
        let parsed: Vec<crate::ports::McpServerConfig> =
            serde_json::from_str(&list.raw).unwrap();
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
}

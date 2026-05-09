//! gRPC ToolService impl — ToolManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! ToolDefinition.parameters 가 opaque JSON schema 이므로 list/definition 계열은 RawJsonPb.
//! GetStats 만 ToolStatsPb 으로 typed.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::tool::{ToolDefinition, ToolListFilter, ToolManager};
use crate::proto::{
    tool_service_server::ToolService, BoolRequest, Empty, JsonArgs, RawJsonPb, Status,
    StringRequest, ToolStatsPb,
};

pub struct ToolServiceImpl {
    manager: Arc<ToolManager>,
}

impl ToolServiceImpl {
    pub fn new(manager: Arc<ToolManager>) -> Self {
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

#[tonic::async_trait]
impl ToolService for ToolServiceImpl {
    async fn register(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        let def: ToolDefinition = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("register args: {e}"))),
        };
        self.manager.register(def);
        Ok(ok_status())
    }

    async fn register_many(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        let defs: Vec<ToolDefinition> = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("register_many args: {e}"))),
        };
        self.manager.register_many(defs);
        Ok(ok_status())
    }

    async fn unregister(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let name = req.into_inner().value;
        Ok(Response::new(BoolRequest {
            value: self.manager.unregister(&name),
        }))
    }

    async fn get_definition(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let name = req.into_inner().value;
        let def = self.manager.get_definition(&name);
        Ok(Response::new(raw_json(&def)))
    }

    async fn list(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        let filter: ToolListFilter = serde_json::from_str(&raw).unwrap_or_default();
        let tools = self.manager.list(&filter);
        Ok(Response::new(raw_json(&tools)))
    }

    async fn execute(
        &self,
        _req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        // Phase B: 도구 dispatch 는 AiManager 변환 시 통합.
        Ok(Response::new(RawJsonPb {
            raw_json: serde_json::json!({
                "ok": false,
                "error": "tool execute — Phase B AiManager 변환 시 통합"
            })
            .to_string(),
        }))
    }

    async fn build_ai_definitions(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        let filter: ToolListFilter = serde_json::from_str(&raw).unwrap_or_default();
        let tools = self.manager.list(&filter);
        Ok(Response::new(raw_json(&tools)))
    }

    async fn build_mcp_descriptions(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        let filter: ToolListFilter = serde_json::from_str(&raw).unwrap_or_default();
        let tools = self.manager.list(&filter);
        Ok(Response::new(raw_json(&tools)))
    }

    async fn get_stats(&self, _req: Request<Empty>) -> Result<Response<ToolStatsPb>, TonicStatus> {
        let stats = self.manager.stats();
        let by_source_json =
            serde_json::to_string(&stats.by_source).unwrap_or_else(|_| "{}".to_string());
        Ok(Response::new(ToolStatsPb {
            total: stats.total as i64,
            by_source_json,
        }))
    }

    async fn get_active_plan_state(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let conv_id = req.into_inner().value;
        let state = self.manager.get_active_plan(&conv_id);
        Ok(Response::new(raw_json(&state)))
    }

    async fn set_active_plan_state(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct SetArgs {
            conversation_id: String,
            #[serde(default)]
            state: Option<serde_json::Value>,
        }
        let args: SetArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_active_plan args: {e}"))),
        };
        self.manager.set_active_plan(&args.conversation_id, args.state);
        Ok(ok_status())
    }

    async fn clear_active_plan_state(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let conv_id = req.into_inner().value;
        self.manager.clear_active_plan(&conv_id);
        Ok(ok_status())
    }
}

// Tests 이관 — `infra/tests/svc_tool_test.rs` (integration test).

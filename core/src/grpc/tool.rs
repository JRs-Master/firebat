//! gRPC ToolService impl — ToolManager wrapping.
//!
//! 매 RPC unique Request / Response — buf STANDARD 정공.
//! 옛 공유 타입 (StringRequest / BoolRequest / Empty / RawJsonPb / ToolStatsPb) 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::tool::{ToolDefinition, ToolListFilter, ToolManager};
use crate::proto::{
    tool_service_server::ToolService, ToolBuildAiDefinitionsRequest,
    ToolBuildAiDefinitionsResponse, ToolBuildMcpDescriptionsRequest,
    ToolBuildMcpDescriptionsResponse, ToolClearActivePlanStateRequest,
    ToolClearActivePlanStateResponse, ToolExecuteRequest, ToolExecuteResponse,
    ToolGetActivePlanStateRequest, ToolGetActivePlanStateResponse, ToolGetDefinitionRequest,
    ToolGetDefinitionResponse, ToolGetStatsRequest, ToolGetStatsResponse, ToolListRequest,
    ToolListResponse, ToolRegisterManyRequest, ToolRegisterManyResponse, ToolRegisterRequest,
    ToolRegisterResponse, ToolSetActivePlanStateRequest, ToolSetActivePlanStateResponse,
    ToolUnregisterRequest, ToolUnregisterResponse,
};

pub struct ToolServiceImpl {
    manager: Arc<ToolManager>,
}

impl ToolServiceImpl {
    pub fn new(manager: Arc<ToolManager>) -> Self {
        Self { manager }
    }
}

fn to_raw(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl ToolService for ToolServiceImpl {
    async fn register(
        &self,
        req: Request<ToolRegisterRequest>,
    ) -> Result<Response<ToolRegisterResponse>, TonicStatus> {
        let args = req.into_inner();
        let def: ToolDefinition = serde_json::from_str(&args.definition_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("register definition_json: {e}")))?;
        self.manager.register(def);
        Ok(Response::new(ToolRegisterResponse {}))
    }

    async fn register_many(
        &self,
        req: Request<ToolRegisterManyRequest>,
    ) -> Result<Response<ToolRegisterManyResponse>, TonicStatus> {
        let args = req.into_inner();
        let defs: Vec<ToolDefinition> = serde_json::from_str(&args.definitions_json)
            .map_err(|e| {
                TonicStatus::invalid_argument(format!("register_many definitions_json: {e}"))
            })?;
        self.manager.register_many(defs);
        Ok(Response::new(ToolRegisterManyResponse {}))
    }

    async fn unregister(
        &self,
        req: Request<ToolUnregisterRequest>,
    ) -> Result<Response<ToolUnregisterResponse>, TonicStatus> {
        let name = req.into_inner().name;
        Ok(Response::new(ToolUnregisterResponse {
            removed: self.manager.unregister(&name),
        }))
    }

    async fn get_definition(
        &self,
        req: Request<ToolGetDefinitionRequest>,
    ) -> Result<Response<ToolGetDefinitionResponse>, TonicStatus> {
        let name = req.into_inner().name;
        let def = self.manager.get_definition(&name);
        Ok(Response::new(ToolGetDefinitionResponse {
            raw_json: to_raw(&def),
        }))
    }

    async fn list(
        &self,
        req: Request<ToolListRequest>,
    ) -> Result<Response<ToolListResponse>, TonicStatus> {
        let args = req.into_inner();
        let filter = ToolListFilter {
            source: args.source_filter,
            ..Default::default()
        };
        let tools = self.manager.list(&filter);
        Ok(Response::new(ToolListResponse {
            raw_json: to_raw(&tools),
        }))
    }

    async fn execute(
        &self,
        _req: Request<ToolExecuteRequest>,
    ) -> Result<Response<ToolExecuteResponse>, TonicStatus> {
        // Phase B: 도구 dispatch 는 AiManager 변환 시 통합.
        Ok(Response::new(ToolExecuteResponse {
            raw_json: serde_json::json!({
                "ok": false,
                "error": "tool execute — Phase B AiManager 변환 시 통합"
            })
            .to_string(),
        }))
    }

    async fn build_ai_definitions(
        &self,
        req: Request<ToolBuildAiDefinitionsRequest>,
    ) -> Result<Response<ToolBuildAiDefinitionsResponse>, TonicStatus> {
        let args = req.into_inner();
        let filter = ToolListFilter {
            source: args.source_filter,
            ..Default::default()
        };
        let tools = self.manager.list(&filter);
        Ok(Response::new(ToolBuildAiDefinitionsResponse {
            raw_json: to_raw(&tools),
        }))
    }

    async fn build_mcp_descriptions(
        &self,
        req: Request<ToolBuildMcpDescriptionsRequest>,
    ) -> Result<Response<ToolBuildMcpDescriptionsResponse>, TonicStatus> {
        let args = req.into_inner();
        let filter = ToolListFilter {
            source: args.source_filter,
            ..Default::default()
        };
        let tools = self.manager.list(&filter);
        Ok(Response::new(ToolBuildMcpDescriptionsResponse {
            raw_json: to_raw(&tools),
        }))
    }

    async fn get_stats(
        &self,
        _req: Request<ToolGetStatsRequest>,
    ) -> Result<Response<ToolGetStatsResponse>, TonicStatus> {
        let stats = self.manager.stats();
        let by_source_json =
            serde_json::to_string(&stats.by_source).unwrap_or_else(|_| "{}".to_string());
        Ok(Response::new(ToolGetStatsResponse {
            total: stats.total as i64,
            by_source_json,
        }))
    }

    async fn get_active_plan_state(
        &self,
        req: Request<ToolGetActivePlanStateRequest>,
    ) -> Result<Response<ToolGetActivePlanStateResponse>, TonicStatus> {
        let conv_id = req.into_inner().conversation_id;
        let state = self.manager.get_active_plan(&conv_id);
        Ok(Response::new(ToolGetActivePlanStateResponse {
            raw_json: to_raw(&state),
        }))
    }

    async fn set_active_plan_state(
        &self,
        req: Request<ToolSetActivePlanStateRequest>,
    ) -> Result<Response<ToolSetActivePlanStateResponse>, TonicStatus> {
        let args = req.into_inner();
        let state = if args.state_json.is_empty() {
            None
        } else {
            serde_json::from_str(&args.state_json).ok()
        };
        self.manager.set_active_plan(&args.conversation_id, state);
        Ok(Response::new(ToolSetActivePlanStateResponse {}))
    }

    async fn clear_active_plan_state(
        &self,
        req: Request<ToolClearActivePlanStateRequest>,
    ) -> Result<Response<ToolClearActivePlanStateResponse>, TonicStatus> {
        let conv_id = req.into_inner().conversation_id;
        self.manager.clear_active_plan(&conv_id);
        Ok(Response::new(ToolClearActivePlanStateResponse {}))
    }
}

// Tests 이관 — `infra/tests/svc_tool_test.rs` (integration test).

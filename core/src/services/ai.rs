//! gRPC AiService impl — AiManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! Process / CodeAssist → AiTextResultPb (단순 텍스트 반환).
//! RequestActionWithTools / RunAgentJob / SpawnSubAgent / ResolveCallTarget → RawJsonPb (복잡 응답).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::AiManager;
use crate::ports::{LlmCallOpts, ToolDefinition};
use crate::proto::{
    ai_service_server::AiService, AiCodeAssistRequest, AiCreatePendingRequest, AiProcessRequest,
    AiRequestActionWithToolsRequest, AiRunAgentJobRequest, AiSpawnSubAgentRequest,
    AiStorePlanRequest, AiTextResultPb, BoolRequest, Empty, RawJsonPb, Status, StringRequest,
};

pub struct AiServiceImpl {
    manager: Arc<AiManager>,
}

impl AiServiceImpl {
    pub fn new(manager: Arc<AiManager>) -> Self {
        Self { manager }
    }
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

/// LlmCallOptsPb (string opts_json) → LlmCallOpts struct. None / empty 면 default.
fn parse_opts(opts: Option<crate::proto::LlmCallOptsPb>) -> LlmCallOpts {
    opts.and_then(|o| {
        if o.opts_json.is_empty() {
            None
        } else {
            serde_json::from_str(&o.opts_json).ok()
        }
    })
    .unwrap_or_default()
}

/// ToolDefinitionsPb (string tools_json) → Vec<ToolDefinition>. None / empty 면 빈 배열.
fn parse_tools(tools: Option<crate::proto::ToolDefinitionsPb>) -> Vec<ToolDefinition> {
    tools
        .and_then(|t| {
            if t.tools_json.is_empty() {
                None
            } else {
                serde_json::from_str(&t.tools_json).ok()
            }
        })
        .unwrap_or_default()
}

#[tonic::async_trait]
impl AiService for AiServiceImpl {
    async fn process(
        &self,
        req: Request<AiProcessRequest>,
    ) -> Result<Response<AiTextResultPb>, TonicStatus> {
        let args = req.into_inner();
        let opts = parse_opts(args.opts);
        match self.manager.ask_text(&args.prompt, &opts).await {
            Ok(text) => Ok(Response::new(AiTextResultPb { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn request_action_with_tools(
        &self,
        req: Request<AiRequestActionWithToolsRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let opts = parse_opts(args.opts);
        let tools = parse_tools(args.tools);
        match self
            .manager
            .process_with_tools(&args.prompt, &tools, &opts)
            .await
        {
            Ok(response) => Ok(Response::new(raw_json(&response))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn code_assist(
        &self,
        req: Request<AiCodeAssistRequest>,
    ) -> Result<Response<AiTextResultPb>, TonicStatus> {
        let args = req.into_inner();
        let opts = parse_opts(args.opts);
        match self.manager.ask_text(&args.prompt, &opts).await {
            Ok(text) => Ok(Response::new(AiTextResultPb { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn run_agent_job(
        &self,
        req: Request<AiRunAgentJobRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        if args.agent_prompt.trim().is_empty() {
            return Ok(Response::new(raw_json(&serde_json::json!({
                "success": false,
                "error": "agentPrompt 가 비어있습니다."
            }))));
        }
        let llm_opts = LlmCallOpts {
            model: args.model.clone(),
            ..Default::default()
        };
        let ai_opts = crate::ports::AiRequestOpts {
            owner: Some("admin".to_string()),
            cron_agent: Some(crate::ports::CronAgentOpts {
                job_id: args.job_id.clone(),
                title: args.title,
            }),
            model: args.model,
            ..Default::default()
        };
        match self
            .manager
            .process_with_tools_opts(&args.agent_prompt, &[], &llm_opts, &ai_opts)
            .await
        {
            Ok(res) => Ok(Response::new(raw_json(&serde_json::json!({
                "success": res.error.is_none(),
                "reply": res.reply,
                "executedActions": res.executed_actions,
                "blocks": res.blocks,
                "error": res.error,
            })))),
            Err(e) => Ok(Response::new(raw_json(&serde_json::json!({
                "success": false,
                "error": e,
            })))),
        }
    }

    async fn resolve_call_target(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let identifier = req.into_inner().value;
        Ok(Response::new(raw_json(&serde_json::json!({
            "identifier": identifier,
            "kind": serde_json::Value::Null,
            "note": "ToolDispatcher 풀 wiring 후 활성 — AiManager.resolve_call_target API 노출 필요"
        }))))
    }

    async fn spawn_sub_agent(
        &self,
        req: Request<AiSpawnSubAgentRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let llm_opts = LlmCallOpts {
            model: args.model,
            ..Default::default()
        };
        match self
            .manager
            .process_with_tools(&args.prompt, &[], &llm_opts)
            .await
        {
            Ok(res) => Ok(Response::new(raw_json(&res))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn is_sub_agent_enabled(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        Ok(Response::new(BoolRequest { value: false }))
    }

    async fn set_sub_agent_enabled(
        &self,
        _req: Request<BoolRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        Ok(Response::new(Status {
            ok: true,
            error: String::new(),
            error_code: String::new(),
        }))
    }

    // ── Pending tools (옛 TS lib/pending-tools.ts 통합) ────────────────────
    async fn create_pending(
        &self,
        req: Request<AiCreatePendingRequest>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        let args = req.into_inner();
        let parsed_args: serde_json::Value = if args.args_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args.args_json).unwrap_or(serde_json::Value::Null)
        };
        let plan_id = crate::utils::pending_tools::create_pending(&args.name, parsed_args, &args.summary);
        Ok(Response::new(StringRequest { value: plan_id }))
    }

    async fn get_pending(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let plan_id = req.into_inner().value;
        let result = crate::utils::pending_tools::get_pending(&plan_id);
        Ok(Response::new(raw_json(&result)))
    }

    async fn consume_pending(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let plan_id = req.into_inner().value;
        let result = crate::utils::pending_tools::consume_pending(&plan_id);
        Ok(Response::new(raw_json(&result)))
    }

    async fn reject_pending(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let plan_id = req.into_inner().value;
        let had = crate::utils::pending_tools::reject_pending(&plan_id);
        Ok(Response::new(BoolRequest { value: had }))
    }

    // ── Plan store (옛 TS lib/plan-store.ts 통합) ──────────────────────────
    async fn store_plan(
        &self,
        req: Request<AiStorePlanRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        let steps: Vec<crate::utils::plan_store::PlanStep> = args
            .steps
            .into_iter()
            .filter_map(|s| {
                if s.step_json.is_empty() {
                    None
                } else {
                    serde_json::from_str(&s.step_json).ok()
                }
            })
            .collect();
        let risks = if args.risks.is_empty() {
            None
        } else {
            Some(args.risks)
        };
        crate::utils::plan_store::store_plan(crate::utils::plan_store::PlanInsert {
            plan_id: args.plan_id,
            title: args.title,
            steps,
            estimated_time: args.estimated_time,
            risks,
        });
        Ok(Response::new(Empty {}))
    }
}

// Tests 이관 — `infra/tests/svc_ai_test.rs` (integration test).

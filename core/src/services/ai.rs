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
    ai_service_server::AiService, AiTextResultPb, BoolRequest, Empty, JsonArgs, RawJsonPb, Status,
    StringRequest,
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

#[tonic::async_trait]
impl AiService for AiServiceImpl {
    async fn process(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<AiTextResultPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            prompt: String,
            #[serde(default)]
            opts: LlmCallOpts,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("process args: {e}")))?;
        match self.manager.ask_text(&args.prompt, &args.opts).await {
            Ok(text) => Ok(Response::new(AiTextResultPb { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn request_action_with_tools(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            prompt: String,
            #[serde(default)]
            tools: Vec<ToolDefinition>,
            #[serde(default)]
            opts: LlmCallOpts,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("rwt args: {e}")))?;
        match self
            .manager
            .process_with_tools(&args.prompt, &args.tools, &args.opts)
            .await
        {
            Ok(response) => Ok(Response::new(raw_json(&response))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn code_assist(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<AiTextResultPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            prompt: String,
            #[serde(default)]
            opts: LlmCallOpts,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("code_assist args: {e}")))?;
        match self.manager.ask_text(&args.prompt, &args.opts).await {
            Ok(text) => Ok(Response::new(AiTextResultPb { text })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn run_agent_job(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            #[serde(rename = "jobId")]
            job_id: String,
            #[serde(rename = "agentPrompt")]
            agent_prompt: String,
            #[serde(default)]
            title: Option<String>,
            #[serde(default)]
            model: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("run_agent_job args: {e}")))?;
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
        req: Request<JsonArgs>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            prompt: String,
            #[serde(default)]
            model: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("spawn_sub_agent args: {e}")))?;
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
}

// Tests 이관 — `infra/tests/svc_ai_test.rs` (integration test).

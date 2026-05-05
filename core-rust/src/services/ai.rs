//! gRPC AiService impl — AiManager wrapping.
//!
//! Phase B-16 minimum: Process / RequestActionWithTools / CodeAssist 활성 (StubLlm 위에).
//! 실 LLM 호출은 Phase B-17+ (8 format 핸들러 박힌 후).
//! RunAgentJob / SpawnSubAgent / ResolveCallTarget 는 Phase B-17+ stub.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::AiManager;
use crate::ports::{LlmCallOpts, ToolDefinition};
use crate::proto::{
    ai_service_server::AiService, BoolRequest, Empty, JsonArgs, JsonValue, Status, StringRequest,
};

pub struct AiServiceImpl {
    manager: Arc<AiManager>,
}

impl AiServiceImpl {
    pub fn new(manager: Arc<AiManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl AiService for AiServiceImpl {
    async fn process(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
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
            Ok(text) => json_response(&serde_json::json!({"text": text})),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn request_action_with_tools(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
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
            Ok(response) => json_response(&response),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn code_assist(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-16 minimum — Code Assistant 자체 시스템 프롬프트는 Phase B-17+ 에서 prompt-builder
        // 분리 후 활성. 현재는 ask_text 그대로.
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
            Ok(text) => json_response(&serde_json::json!({"text": text})),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn run_agent_job(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS Core.runAgentJob 1:1 — cron agent 모드 자율 발행. AiManager.process_with_tools_opts
        // with cron_agent set → MAX_TOOL_TURNS 25 + approval gate 우회 + jobId 기반 컨텍스트.
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
            return json_response(&serde_json::json!({
                "success": false,
                "error": "agentPrompt 가 비어있습니다."
            }));
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
            Ok(res) => json_response(&serde_json::json!({
                "success": res.error.is_none(),
                "reply": res.reply,
                "executedActions": res.executed_actions,
                "blocks": res.blocks,
                "error": res.error,
            })),
            Err(e) => json_response(&serde_json::json!({
                "success": false,
                "error": e,
            })),
        }
    }

    async fn resolve_call_target(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS resolveCallTarget 1:1 — ToolDispatcher 박혀있을 때만 활성.
        // ToolDispatcher 가 AiManager 내부에 박혀있어 AiManager 위임 필요. 현재 풀 wiring 안 됐으면
        // identifier 만 echo + null kind (이전 stub 동작 유지 — 회귀 안전).
        let identifier = req.into_inner().value;
        // AiManager 에 dispatcher API 노출 후 활성. 현재는 단순 echo.
        json_response(&serde_json::json!({
            "identifier": identifier,
            "kind": serde_json::Value::Null,
            "note": "ToolDispatcher 풀 wiring 후 활성 — AiManager.resolve_call_target API 노출 필요"
        }))
    }

    async fn spawn_sub_agent(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS spawn_subagent 도구 — sub-agent 로 별도 task 실행.
        // 현재 minimum: 단순 process_with_tools 위임 (history 빈 채로 새 컨텍스트).
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
            Ok(res) => json_response(&res),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::llm::StubLlmAdapter;
    use crate::adapters::log::ConsoleLogAdapter;
    use crate::managers::tool::ToolManager;
    use crate::ports::{ILlmPort, ILogPort};

    fn service() -> AiServiceImpl {
        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = Arc::new(AiManager::new(llm, tools, log));
        AiServiceImpl::new(mgr)
    }

    #[tokio::test]
    async fn process_via_grpc_returns_stub_text() {
        let svc = service();
        let resp = svc
            .process(Request::new(JsonArgs {
                raw: serde_json::json!({"prompt": "hi"}).to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(parsed["text"].as_str().unwrap().contains("Phase B-17+"));
    }

    #[tokio::test]
    async fn request_action_with_tools_terminates() {
        let svc = service();
        let resp = svc
            .request_action_with_tools(Request::new(JsonArgs {
                raw: serde_json::json!({"prompt": "hello", "tools": []}).to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(parsed["modelId"], "stub");
    }
}

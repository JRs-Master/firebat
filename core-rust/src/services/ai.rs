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
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&serde_json::json!({
            "_phase": "B-17+ stub — agent 모드 cron / runAgentJob 활성 시점",
        }))
    }

    async fn resolve_call_target(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-17+ — 동적 sysmod / mcp 매칭. 현재는 미박음 표기.
        let identifier = req.into_inner().value;
        json_response(&serde_json::json!({
            "_phase": "B-17+ stub",
            "identifier": identifier,
            "kind": null
        }))
    }

    async fn spawn_sub_agent(
        &self,
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&serde_json::json!({"_phase": "B-17+ stub"}))
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

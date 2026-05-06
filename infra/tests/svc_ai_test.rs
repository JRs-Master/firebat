//! AiService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tonic::Request;

use firebat_core::managers::ai::AiManager;
use firebat_core::managers::tool::ToolManager;
use firebat_core::ports::{ILlmPort, ILogPort};
use firebat_core::proto::{ai_service_server::AiService, JsonArgs};
use firebat_core::services::ai::AiServiceImpl;
use firebat_infra::adapters::llm::StubLlmAdapter;
use firebat_infra::adapters::log::ConsoleLogAdapter;

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

//! RealTaskExecutor — TaskExecutor trait 의 실 구현체 (Phase B-17a).
//!
//! 옛 TS TaskManager 의 step 별 실행 로직 Rust port. TaskManager 의 stub 을 RealExecutor 로
//! 교체 → pipeline 7-step 모두 실 매니저 메서드 호출.
//!
//! Phase B-17 minimum:
//! - EXECUTE — ISandboxPort.execute (sysmod 실행)
//! - MCP_CALL — McpManager.call_tool
//! - LLM_TRANSFORM — AiManager.ask_text
//! - SAVE_PAGE — PageManager.save
//! - TOOL_CALL — ToolManager.dispatch
//! - NETWORK_REQUEST — Phase B-17+ stub (INetworkPort + reqwest 박힌 후 활성)

use std::sync::Arc;

use crate::managers::ai::AiManager;
use crate::managers::mcp::McpManager;
use crate::managers::page::PageManager;
use crate::managers::task::TaskExecutor;
use crate::managers::tool::ToolManager;
use crate::ports::{
    ILogPort, ISandboxPort, InfraResult, LlmCallOpts, SandboxExecuteOpts,
};

pub struct RealTaskExecutor {
    sandbox: Arc<dyn ISandboxPort>,
    mcp: Arc<McpManager>,
    ai: Arc<AiManager>,
    page: Arc<PageManager>,
    tools: Arc<ToolManager>,
    log: Arc<dyn ILogPort>,
}

impl RealTaskExecutor {
    pub fn new(
        sandbox: Arc<dyn ISandboxPort>,
        mcp: Arc<McpManager>,
        ai: Arc<AiManager>,
        page: Arc<PageManager>,
        tools: Arc<ToolManager>,
        log: Arc<dyn ILogPort>,
    ) -> Self {
        Self {
            sandbox,
            mcp,
            ai,
            page,
            tools,
            log,
        }
    }
}

#[async_trait::async_trait]
impl TaskExecutor for RealTaskExecutor {
    async fn execute_module(
        &self,
        path: &str,
        input: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] EXECUTE → {} (Sandbox)", path));
        let result = self
            .sandbox
            .execute(path, input, &SandboxExecuteOpts::default())
            .await?;
        if !result.success {
            return Err(result
                .error
                .unwrap_or_else(|| "sandbox execute 실패".to_string()));
        }
        Ok(result.data)
    }

    async fn call_mcp_tool(
        &self,
        server: &str,
        tool: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] MCP_CALL → {}/{}", server, tool));
        self.mcp.call_tool(server, tool, args).await
    }

    async fn network_request(
        &self,
        url: &str,
        _method: &str,
        _body: Option<&serde_json::Value>,
        _headers: Option<&serde_json::Value>,
    ) -> InfraResult<serde_json::Value> {
        // Phase B-17+ — INetworkPort + reqwest 박힌 후 활성.
        Err(format!(
            "NETWORK_REQUEST 미박음 (Phase B-17+ reqwest) — url={}",
            url
        ))
    }

    async fn llm_transform(
        &self,
        instruction: &str,
        input_text: &str,
    ) -> InfraResult<String> {
        self.log
            .info("[Pipeline] LLM_TRANSFORM → AiManager.ask_text");
        let prompt = format!(
            "{instruction}\n\n---\n{input_text}\n---\n\n위 구분선 안 원본을 근거로 응답하세요. 원본에 없는 정보 추측 금지."
        );
        self.ai.ask_text(&prompt, &LlmCallOpts::default()).await
    }

    async fn save_page(
        &self,
        slug: &str,
        spec: &serde_json::Value,
        _allow_overwrite: bool,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] SAVE_PAGE → slug={}", slug));
        let spec_str = serde_json::to_string(spec)
            .map_err(|e| format!("spec 직렬화 실패: {e}"))?;
        self.page
            .save(slug, &spec_str, "published", None, None, None)?;
        Ok(serde_json::json!({"slug": slug, "renamed": false}))
    }

    async fn execute_tool(
        &self,
        tool: &str,
        input: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] TOOL_CALL → {} (ToolManager.dispatch)", tool));
        self.tools.dispatch(tool, input).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::database::SqliteDatabaseAdapter;
    use crate::adapters::llm::StubLlmAdapter;
    use crate::adapters::log::ConsoleLogAdapter;
    use crate::adapters::mcp_client::McpClientFileAdapter;
    use crate::adapters::sandbox::ProcessSandboxAdapter;
    use crate::adapters::storage::LocalStorageAdapter;
    use crate::managers::task::{PipelineStep, TaskManager};
    use crate::ports::{IDatabasePort, ILlmPort, IMcpClientPort, IStoragePort};
    use tempfile::tempdir;

    fn make_executor(dir: &std::path::Path) -> Arc<RealTaskExecutor> {
        let db: Arc<dyn IDatabasePort> =
            Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir));
        let sandbox: Arc<dyn ISandboxPort> =
            Arc::new(ProcessSandboxAdapter::new(dir.to_path_buf()));
        let mcp_client: Arc<dyn IMcpClientPort> =
            Arc::new(McpClientFileAdapter::new(dir.join("mcp.json")).unwrap());
        let mcp = Arc::new(McpManager::new(mcp_client));
        let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
        let tools = Arc::new(ToolManager::new());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let ai = Arc::new(AiManager::new(llm, tools.clone(), log.clone()));
        let page = Arc::new(PageManager::new(db, storage));

        Arc::new(RealTaskExecutor::new(
            sandbox,
            mcp,
            ai,
            page,
            tools,
            log,
        ))
    }

    #[tokio::test]
    async fn real_executor_save_page_works() {
        let dir = tempdir().unwrap();
        let executor = make_executor(dir.path());
        let result = executor
            .save_page(
                "test-slug",
                &serde_json::json!({"body": [{"type": "Text", "props": {"content": "hi"}}]}),
                false,
            )
            .await
            .unwrap();
        assert_eq!(result["slug"], "test-slug");
    }

    #[tokio::test]
    async fn real_executor_llm_transform_returns_stub_text() {
        let dir = tempdir().unwrap();
        let executor = make_executor(dir.path());
        let text = executor
            .llm_transform("instruction", "input_text")
            .await
            .unwrap();
        assert!(text.contains("Phase B-17+"));
    }

    #[tokio::test]
    async fn real_executor_network_request_returns_phase_error() {
        let dir = tempdir().unwrap();
        let executor = make_executor(dir.path());
        let result = executor
            .network_request("https://example.com", "GET", None, None)
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Phase B-17+"));
    }

    #[tokio::test]
    async fn real_executor_in_pipeline_save_page_step() {
        let dir = tempdir().unwrap();
        let executor: Arc<dyn TaskExecutor> = make_executor(dir.path()) as Arc<dyn TaskExecutor>;
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let task_mgr = TaskManager::new(executor, log);
        let steps = vec![PipelineStep::SavePage {
            slug: Some("page-from-pipeline".to_string()),
            spec: Some(serde_json::json!({
                "body": [{"type": "Text", "props": {"content": "hello"}}]
            })),
            input_data: None,
            input_map: None,
            allow_overwrite: None,
        }];
        let result = task_mgr.execute_pipeline(&steps).await;
        assert!(result.success);
        let data = result.data.unwrap();
        assert_eq!(data["slug"], "page-from-pipeline");
    }
}

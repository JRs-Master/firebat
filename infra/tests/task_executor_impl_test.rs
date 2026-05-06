//! RealTaskExecutor integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;

use firebat_core::managers::ai::AiManager;
use firebat_core::managers::mcp::McpManager;
use firebat_core::managers::page::PageManager;
use firebat_core::managers::task::{PipelineStep, TaskExecutor, TaskManager};
use firebat_core::managers::tool::ToolManager;
use firebat_core::ports::{
    IDatabasePort, ILlmPort, ILogPort, IMcpClientPort, ISandboxPort, IStoragePort,
};
use firebat_core::task_executor_impl::RealTaskExecutor;
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::llm::StubLlmAdapter;
use firebat_infra::adapters::log::ConsoleLogAdapter;
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn make_executor(dir: &std::path::Path) -> Arc<RealTaskExecutor> {
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.join("app.db")).unwrap());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir));
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(ProcessSandboxAdapter::new(dir.to_path_buf()));
    let mcp_client: Arc<dyn IMcpClientPort> =
        Arc::new(McpClientFileAdapter::new(dir.join("mcp.json")).unwrap());
    let mcp = Arc::new(McpManager::new(mcp_client));
    let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
    let tools = Arc::new(ToolManager::new());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let ai = Arc::new(AiManager::new(llm, tools.clone(), log.clone()));
    let page = Arc::new(PageManager::new(db, storage));

    Arc::new(RealTaskExecutor::new(sandbox, mcp, ai, page, tools, log))
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
    let text = executor.llm_transform("instruction", "input_text").await.unwrap();
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

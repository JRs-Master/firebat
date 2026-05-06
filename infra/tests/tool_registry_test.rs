//! tool_registry integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;

use firebat_core::managers::consolidation::ConsolidationManager;
use firebat_core::managers::conversation::ConversationManager;
use firebat_core::managers::entity::EntityManager;
use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::managers::event::EventManager;
use firebat_core::managers::mcp::McpManager;
use firebat_core::managers::media::MediaManager;
use firebat_core::managers::memory_facade::MemoryFacade;
use firebat_core::managers::module::ModuleManager;
use firebat_core::managers::page::PageManager;
use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::managers::tool::ToolManager;
use firebat_core::ports::{
    ICronPort, IDatabasePort, IEntityPort, IEpisodicPort, ILogPort, IMcpClientPort, IMediaPort,
    IMemoryFacadePort, ISandboxPort, IStoragePort, IVaultPort,
};
use firebat_core::tool_registry::{register_core_tools, CoreToolHandlers};
use firebat_infra::adapters::cron::TokioCronAdapter;
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::log::ConsoleLogAdapter;
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
use firebat_infra::adapters::media::LocalMediaAdapter;
use firebat_infra::adapters::memory::SqliteMemoryAdapter;
use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

async fn make_setup() -> (Arc<ToolManager>, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let media: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));
    let sandbox: Arc<dyn ISandboxPort> =
        Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
    let mcp_client: Arc<dyn IMcpClientPort> =
        Arc::new(McpClientFileAdapter::new(dir.path().join("mcp.json")).unwrap());
    let memory_adapter =
        Arc::new(SqliteMemoryAdapter::new(dir.path().join("memory.db")).unwrap());
    let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter;

    let page_mgr = Arc::new(PageManager::new(db.clone(), storage.clone()));
    let conv_mgr = Arc::new(ConversationManager::new(db));
    let media_mgr = Arc::new(MediaManager::new(media));
    let module_mgr = Arc::new(ModuleManager::new(sandbox, storage.clone(), vault.clone()));
    let mcp_mgr = Arc::new(McpManager::new(mcp_client));
    let entity_mgr = Arc::new(EntityManager::new(entity_port));
    let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));
    let memory_facade: Arc<dyn IMemoryFacadePort> =
        Arc::new(MemoryFacade::new(entity_mgr.clone(), episodic_mgr.clone()));
    let consolidation_mgr = Arc::new(ConsolidationManager::new(memory_facade));

    let cron: Arc<dyn ICronPort> = TokioCronAdapter::new(
        dir.path().join("cron.json"),
        dir.path().join("cron-logs.json"),
        dir.path().join("cron-notes.json"),
        "Asia/Seoul",
    )
    .unwrap();
    let schedule_mgr = Arc::new(ScheduleManager::new(cron));
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let event_mgr = Arc::new(EventManager::new(log));

    let tools = Arc::new(ToolManager::new());
    register_core_tools(
        &tools,
        CoreToolHandlers {
            page: page_mgr,
            schedule: schedule_mgr,
            media: media_mgr,
            conversation: conv_mgr,
            storage,
            entity: entity_mgr,
            episodic: episodic_mgr,
            consolidation: consolidation_mgr,
            module: module_mgr,
            mcp: mcp_mgr,
            event: event_mgr,
        },
    );
    (tools, dir)
}

#[tokio::test]
async fn dispatch_list_pages_returns_array() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("list_pages", &serde_json::json!({}))
        .await
        .unwrap();
    assert!(result.is_array());
}

#[tokio::test]
async fn dispatch_write_then_read_file() {
    let (tools, dir) = make_setup().await;
    let test_path = "test.txt";
    tools
        .dispatch(
            "write_file",
            &serde_json::json!({"path": test_path, "content": "hello"}),
        )
        .await
        .unwrap();
    let result = tools
        .dispatch("read_file", &serde_json::json!({"path": test_path}))
        .await
        .unwrap();
    assert_eq!(result["content"], "hello");
    let abs = dir.path().join(test_path);
    assert!(abs.exists());
}

#[tokio::test]
async fn dispatch_get_page_missing_returns_null() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("get_page", &serde_json::json!({"slug": "missing"}))
        .await
        .unwrap();
    assert_eq!(result, serde_json::Value::Null);
}

#[tokio::test]
async fn dispatch_search_media_empty_returns_zero() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("search_media", &serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(result["total"], 0);
}

#[tokio::test]
async fn dispatch_list_cron_jobs_empty() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("list_cron_jobs", &serde_json::json!({}))
        .await
        .unwrap();
    assert!(result.is_array());
    assert_eq!(result.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn dispatch_unknown_tool_returns_error() {
    let (tools, _dir) = make_setup().await;
    let result = tools.dispatch("nonexistent", &serde_json::json!({})).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn registered_tool_count() {
    let (tools, _dir) = make_setup().await;
    let stats = tools.stats();
    // page: 4 + storage: 4 + schedule: 3 + media: 3 (search/image_gen/regenerate) +
    // conversation: 1 + entity: 5 + episodic: 3 + consolidation: 2 +
    // module: 3 + mcp: 2 = 30
    assert_eq!(stats.total, 30);
    assert_eq!(stats.by_source.get("core").copied(), Some(30));
}

#[tokio::test]
async fn dispatch_save_page_persists_to_db() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch(
            "save_page",
            &serde_json::json!({
                "slug": "ad-test-1",
                "spec": {"body": [{"type": "Text", "props": {"content": "AdSense 글"}}]},
                "status": "published"
            }),
        )
        .await
        .unwrap();
    assert_eq!(result["slug"], "ad-test-1");
    // 실 DB 저장 검증 — list_pages 호출
    let list = tools
        .dispatch("list_pages", &serde_json::json!({}))
        .await
        .unwrap();
    let arr = list.as_array().unwrap();
    assert!(arr.iter().any(|p| p["slug"] == "ad-test-1"));
}

#[tokio::test]
async fn dispatch_save_entity_then_search() {
    let (tools, _dir) = make_setup().await;
    tools
        .dispatch(
            "save_entity",
            &serde_json::json!({"name": "삼성전자", "type": "stock", "aliases": ["005930"]}),
        )
        .await
        .unwrap();
    let result = tools
        .dispatch("search_entities", &serde_json::json!({"query": "삼성"}))
        .await
        .unwrap();
    let arr = result.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["name"], "삼성전자");
}

#[tokio::test]
async fn dispatch_save_event_and_recent() {
    let (tools, _dir) = make_setup().await;
    tools
        .dispatch(
            "save_event",
            &serde_json::json!({"type": "page_publish", "title": "글 발행 완료"}),
        )
        .await
        .unwrap();
    let recent = tools
        .dispatch(
            "list_recent_events",
            &serde_json::json!({"type": "page_publish", "limit": 10}),
        )
        .await
        .unwrap();
    let arr = recent.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["title"], "글 발행 완료");
}

#[tokio::test]
async fn dispatch_get_memory_stats_returns_zero() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("get_memory_stats", &serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(result["entities"], 0);
    assert_eq!(result["events"], 0);
}

#[tokio::test]
async fn dispatch_list_mcp_servers_empty() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("list_mcp_servers", &serde_json::json!({}))
        .await
        .unwrap();
    assert!(result.is_array());
    assert_eq!(result.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn dispatch_list_user_modules_returns_array() {
    let (tools, _dir) = make_setup().await;
    let result = tools
        .dispatch("list_user_modules", &serde_json::json!({}))
        .await
        .unwrap();
    assert!(result.is_array());
}

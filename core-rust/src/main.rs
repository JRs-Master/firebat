//! Firebat Core — gRPC server entry (self-hosted distribution).
//!
//! Phase B 진행하며 21 매니저 + cross-cutting service 등록.
//! Phase B-17b: SIGTERM + SIGINT 통합 graceful shutdown — Docker / systemd 운영 시 SQLite WAL
//! 손상 방지. anyhow Context 로 부팅 실패 원인 역추적 가능.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;
use tonic::transport::Server;

use firebat_core::{
    adapters::{
        auth::VaultAuthAdapter, cron::TokioCronAdapter, database::SqliteDatabaseAdapter,
        log::ConsoleLogAdapter, mcp_client::McpClientFileAdapter,
        media::LocalMediaAdapter, memory::SqliteMemoryAdapter, sandbox::ProcessSandboxAdapter,
        storage::LocalStorageAdapter, vault::SqliteVaultAdapter,
    },
    managers::{
        ai::AiManager, auth::AuthManager, capability::CapabilityManager,
        consolidation::ConsolidationManager, conversation::ConversationManager,
        cost::CostManager, entity::EntityManager, episodic::EpisodicManager, event::EventManager,
        mcp::McpManager, media::MediaManager, module::ModuleManager, page::PageManager,
        project::ProjectManager, schedule::ScheduleManager, secret::SecretManager,
        status::StatusManager,
        task::{TaskExecutor, TaskManager}, template::TemplateManager,
        tool::ToolManager,
    },
    ports::{
        IAuthPort, IDatabasePort, IEntityPort, IEpisodicPort, ILlmPort, ILogPort, IMcpClientPort,
        IMediaPort, ISandboxPort, IStoragePort, IVaultPort,
    },
    proto::{
        ai_service_server::AiServiceServer,
        auth_service_server::AuthServiceServer,
        capability_service_server::CapabilityServiceServer,
        consolidation_service_server::ConsolidationServiceServer,
        conversation_service_server::ConversationServiceServer,
        cost_service_server::CostServiceServer,
        entity_service_server::EntityServiceServer,
        episodic_service_server::EpisodicServiceServer,
        event_service_server::EventServiceServer,
        mcp_service_server::McpServiceServer,
        module_service_server::ModuleServiceServer,
        media_service_server::MediaServiceServer,
        page_service_server::PageServiceServer,
        project_service_server::ProjectServiceServer,
        schedule_service_server::ScheduleServiceServer,
        secret_service_server::SecretServiceServer,
        status_service_server::StatusServiceServer,
        task_service_server::TaskServiceServer,
        template_service_server::TemplateServiceServer,
        tool_service_server::ToolServiceServer,
    },
    services,
};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    // 환경 변수 — workspace root + listen address + vault DB path
    let workspace_root: PathBuf = std::env::var("FIREBAT_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap());
    let listen_addr = std::env::var("FIREBAT_CORE_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:50051".to_string());
    let vault_db_path = std::env::var("FIREBAT_VAULT_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("vault.db"));
    let app_db_path = std::env::var("FIREBAT_APP_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("app.db"));
    let mcp_servers_path = std::env::var("FIREBAT_MCP_SERVERS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("mcp-servers.json"));
    let memory_db_path = std::env::var("FIREBAT_MEMORY_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("memory.db"));
    let cron_jobs_path = std::env::var("FIREBAT_CRON_JOBS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("cron-jobs.json"));
    let cron_logs_path = std::env::var("FIREBAT_CRON_LOGS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("cron-logs.json"));
    let cron_notifications_path = std::env::var("FIREBAT_CRON_NOTIFICATIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("cron-notifications.json"));
    let default_timezone = std::env::var("FIREBAT_TIMEZONE").unwrap_or_else(|_| "Asia/Seoul".to_string());
    let addr = listen_addr.parse().with_context(|| {
        format!("FIREBAT_CORE_LISTEN '{}' 파싱 실패 — host:port 형식 필요", listen_addr)
    })?;

    eprintln!(
        "Firebat Core v{} — gRPC server starting on {}",
        firebat_core::version(),
        listen_addr
    );
    eprintln!(
        "  workspace: {}\n  vault DB:  {}",
        workspace_root.display(),
        vault_db_path.display()
    );

    // 어댑터 wiring — InfraResult<T,String> 을 anyhow::Error 로 변환 (with_context 로 원인 역추적).
    let logger: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(&workspace_root));
    let vault: Arc<dyn IVaultPort> = Arc::new(
        SqliteVaultAdapter::new(&vault_db_path)
            .map_err(anyhow::Error::msg)
            .context("Vault DB open 실패")?,
    );
    let auth_port: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
    let db_concrete = Arc::new(
        SqliteDatabaseAdapter::new(&app_db_path)
            .map_err(anyhow::Error::msg)
            .context("App DB open 실패")?,
    );
    let db: Arc<dyn IDatabasePort> = db_concrete.clone();
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(ProcessSandboxAdapter::new(workspace_root.clone()));
    let mcp_client: Arc<dyn IMcpClientPort> = Arc::new(
        McpClientFileAdapter::new(mcp_servers_path)
            .map_err(anyhow::Error::msg)
            .context("MCP servers 파일 open 실패")?,
    );
    let memory_adapter = Arc::new(
        SqliteMemoryAdapter::new(&memory_db_path)
            .map_err(anyhow::Error::msg)
            .context("Memory DB open 실패")?,
    );
    let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter.clone();
    let cron_adapter = TokioCronAdapter::new(
        cron_jobs_path,
        cron_logs_path,
        cron_notifications_path,
        &default_timezone,
    )
    .map_err(anyhow::Error::msg)
    .context("Cron 어댑터 초기화 실패")?;
    let media: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(&workspace_root));
    // Phase B-17 — ConfigDrivenAdapter. 8 format (5 API + 3 CLI) 핸들러 박힘.
    // Vault `system:llm:model` 으로 활성 모델 동적 swap. API 키 없으면 핸들러가 명시 에러 반환.
    let default_model =
        std::env::var("FIREBAT_DEFAULT_MODEL").unwrap_or_else(|_| "claude-4-sonnet".to_string());
    let llm: Arc<dyn ILlmPort> = Arc::new(firebat_core::llm::adapter::ConfigDrivenAdapter::new(
        vault.clone(),
        default_model,
    ));

    // 매니저 wiring
    let template_manager = Arc::new(TemplateManager::new(storage.clone()));
    let secret_manager = Arc::new(SecretManager::new(vault.clone(), storage.clone()));
    let auth_manager = Arc::new(AuthManager::new(auth_port, vault.clone()));
    let event_manager = Arc::new(EventManager::new(logger.clone()));
    let capability_manager = Arc::new(CapabilityManager::new(
        storage.clone(),
        vault.clone(),
        logger.clone(),
    ));
    let status_manager = Arc::new(StatusManager::new(Some(event_manager.clone())));
    let tool_manager = Arc::new(ToolManager::new());
    let cost_manager = Arc::new(CostManager::new(db_concrete.clone(), vault.clone()));
    let project_manager = Arc::new(ProjectManager::new(
        storage.clone(),
        db.clone(),
        vault.clone(),
    ));
    let module_manager = Arc::new(ModuleManager::new(
        sandbox.clone(),
        storage.clone(),
        vault.clone(),
    ));
    let page_manager = Arc::new(PageManager::new(db.clone(), storage.clone()));
    let conversation_manager = Arc::new(ConversationManager::new(db.clone()));
    let mcp_manager = Arc::new(McpManager::new(mcp_client));
    let entity_manager = Arc::new(EntityManager::new(entity_port));
    let episodic_manager = Arc::new(EpisodicManager::new(episodic_port));
    let consolidation_manager = Arc::new(ConsolidationManager::new(
        entity_manager.clone(),
        episodic_manager.clone(),
    ));
    let schedule_manager = Arc::new(ScheduleManager::new(cron_adapter.clone()));
    let media_manager = Arc::new(MediaManager::new(media));
    let ai_manager = Arc::new(AiManager::new(
        llm.clone(),
        tool_manager.clone(),
        logger.clone(),
    ));

    // Phase B-17a/c — 정적 도구 dispatch 등록 (27 도구). LLM stub 위에서도 도구 호출 e2e 동작.
    firebat_core::tool_registry::register_core_tools(
        &tool_manager,
        firebat_core::tool_registry::CoreToolHandlers {
            page: page_manager.clone(),
            schedule: schedule_manager.clone(),
            media: media_manager.clone(),
            conversation: conversation_manager.clone(),
            storage: storage.clone(),
            entity: entity_manager.clone(),
            episodic: episodic_manager.clone(),
            consolidation: consolidation_manager.clone(),
            module: module_manager.clone(),
            mcp: mcp_manager.clone(),
        },
    );

    // Phase B-17a — TaskManager 의 step executor 를 RealTaskExecutor 로 wiring.
    // AiManager (ToolManager 위) → RealTaskExecutor (Sandbox/Mcp/Ai/Page/Tool 위) → TaskManager.
    // 의존성 단방향 트리 (AiManager 가 TaskManager 의존 X — cycle 없음).
    let task_executor: Arc<dyn TaskExecutor> = Arc::new(
        firebat_core::task_executor_impl::RealTaskExecutor::new(
            sandbox.clone(),
            mcp_manager.clone(),
            ai_manager.clone(),
            page_manager.clone(),
            tool_manager.clone(),
            logger.clone(),
        ),
    );
    let task_manager = Arc::new(TaskManager::new(task_executor, logger.clone()));

    // 부팅 시 영속 잡 복원 (cron / once 만 — delay 잡은 시각 부재로 복원 불가)
    schedule_manager.restore().await;

    // service impls
    let template_service = services::template::TemplateServiceImpl::new(template_manager);
    let secret_service = services::secret::SecretServiceImpl::new(secret_manager);
    let auth_service = services::auth::AuthServiceImpl::new(auth_manager);
    let event_service = services::event::EventServiceImpl::new(event_manager);
    let capability_service = services::capability::CapabilityServiceImpl::new(capability_manager);
    let status_service = services::status::StatusServiceImpl::new(status_manager);
    let tool_service = services::tool::ToolServiceImpl::new(tool_manager);
    let cost_service = services::cost::CostServiceImpl::new(cost_manager);
    let project_service = services::project::ProjectServiceImpl::new(project_manager);
    let module_service = services::module::ModuleServiceImpl::new(module_manager);
    let page_service = services::page::PageServiceImpl::new(page_manager);
    let conversation_service = services::conversation::ConversationServiceImpl::new(conversation_manager);
    let mcp_service = services::mcp::McpServiceImpl::new(mcp_manager);
    let entity_service = services::entity::EntityServiceImpl::new(entity_manager);
    let episodic_service = services::episodic::EpisodicServiceImpl::new(episodic_manager);
    let consolidation_service =
        services::consolidation::ConsolidationServiceImpl::new(consolidation_manager);
    let schedule_service = services::schedule::ScheduleServiceImpl::new(schedule_manager);
    let task_service = services::task::TaskServiceImpl::new(task_manager);
    let media_service = services::media::MediaServiceImpl::new(media_manager);
    let ai_service = services::ai::AiServiceImpl::new(ai_manager);

    // graceful shutdown — SIGINT (Ctrl+C) + SIGTERM (Docker / systemd 종료) 통합 listen.
    // Phase B-17b: 옛 ctrl_c() 만 listen 시 SIGTERM 무시 → 즉시 강제 종료 → SQLite WAL 손상 위험.
    // tokio::select! 로 둘 중 먼저 도착하는 시그널 처리. Windows 는 SIGTERM 미지원 → ctrl_c 만.
    let shutdown = async {
        let ctrl_c = async {
            let _ = tokio::signal::ctrl_c().await;
            "SIGINT (Ctrl+C)"
        };
        #[cfg(unix)]
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut sig) => {
                    sig.recv().await;
                    "SIGTERM"
                }
                Err(_) => {
                    // SIGTERM handler 등록 실패 시 영원히 pending — ctrl_c 만 작동
                    std::future::pending::<&str>().await
                }
            }
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<&str>();

        let signal_name = tokio::select! {
            n = ctrl_c => n,
            n = terminate => n,
        };
        eprintln!(
            "Firebat Core — {} 수신 → graceful shutdown 시작 (활성 요청 완료 대기)",
            signal_name
        );
    };

    Server::builder()
        .add_service(TemplateServiceServer::new(template_service))
        .add_service(SecretServiceServer::new(secret_service))
        .add_service(AuthServiceServer::new(auth_service))
        .add_service(EventServiceServer::new(event_service))
        .add_service(CapabilityServiceServer::new(capability_service))
        .add_service(StatusServiceServer::new(status_service))
        .add_service(ToolServiceServer::new(tool_service))
        .add_service(CostServiceServer::new(cost_service))
        .add_service(ProjectServiceServer::new(project_service))
        .add_service(ModuleServiceServer::new(module_service))
        .add_service(PageServiceServer::new(page_service))
        .add_service(ConversationServiceServer::new(conversation_service))
        .add_service(McpServiceServer::new(mcp_service))
        .add_service(EntityServiceServer::new(entity_service))
        .add_service(EpisodicServiceServer::new(episodic_service))
        .add_service(ConsolidationServiceServer::new(consolidation_service))
        .add_service(ScheduleServiceServer::new(schedule_service))
        .add_service(TaskServiceServer::new(task_service))
        .add_service(MediaServiceServer::new(media_service))
        .add_service(AiServiceServer::new(ai_service))
        // Phase B 완료 — 19 매니저 service 등록 (Module 까지 포함하면 19/21).
        // 남은 cross-cutting (Storage / Settings / Network / Cache / Telegram / Database /
        // Lifecycle 등) 은 Phase B-17+ 후속.
        .serve_with_shutdown(addr, shutdown)
        .await
        .context("gRPC server 종료 중 에러")?;

    eprintln!("Firebat Core — shutdown 완료");
    Ok(())
}

//! Firebat Core — gRPC server entry (self-hosted distribution, Phase B-2 활성).
//!
//! Phase B 진행하며 21 매니저 + cross-cutting service 등록.
//! 현재: TemplateService + SecretService 등록 — pattern 정착용.

use std::path::PathBuf;
use std::sync::Arc;
use tonic::transport::Server;

use firebat_core::{
    adapters::{
        auth::VaultAuthAdapter, database::SqliteDatabaseAdapter, log::ConsoleLogAdapter,
        storage::LocalStorageAdapter, vault::SqliteVaultAdapter,
    },
    managers::{
        auth::AuthManager, capability::CapabilityManager, cost::CostManager, event::EventManager,
        secret::SecretManager, status::StatusManager, template::TemplateManager, tool::ToolManager,
    },
    ports::{IAuthPort, ILogPort, IStoragePort, IVaultPort},
    proto::{
        auth_service_server::AuthServiceServer,
        capability_service_server::CapabilityServiceServer,
        cost_service_server::CostServiceServer,
        event_service_server::EventServiceServer,
        secret_service_server::SecretServiceServer,
        status_service_server::StatusServiceServer,
        template_service_server::TemplateServiceServer,
        tool_service_server::ToolServiceServer,
    },
    services,
};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
    let addr = listen_addr.parse()?;

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

    // 어댑터 wiring
    let logger: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(&workspace_root));
    let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new(&vault_db_path)?);
    let auth_port: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
    let db = Arc::new(SqliteDatabaseAdapter::new(&app_db_path)?);

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
    let cost_manager = Arc::new(CostManager::new(db.clone(), vault.clone()));

    // service impls
    let template_service = services::template::TemplateServiceImpl::new(template_manager);
    let secret_service = services::secret::SecretServiceImpl::new(secret_manager);
    let auth_service = services::auth::AuthServiceImpl::new(auth_manager);
    let event_service = services::event::EventServiceImpl::new(event_manager);
    let capability_service = services::capability::CapabilityServiceImpl::new(capability_manager);
    let status_service = services::status::StatusServiceImpl::new(status_manager);
    let tool_service = services::tool::ToolServiceImpl::new(tool_manager);
    let cost_service = services::cost::CostServiceImpl::new(cost_manager);

    // graceful shutdown — Ctrl+C / SIGTERM
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        eprintln!("Firebat Core — graceful shutdown 시작");
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
        // Phase B 진행하며 추가:
        //   .add_service(PageServiceServer::new(...))
        //   .add_service(ProjectServiceServer::new(...))
        //   .add_service(ScheduleServiceServer::new(...))
        //   ... 21 매니저 + cross-cutting 등록
        .serve_with_shutdown(addr, shutdown)
        .await?;

    eprintln!("Firebat Core — shutdown 완료");
    Ok(())
}

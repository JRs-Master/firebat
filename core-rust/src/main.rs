//! Firebat Core — gRPC server entry (self-hosted distribution, Phase B-2 활성).
//!
//! Phase B 진행하며 21 매니저 + cross-cutting service 등록.
//! 현재: TemplateService + SecretService 등록 — pattern 정착용.

use std::path::PathBuf;
use std::sync::Arc;
use tonic::transport::Server;

use firebat_core::{
    adapters::{storage::LocalStorageAdapter, vault::SqliteVaultAdapter},
    managers::{secret::SecretManager, template::TemplateManager},
    ports::{IStoragePort, IVaultPort},
    proto::{
        secret_service_server::SecretServiceServer,
        template_service_server::TemplateServiceServer,
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
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(&workspace_root));
    let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new(&vault_db_path)?);

    // 매니저 wiring
    let template_manager = Arc::new(TemplateManager::new(storage.clone()));
    let secret_manager = Arc::new(SecretManager::new(vault.clone(), storage.clone()));

    // service impls
    let template_service = services::template::TemplateServiceImpl::new(template_manager);
    let secret_service = services::secret::SecretServiceImpl::new(secret_manager);

    // graceful shutdown — Ctrl+C / SIGTERM
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        eprintln!("Firebat Core — graceful shutdown 시작");
    };

    Server::builder()
        .add_service(TemplateServiceServer::new(template_service))
        .add_service(SecretServiceServer::new(secret_service))
        // Phase B 진행하며 추가:
        //   .add_service(PageServiceServer::new(...))
        //   .add_service(AuthServiceServer::new(...))
        //   ... 21 매니저 + cross-cutting 등록
        .serve_with_shutdown(addr, shutdown)
        .await?;

    eprintln!("Firebat Core — shutdown 완료");
    Ok(())
}

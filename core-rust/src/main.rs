//! Firebat Core — gRPC server entry (self-hosted distribution, Phase B-2 활성).
//!
//! Phase B 진행하며 21 매니저 + cross-cutting service 등록.
//! 현재: TemplateService 만 등록 — pattern 정착용 (Phase B 후속에서 매 매니저 추가).

use std::sync::Arc;
use tonic::transport::Server;

use firebat_core::{
    adapters::storage::LocalStorageAdapter,
    managers::template::TemplateManager,
    ports::IStoragePort,
    proto::template_service_server::TemplateServiceServer,
    services,
};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 환경 변수 — workspace root + listen address
    let workspace_root = std::env::var("FIREBAT_WORKSPACE_ROOT")
        .unwrap_or_else(|_| std::env::current_dir().unwrap().to_string_lossy().into_owned());
    let listen_addr = std::env::var("FIREBAT_CORE_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:50051".to_string());
    let addr = listen_addr.parse()?;

    eprintln!(
        "Firebat Core v{} — gRPC server starting on {} (workspace: {})",
        firebat_core::version(),
        listen_addr,
        workspace_root
    );

    // 어댑터 + 매니저 wiring
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(&workspace_root));
    let template_manager = Arc::new(TemplateManager::new(storage));

    // service impls
    let template_service =
        services::template::TemplateServiceImpl::new(template_manager);

    // gRPC server — graceful shutdown 시그널 (SIGTERM / Ctrl+C) 받음
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
        eprintln!("Firebat Core — graceful shutdown 시작");
    };

    Server::builder()
        .add_service(TemplateServiceServer::new(template_service))
        // Phase B 진행하며 추가:
        //   .add_service(PageServiceServer::new(...))
        //   .add_service(AuthServiceServer::new(...))
        //   ... 21 매니저 + cross-cutting 등록
        .serve_with_shutdown(addr, shutdown)
        .await?;

    eprintln!("Firebat Core — shutdown 완료");
    Ok(())
}

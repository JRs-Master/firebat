//! gRPC LifecycleService impl — Health / CaptureException / GracefulShutdown.
//!
//! Phase B-17.5 minimum: Health 활성 (uptime + version + active managers list).
//! CaptureException 은 stub (Phase B-17.5+ tracing + Sentry 설정된 후).
//! GracefulShutdown 은 명시 종료 신호 — 어드민이 호출하면 Server::serve_with_shutdown 통과.
//!
//! 2026-05-15 unique RPC message — Empty/NumberRequest shared 폐기.

use std::sync::OnceLock;
use std::time::Instant;
use tonic::{Request, Response, Status as TonicStatus};

use crate::proto::{
    lifecycle_service_server::LifecycleService, HealthInfo, LifecycleCaptureExceptionRequest,
    LifecycleCaptureExceptionResponse, LifecycleGracefulShutdownRequest,
    LifecycleGracefulShutdownResponse, LifecycleHealthRequest,
};

/// 부팅 시각 — 한 번만 set, 매 health 호출 시 uptime 계산.
fn boot_instant() -> &'static Instant {
    static BOOT: OnceLock<Instant> = OnceLock::new();
    BOOT.get_or_init(Instant::now)
}

pub struct LifecycleServiceImpl {
    active_managers: Vec<String>,
}

impl LifecycleServiceImpl {
    pub fn new(active_managers: Vec<String>) -> Self {
        let _ = boot_instant(); // 부팅 시각 lock-in
        Self { active_managers }
    }
}

#[tonic::async_trait]
impl LifecycleService for LifecycleServiceImpl {
    async fn health(
        &self,
        _req: Request<LifecycleHealthRequest>,
    ) -> Result<Response<HealthInfo>, TonicStatus> {
        let uptime = boot_instant().elapsed().as_millis() as i64;
        Ok(Response::new(HealthInfo {
            version: crate::version().to_string(),
            uptime_ms: uptime,
            ready: true,
            active_managers: self.active_managers.clone(),
        }))
    }

    async fn capture_exception(
        &self,
        req: Request<LifecycleCaptureExceptionRequest>,
    ) -> Result<Response<LifecycleCaptureExceptionResponse>, TonicStatus> {
        // Phase B-17.5+ — tracing / Sentry 통합 후 활성. 현재는 stderr 로그만.
        let args = req.into_inner();
        eprintln!(
            "[CaptureException] {} severity={} stack={:?}",
            args.message,
            args.severity.unwrap_or_else(|| "error".to_string()),
            args.stack
        );
        Ok(Response::new(LifecycleCaptureExceptionResponse {}))
    }

    async fn graceful_shutdown(
        &self,
        _req: Request<LifecycleGracefulShutdownRequest>,
    ) -> Result<Response<LifecycleGracefulShutdownResponse>, TonicStatus> {
        // 명시 shutdown 트리거. main.rs 의 SIGTERM/SIGINT listen 외 추가 trigger.
        // Phase B-17.5+ — 활성 작업 대기 + Cost flush + GC 등 옛 TS Core.gracefulShutdown 패턴.
        // 현재 minimum 은 stderr 로그만 — 실 종료는 SIGTERM 권장.
        eprintln!("[Lifecycle] graceful_shutdown 요청 — SIGTERM 권장");
        Ok(Response::new(LifecycleGracefulShutdownResponse {}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_returns_active_managers() {
        let svc = LifecycleServiceImpl::new(vec![
            "AiManager".to_string(),
            "PageManager".to_string(),
        ]);
        let resp = svc
            .health(Request::new(LifecycleHealthRequest {}))
            .await
            .unwrap();
        let info = resp.into_inner();
        assert!(info.ready);
        assert_eq!(info.active_managers.len(), 2);
        assert!(info.uptime_ms >= 0);
    }
}

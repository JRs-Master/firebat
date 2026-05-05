//! TracingLogAdapter — ILogPort 의 tracing crate 구현체.
//!
//! 외부 review #2 (BIBLE 제8장 correlationId + durationMs) 대응 박힘.
//! ConsoleLogAdapter 의 stderr eprintln! 대신 tracing::info!() / warn!() / error!() / debug!()
//! 매크로로 forward. tracing-subscriber 가 env RUST_LOG 기준 filter + JSON 또는 pretty 출력.
//!
//! 비동기 컨텍스트에서 매 요청 Span 활성화 시 자동으로 correlation_id 박힘
//! (spans 내부에서 호출되는 모든 log event 가 inherit).

use firebat_core::ports::ILogPort;

pub struct TracingLogAdapter;

impl TracingLogAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TracingLogAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ILogPort for TracingLogAdapter {
    fn info(&self, msg: &str) {
        tracing::info!(message = msg);
    }
    fn warn(&self, msg: &str) {
        tracing::warn!(message = msg);
    }
    fn error(&self, msg: &str) {
        tracing::error!(message = msg);
    }
    fn debug(&self, msg: &str) {
        tracing::debug!(message = msg);
    }
}

/// 부팅 시 1회 호출 — tracing-subscriber 초기화.
/// env RUST_LOG 기준 filter (default "info"). FIREBAT_LOG_FORMAT=json → JSON 출력.
pub fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let json_format = std::env::var("FIREBAT_LOG_FORMAT")
        .map(|v| v.eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    if json_format {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .with_target(true)
            .with_current_span(true)
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_target(true)
            .init();
    }
}

/// Correlation ID 생성 — uuid v4. 매 gRPC RPC 진입 시 호출.
pub fn new_correlation_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn correlation_id_is_uuid_v4_simple() {
        let id = new_correlation_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn correlation_ids_are_unique() {
        let a = new_correlation_id();
        let b = new_correlation_id();
        assert_ne!(a, b);
    }
}

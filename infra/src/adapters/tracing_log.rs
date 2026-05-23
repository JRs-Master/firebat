//! TracingLogAdapter — ILogPort 의 tracing crate 구현체.
//!
//! 외부 review #2 (BIBLE 제8장 correlationId + durationMs) 대응 설정.
//! ConsoleLogAdapter 의 stderr eprintln! 대신 tracing::info!() / warn!() / error!() / debug!()
//! 매크로로 forward. tracing-subscriber 가 env RUST_LOG 기준 filter + JSON 또는 pretty 출력.
//!
//! 비동기 컨텍스트에서 매 요청 Span 활성화 시 자동으로 correlation_id 설정
//! (spans 내부에서 호출되는 모든 log event 가 inherit).
//!
//! 로그 시스템 1단계 (2026-05-21) — EnvFilter reload layer 도입. SIGHUP 시 `reload_log_filter`
//! 로 런타임에 레벨/카테고리 동적 변경 (재빌드 / 재시작 0). 진단 로그는 코드 곳곳에 이미
//! tracing::debug! 로 박혀있어, 평소엔 off (info) 두고 진단 시 카테고리만 켜는 흐름.

use std::path::PathBuf;

use firebat_core::ports::ILogPort;
use tracing_subscriber::{prelude::*, reload, EnvFilter, Registry};

use crate::adapters::log_buffer::LogBufferLayer;

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

    /// category 를 tracing field 로 기록 — target 은 컴파일 시점 static str 이라 런타임 값을
    /// 넣을 수 없으므로 field 로 전달한다. LogBufferLayer 의 MessageVisitor 가 이 `category`
    /// field 를 추출해 sqlite LogRow.target 에 우선 저장 → admin 로그 탭의 prefix 필터가
    /// 매니저 category 단위로 동작.
    fn log_with(&self, category: &str, level: &str, msg: &str) {
        match level {
            "warn" => tracing::warn!(category = category, message = msg),
            "error" => tracing::error!(category = category, message = msg),
            "debug" => tracing::debug!(category = category, message = msg),
            _ => tracing::info!(category = category, message = msg),
        }
    }
}

/// EnvFilter reload handle — SIGHUP 시 main.rs 가 `reload_log_filter` 에 전달.
/// inner subscriber = Registry (reload layer 가 registry 위에 wrap).
pub type LogReloadHandle = reload::Handle<EnvFilter, Registry>;

/// 부팅 시 1회 호출 — tracing-subscriber 초기화 + reload handle 반환.
/// env RUST_LOG 기준 초기 filter (default "info"). FIREBAT_LOG_FORMAT=json → JSON 출력.
/// 반환 handle 로 런타임 filter reload (SIGHUP).
///
/// layer 구성 (fan-out): reload EnvFilter (global) → fmt(journalctl) + LogBufferLayer(sqlite ring).
/// filter 통과 event 가 journalctl + sqlite 둘 다 기록. SIGHUP reload 시 둘 다 레벨 변경.
/// log_db_path = data/logs.db (sqlite ring buffer, 최근 5000건). admin 로그 탭 (Phase 5) 조회용.
pub fn init_tracing(log_db_path: PathBuf) -> LogReloadHandle {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    let (filter_layer, reload_handle) = reload::Layer::new(filter);

    let json_format = std::env::var("FIREBAT_LOG_FORMAT")
        .map(|v| v.eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    let log_layer = LogBufferLayer::new(log_db_path, 5000);
    let registry = tracing_subscriber::registry()
        .with(filter_layer)
        .with(log_layer);
    if json_format {
        registry
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    .with_target(true)
                    .with_current_span(true),
            )
            .init();
    } else {
        registry
            .with(tracing_subscriber::fmt::layer().with_target(true))
            .init();
    }

    reload_handle
}

/// 런타임 filter reload — SIGHUP handler 에서 `data/log-filter.txt` 내용으로 호출.
/// 예: "info,firebat_infra::adapters::sandbox=debug,law-search=debug".
/// 파싱 실패 / handle 오류 시 Err — 기존 filter 유지 (서버 중단 X).
pub fn reload_log_filter(handle: &LogReloadHandle, filter_str: &str) -> Result<(), String> {
    let new_filter = EnvFilter::try_new(filter_str).map_err(|e| e.to_string())?;
    handle.reload(new_filter).map_err(|e| e.to_string())?;
    Ok(())
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

//! Firebat Core — Rust backend library (v1.0 Final Phase B target).
//!
//! 두 build target 단일 codebase:
//!  - `lib`        : Phase D self-installed 시 Tauri 안에 in-process embed.
//!  - `[[bin]]`    : Phase C self-hosted 시 단일 binary (gRPC server, port 50051).
//!
//! Hexagonal architecture:
//!  - `ports`     : trait (interface) 정의 — 매니저가 의존
//!  - `adapters`  : trait 의 실 구현 — fs / DB / network / 등 I/O
//!  - `managers`  : 비즈니스 로직 — port 만 통해 I/O 사용
//!  - `services`  : gRPC service trait impl — 매니저 wrapping (Phase B-2)

pub mod ports;
pub mod adapters;
pub mod managers;
pub mod services;
pub mod vault_keys;
pub mod capabilities;
pub mod utils;
pub mod tool_registry;
pub mod task_executor_impl;
pub mod llm;

/// Generated proto module — tonic-build (build.rs) 가 자동 생성.
/// 21 매니저 + cross-cutting 의 service trait + client stub + message struct 포함.
pub mod proto {
    tonic::include_proto!("firebat.v1");
}

/// Firebat Core 의 진입점 — Phase B 시작 시 매니저 / 어댑터 / gRPC server 박힘.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_returns_pkg_version() {
        assert_eq!(version(), "0.0.1");
    }

    #[test]
    fn proto_module_compiles() {
        // proto/firebat.proto 의 service / message 가 정상 컴파일되는지 sanity check.
        let _info = proto::HealthInfo {
            version: String::from("0.0.1"),
            uptime_ms: 0,
            ready: true,
            active_managers: vec![],
        };
    }
}

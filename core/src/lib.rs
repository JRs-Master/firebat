//! Firebat Core — managers + services + ports trait (hexagonal core).
//!
//! Phase B-4 cutover (TS 폐기, Rust 단일):
//!  - `core` crate: managers + services + ports + utils (infra 의존 0건)
//!  - `infra` crate: adapters + LLM + image_gen + main binary (`firebat-core`)
//!
//! 의존 단방향 — `infra → core`. core 는 trait 만 정의, infra 가 implement.

pub mod ports;
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

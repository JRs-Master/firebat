#![recursion_limit = "256"]
//! Firebat Core — managers + grpc + ports trait (hexagonal core).
//!
//! Phase B-4 cutover (TS 폐기, Rust 단일):
//!  - `core` crate: managers + grpc + ports + utils (infra 의존 0건)
//!  - `infra` crate: adapters + LLM + image_gen + main binary (`firebat-core`)
//!
//! 의존 단방향 — `infra → core`. core 는 trait 만 정의, infra 가 implement.

pub mod ports;
pub mod managers;
pub mod grpc;
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

/// file_descriptor_set — tonic-reflection 의 reflection service 가 사용.
/// grpcurl / grpcui 같은 도구가 binary 의 schema 직접 inspect 가능 (dev ergonomics).
pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/firebat_descriptor.bin"));

/// Firebat Core 의 진입점 — Phase B 시작 시 매니저 / 어댑터 / gRPC server 설정.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_returns_pkg_version() {
        // Cargo.toml 의 [package].version 자동 추적 (env!("CARGO_PKG_VERSION")).
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
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

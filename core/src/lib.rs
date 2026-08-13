#![recursion_limit = "256"]
//! Firebat Core — managers + grpc + ports trait (hexagonal core).
//!
//! Phase B-4 cutover (TS 폐기, Rust 단일):
//!  - `core` crate: managers + grpc + ports + utils (infra 의존 0건)
//!  - `infra` crate: adapters + LLM + image_gen + main binary (`firebat-core`)
//!
//! 의존 단방향 — `infra → core`. core 는 trait 만 정의, infra 가 implement.

/// The build this binary is, as `<product>.<yy.mm.dd.hh.mm>` in UTC — e.g. `1.0.26.08.14.07.06`.
///
/// Stamped by `build.rs` at compile time. Its job is to make "did that deploy actually go out?"
/// answerable by looking, instead of by remembering: the Rust artifact and the frontend bundle ship
/// on separate paths and either one can be left behind.
pub const BUILD_VERSION: &str = env!("FIREBAT_BUILD");

#[cfg(test)]
mod build_version_tests {
    /// `1.0.26.08.14.07.06` — product, then year/month/day/hour/minute. Asserted because a stamp
    /// that silently degrades to a placeholder would still compile and would still look like a
    /// version on the screen where the deploy question gets answered.
    #[test]
    fn the_build_stamp_has_the_documented_shape() {
        let parts: Vec<&str> = super::BUILD_VERSION.split('.').collect();
        assert_eq!(parts.len(), 7, "got {:?}", super::BUILD_VERSION);
        for (i, p) in parts.iter().enumerate() {
            assert!(
                p.chars().all(|c| c.is_ascii_digit()),
                "segment {i} is not numeric in {:?}",
                super::BUILD_VERSION
            );
        }
        // The five stamp segments are fixed-width, so string comparison orders builds by time.
        assert!(
            parts[2..].iter().all(|p| p.len() == 2),
            "stamp segments must be zero-padded: {:?}",
            super::BUILD_VERSION
        );
    }
}

pub mod ports;
pub mod principal;
pub mod core_facade;
pub mod managers;
pub mod grpc;
pub mod i18n;
pub mod prompt_store;
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

//! Firebat Infra — port 의 실 구현 (adapters + LLM + image_gen).
//!
//! Phase B-4 cutover (TS 폐기 후 Rust 단일).
//! Hexagonal:
//!  - `core` crate 가 trait (port) 정의
//!  - `infra` crate (이 crate) 가 trait 의 실 구현 + main binary
//!  - 의존 단방향 `infra → core`

pub mod adapters;
pub mod llm;
pub mod image_gen;

/// Generated proto module — `firebat_core::proto` 의 re-export.
/// infra 는 자체 build.rs 없음 — core 가 proto 컴파일 담당.
pub use firebat_core::proto;

/// 버전 — main.rs 가 startup 로그에 사용.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

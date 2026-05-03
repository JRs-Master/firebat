//! Firebat Core — Rust backend library (v1.0 Final Phase B target).
//!
//! 두 build target 단일 codebase:
//!  - `lib`        : Phase D self-installed 시 Tauri 안에 in-process embed.
//!  - `[[bin]]`    : Phase C self-hosted 시 단일 binary (gRPC server, port 50051).
//!
//! Phase A (현재) — backbone preparation only. 실제 매니저 / 어댑터 로직은 Phase B 에서.

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
}

//! EnvConfigAdapter — IConfigPort 의 env 호출 구현 (2026-05-13 Hexagonal 정공).
//!
//! 옛 core 가 std::env::var 직접 호출하던 영역 (FIREBAT_MCP_BASE_URL / FIREBAT_DATA_DIR 등) 추상화.
//! Core 가 fs/env 0 — BIBLE Hexagonal 원칙 준수.

use firebat_core::ports::IConfigPort;

pub struct EnvConfigAdapter;

impl EnvConfigAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for EnvConfigAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl IConfigPort for EnvConfigAdapter {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

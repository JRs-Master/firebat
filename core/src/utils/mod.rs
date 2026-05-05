//! Core utilities — pure 함수 집합. 의존성 0 — Core / Manager 양쪽에서 import.

pub mod path_resolve;
pub mod condition;
pub mod pipeline_resolver;
pub mod sanitize;
pub mod render_map;
pub mod tool_cache;
pub mod pending_tools;
pub mod plan_store;
pub mod message_merge;
pub mod tag_utils;
pub mod http_client;
pub mod sysmod_cache;

/// 테스트 직렬화용 — `pending_tools` / `plan_store` 가 같은 `FIREBAT_DATA_DIR` env var 를
/// 변경하므로 cross-module 직렬화 필요. 두 module 의 tests 가 같은 lock 사용.
/// `lock_poisoned` 는 무시 (panic 한 테스트의 영향 억제).
#[cfg(test)]
pub(crate) fn shared_test_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

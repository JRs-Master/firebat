//! 시간 유틸 — unix epoch ms 단일 source.
//!
//! 코드베이스 전반에 흩어진 `SystemTime::now().duration_since(UNIX_EPOCH)...`
//! 패턴의 단일 구현. `now_ms_i64` / `now_ms_u64` 두 변형 제공 — 기존 타입 호환.

use std::time::{SystemTime, UNIX_EPOCH};

/// 현재 unix epoch ms (i64) — DB 타임스탬프, AuthSession, StatusManager 등 내부 전반.
///
/// `SystemTime::now()` 이 UNIX_EPOCH 이전으로 돌아가는 일은 현실에서 없으므로
/// `unwrap_or(0)` 폴백은 안전망 용도만.
#[inline]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 현재 unix epoch ms (u64) — PendingTool / StoredPlan 등 JS `Date.now()` 호환 필드.
#[inline]
pub fn now_ms_u64() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

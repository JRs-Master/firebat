//! 시간 유틸 — unix epoch ms 단일 source + 시간 상수.
//!
//! 코드베이스 전반에 흩어진 `SystemTime::now().duration_since(UNIX_EPOCH)...`
//! 패턴의 단일 구현. `now_ms_i64` / `now_ms_u64` 두 변형 제공 — 기존 타입 호환.
//!
//! 시간 상수 (ms / sec) — magic number (`60 * 1000` / `24 * 60 * 60` 등) 통합. Auth manager 등
//! 매니저별 const 가 본 모듈 활용 가능: `pub const SESSION_TTL_MS: i64 = 24 * HOUR_MS;`

use std::time::{SystemTime, UNIX_EPOCH};

// ─── ms 단위 (i64) ──────────────────────────────────────────────────────
pub const SECOND_MS: i64 = 1_000;
pub const MINUTE_MS: i64 = 60 * SECOND_MS;
pub const HOUR_MS: i64 = 60 * MINUTE_MS;
pub const DAY_MS: i64 = 24 * HOUR_MS;
pub const WEEK_MS: i64 = 7 * DAY_MS;

// ─── sec 단위 (u64) ─────────────────────────────────────────────────────
pub const MINUTE_SEC: u64 = 60;
pub const HOUR_SEC: u64 = 60 * MINUTE_SEC;
pub const DAY_SEC: u64 = 24 * HOUR_SEC;
pub const WEEK_SEC: u64 = 7 * DAY_SEC;

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

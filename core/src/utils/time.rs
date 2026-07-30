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

/// Parses a tool argument that names a point in time into epoch ms.
///
/// Accepts what a model actually sends when asked about a period: a bare date (`2026-07-31`), a date
/// and time (`2026-07-31 09:00`, `T` separator equally), or epoch ms as either a number or a string.
/// Anything else is None, which callers treat as "no bound" rather than an error — a malformed bound
/// silently returning everything is better than failing a lookup the caller could still answer.
///
/// Dates carry no zone, so they are read as UTC. The server runs UTC, which is also what the stored
/// timestamps are, so a bound and the rows it filters agree.
pub fn parse_time_bound(v: Option<&serde_json::Value>) -> Option<i64> {
    let v = v?;
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    let s = v.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(n) = s.parse::<i64>() {
        return Some(n);
    }
    let digits: Vec<i64> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse::<i64>().unwrap_or(0))
        .collect();
    if digits.len() < 3 {
        return None;
    }
    let (y, mo, d) = (digits[0], digits[1], digits[2]);
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    let (h, mi) = (digits.get(3).copied().unwrap_or(0), digits.get(4).copied().unwrap_or(0));
    // Days since the epoch — Howard Hinnant's civil-days algorithm, valid for any proleptic
    // Gregorian date, so no calendar table and no dependency.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000)
}

#[cfg(test)]
mod time_bound_tests {
    use super::parse_time_bound;

    fn at(s: &str) -> Option<i64> {
        parse_time_bound(Some(&serde_json::Value::String(s.to_string())))
    }

    #[test]
    fn epoch_start_and_known_dates() {
        assert_eq!(at("1970-01-01"), Some(0));
        // 2026-07-31T00:00:00Z
        assert_eq!(at("2026-07-31"), Some(1_785_456_000_000));
        assert_eq!(at("2026-07-31 09:00"), Some(1_785_456_000_000 + 9 * 3_600_000));
        assert_eq!(at("2026-07-31T09:00:00Z"), Some(1_785_456_000_000 + 9 * 3_600_000));
    }

    #[test]
    fn leap_day_lands_between_its_neighbours() {
        let feb28 = at("2024-02-28").unwrap();
        let feb29 = at("2024-02-29").unwrap();
        let mar01 = at("2024-03-01").unwrap();
        assert_eq!(feb29 - feb28, 86_400_000);
        assert_eq!(mar01 - feb29, 86_400_000);
    }

    #[test]
    fn epoch_ms_passes_through_either_shape() {
        assert_eq!(parse_time_bound(Some(&serde_json::json!(1_785_456_000_000i64))), Some(1_785_456_000_000));
        assert_eq!(at("1785456000000"), Some(1_785_456_000_000));
    }

    #[test]
    fn nonsense_is_no_bound_rather_than_an_error() {
        assert_eq!(at("작년"), None);
        assert_eq!(at(""), None);
        assert_eq!(at("2026-13-40"), None);
        assert_eq!(parse_time_bound(None), None);
    }
}

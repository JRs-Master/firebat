//! The one place a timezone is decided, and the one place a wall clock is written.
//!
//! Two rules, and everything here exists to make them impossible to get wrong:
//!
//! 1. **Stored and compared in UTC.** An epoch millisecond means the same thing everywhere, has no
//!    offset to lose and no daylight saving to step on.
//! 2. **A calendar concept is resolved in the owner's zone.** "Today", "the 5th", "this month" are
//!    not properties of an instant — they are properties of a person's calendar, and the only
//!    correct answer comes from that person's zone. The resolution happens here, at the edge, and
//!    what comes out is a UTC instant again.
//!
//! The functions take an **owner, never a timezone**. A caller that could pass a zone could pass
//! the wrong one; a caller that cannot, cannot. That is the whole reason for the shape.
//!
//! Rendering is RFC-3339 with the offset spelled out and the zone named after it:
//! `2026-08-03T23:41:12+09:00 (Asia/Seoul)`. A bare `23:41` is the shape that caused the damage —
//! it reads as local to whoever is looking, and both a person and a model will assume their own.
//! An offset in the text cannot be misread. The offset is *rendered*, never *stored* as the
//! authority: `UTC+9` is a fixed number and a zone is a rule, so for any zone with daylight saving
//! a stored offset is wrong half the year.
//!
//! Vault key single source — `vault_keys.rs::VK_SYSTEM_TIMEZONE`.

use chrono::{DateTime, Datelike, Duration, NaiveDate, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use std::sync::Arc;

use crate::ports::IVaultPort;
use crate::vault_keys::VK_SYSTEM_TIMEZONE;

/// The fallback of last resort. Only reached when nothing is configured at all.
const DEFAULT_TZ: Tz = Tz::Asia__Seoul;

/// The zone that decides an owner's calendar.
///
/// `<owner>:timezone` first, then the global `system:timezone`, then Asia/Seoul. The per-owner key
/// is what lets two hub sessions in different places each get their own day boundary without any
/// other code learning that owners exist — the same shape the per-owner user prompt already uses.
/// `None` means the operator, which is the global key.
pub fn resolve_tz(vault: &Arc<dyn IVaultPort>, owner: Option<&str>) -> Tz {
    let owned = owner
        .filter(|o| !o.is_empty() && *o != "admin")
        .and_then(|o| vault.get_secret(&format!("{o}:timezone")))
        .filter(|s| !s.is_empty());
    let global = || vault.get_secret(VK_SYSTEM_TIMEZONE).filter(|s| !s.is_empty());
    match owned.or_else(global) {
        Some(s) => s.parse::<Tz>().unwrap_or(DEFAULT_TZ),
        None => DEFAULT_TZ,
    }
}

/// The operator's zone. Kept so existing callers read the same as they did.
pub fn resolve_user_tz(vault: &Arc<dyn IVaultPort>) -> Tz {
    resolve_tz(vault, None)
}

/// Epoch milliseconds → a string that cannot be misread: RFC-3339 with the offset, zone named.
pub fn render_ms(ms: i64, tz: Tz) -> String {
    let at = Utc.timestamp_millis_opt(ms).single().unwrap_or_else(Utc::now);
    render(at, tz)
}

/// An instant → `2026-08-03T23:41:12+09:00 (Asia/Seoul)`.
pub fn render(at: DateTime<Utc>, tz: Tz) -> String {
    let local = at.with_timezone(&tz);
    format!("{} ({})", local.format("%Y-%m-%dT%H:%M:%S%:z"), tz.name())
}

/// The same instant with the weekday, for a reader that has to do calendar arithmetic.
///
/// The weekday is not decoration: without it a model works the day out from the date and gets it
/// wrong (measured 2026-07-06 — a Monday computed as a weekend, and a market called closed).
pub fn render_with_weekday(at: DateTime<Utc>, tz: Tz) -> String {
    let local = at.with_timezone(&tz);
    format!(
        "{} ({})",
        local.format("%Y-%m-%dT%H:%M:%S%:z (%a)"),
        tz.name()
    )
}

/// Midnight of `at`'s day in `tz`, as epoch ms.
///
/// This is the function whose absence cost real money: a daily loss limit was reading the *process*
/// zone, so on a UTC host "today" began at 09:00 in Seoul — the limit reset at the opening bell
/// instead of at midnight, and a trading window ended nine hours late.
pub fn day_start_ms(at: DateTime<Utc>, tz: Tz) -> i64 {
    let local = at.with_timezone(&tz);
    day_start_of_date(local.date_naive(), tz)
}

/// Midnight of a calendar date in `tz`, as epoch ms.
///
/// A date a person typed — `activeUntil: 2026-08-05` — means midnight where they are.
pub fn parse_day_ms(text: &str, tz: Tz) -> Option<i64> {
    let cleaned = text.trim().replace('/', "-");
    let date = NaiveDate::parse_from_str(&cleaned, "%Y-%m-%d").ok()?;
    Some(day_start_of_date(date, tz))
}

/// Midnight in `tz` for a date, resolving the two ways a local midnight can fail to exist.
fn day_start_of_date(date: NaiveDate, tz: Tz) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).unwrap_or_else(|| {
        date.and_hms_opt(0, 0, 1).expect("a date has a first second")
    });
    match tz.from_local_datetime(&naive) {
        // Ambiguous — a clock went back and this wall time happened twice. The earlier one is the
        // start of the day.
        chrono::LocalResult::Ambiguous(first, _) => first.with_timezone(&Utc).timestamp_millis(),
        chrono::LocalResult::Single(t) => t.with_timezone(&Utc).timestamp_millis(),
        // Nonexistent — a clock jumped forward over midnight itself (it happens: Cuba, Chile,
        // Lebanon have all done it). The day starts when the clock resumes, so step forward until
        // a real instant exists rather than falling back to UTC and being a whole day out.
        chrono::LocalResult::None => {
            let mut probe = naive;
            for _ in 0..(4 * 60) {
                probe += Duration::minutes(1);
                if let chrono::LocalResult::Single(t) = tz.from_local_datetime(&probe) {
                    return t.with_timezone(&Utc).timestamp_millis();
                }
                if let chrono::LocalResult::Ambiguous(t, _) = tz.from_local_datetime(&probe) {
                    return t.with_timezone(&Utc).timestamp_millis();
                }
            }
            naive.and_utc().timestamp_millis()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Tz;

    /// Instants are built from a date here rather than written as epoch numbers. A hand-computed
    /// epoch cannot be read back or checked by eye, and every one of the four this test first
    /// carried was wrong — which is the same failure the module is about.
    fn utc_at(y: i32, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> DateTime<Utc> {
        NaiveDate::from_ymd_opt(y, m, d)
            .and_then(|d| d.and_hms_opt(hh, mm, ss))
            .expect("a valid instant")
            .and_utc()
    }

    #[test]
    fn a_rendered_time_names_its_offset_and_its_zone() {
        let at = utc_at(2026, 8, 3, 14, 41, 12);
        let seoul = render(at, Tz::Asia__Seoul);
        assert!(seoul.contains("+09:00"), "{seoul}");
        assert!(seoul.contains("(Asia/Seoul)"), "{seoul}");
        assert!(seoul.starts_with("2026-08-03T23:41:12"), "{seoul}");
        // The same instant, another zone: the wall clock moves and the offset says so.
        let utc = render(at, Tz::UTC);
        assert!(utc.contains("+00:00"), "{utc}");
        assert!(utc.starts_with("2026-08-03T14:41:12"), "{utc}");
        // And the round trip through epoch ms, which is how everything is stored.
        assert_eq!(render_ms(at.timestamp_millis(), Tz::Asia__Seoul), seoul);
    }

    /// The bug this module exists for. On a UTC host the old code read the process zone, so a
    /// "daily" limit ran 09:00→09:00 in Seoul.
    #[test]
    fn a_day_starts_at_midnight_where_the_owner_is() {
        // Already the 3rd in UTC, and 09:30 on the 3rd in Seoul — the two calendars agree on the
        // date here and still disagree on when the day began.
        let at = utc_at(2026, 8, 3, 0, 30, 0);
        let seoul_start = day_start_ms(at, Tz::Asia__Seoul);
        let utc_start = day_start_ms(at, Tz::UTC);
        assert_eq!(seoul_start, utc_at(2026, 8, 2, 15, 0, 0).timestamp_millis());
        assert_eq!(utc_start, utc_at(2026, 8, 3, 0, 0, 0).timestamp_millis());
        assert_eq!(utc_start - seoul_start, 9 * 3600 * 1000);
        // Whichever zone, the day it names has already started.
        assert!(seoul_start <= at.timestamp_millis());
        assert!(utc_start <= at.timestamp_millis());
    }

    #[test]
    fn a_typed_date_means_midnight_where_the_owner_is() {
        let seoul = parse_day_ms("2026-08-05", Tz::Asia__Seoul).expect("a date parses");
        let utc = parse_day_ms("2026/08/05", Tz::UTC).expect("slashes parse too");
        assert_eq!(seoul, utc_at(2026, 8, 4, 15, 0, 0).timestamp_millis());
        // Nine hours apart, and Seoul's midnight is the earlier instant.
        assert_eq!(utc - seoul, 9 * 3600 * 1000);
        assert!(parse_day_ms(" 2026-08-05 ", Tz::UTC).is_some(), "padding is not an error");
        assert!(parse_day_ms("8월5일", Tz::Asia__Seoul).is_none());
        assert!(parse_day_ms("", Tz::Asia__Seoul).is_none());
    }

    /// A zone with daylight saving is the reason the authority is a zone and not an offset: the
    /// same wall clock is a different instant in January and in July.
    #[test]
    fn a_zone_is_not_an_offset() {
        let winter = parse_day_ms("2026-01-15", Tz::America__New_York).expect("a date");
        let summer = parse_day_ms("2026-07-15", Tz::America__New_York).expect("a date");
        let off = |ms: i64| {
            let local = Utc.timestamp_millis_opt(ms).single().expect("an instant")
                .with_timezone(&Tz::America__New_York);
            local.format("%:z").to_string()
        };
        assert_eq!(off(winter), "-05:00");
        assert_eq!(off(summer), "-04:00");
    }
}

/// What a zone is doing right now — the answer a screen needs to name the clock it is drawing.
///
/// A zone name is not a time. `America/New_York` is UTC−5 in January and UTC−4 in July, so a
/// schedule written against it moves an hour twice a year relative to a zone that never shifts,
/// and Seoul never shifts. A reader looking at a fire time cannot tell any of that from the name.
///
/// This lives here because it is a fact about time, not about a panel: the same zone rules the
/// scheduler evaluates against decide it, and a second implementation somewhere else is a second
/// answer waiting to disagree. Screens render what this returns.
///
/// Daylight saving moves the clock forward, so the standard offset is the smaller of the year's
/// two — which is why this reads January and July and takes the minimum rather than assuming the
/// northern hemisphere. Sydney is on summer time in January, and the same line gets it right.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneClock {
    pub zone: String,
    /// Does this zone shift at some point in the year.
    pub observes_dst: bool,
    /// Is the shift in force at this instant.
    pub dst_active: bool,
    /// `EDT`, `KST` — whatever the zone database calls it right now.
    pub abbr: String,
    /// Minutes east of UTC at this instant: `540` for Seoul, `-240` for New York in summer.
    pub offset_minutes: i32,
    /// `+09:00` — the same offset, spelled for a reader.
    pub offset: String,
}

pub fn zone_clock(zone: Tz, at: DateTime<Utc>) -> ZoneClock {
    let offset_at = |ms: DateTime<Utc>| -> i32 {
        ms.with_timezone(&zone).offset().fix().local_minus_utc() / 60
    };
    let year = at.with_timezone(&zone).year();
    // Mid-month on purpose: a transition never lands there, so neither sample is ambiguous.
    let sample = |month: u32| -> DateTime<Utc> {
        NaiveDate::from_ymd_opt(year, month, 15)
            .and_then(|d| d.and_hms_opt(12, 0, 0))
            .map(|dt| Utc.from_utc_datetime(&dt))
            .unwrap_or(at)
    };
    let jan = offset_at(sample(1));
    let jul = offset_at(sample(7));
    let now = offset_at(at);
    let standard = jan.min(jul);
    let sign = if now < 0 { '-' } else { '+' };
    let abs = now.abs();
    ZoneClock {
        zone: zone.name().to_string(),
        observes_dst: jan != jul,
        dst_active: now > standard,
        abbr: at.with_timezone(&zone).format("%Z").to_string(),
        offset_minutes: now,
        offset: format!("{sign}{:02}:{:02}", abs / 60, abs % 60),
    }
}

#[cfg(test)]
mod zone_clock_tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.from_utc_datetime(
            &NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(12, 0, 0).unwrap(),
        )
    }

    #[test]
    fn a_zone_that_never_shifts_says_so() {
        for month in [1u32, 7] {
            let c = zone_clock(Tz::Asia__Seoul, at(2026, month, 15));
            assert!(!c.observes_dst, "Seoul does not observe DST");
            assert!(!c.dst_active);
            assert_eq!(c.offset, "+09:00");
        }
    }

    #[test]
    fn new_york_shifts_and_the_badge_follows_the_season() {
        let winter = zone_clock(Tz::America__New_York, at(2026, 1, 15));
        let summer = zone_clock(Tz::America__New_York, at(2026, 7, 15));
        assert!(winter.observes_dst && summer.observes_dst);
        assert!(!winter.dst_active, "January is standard time");
        assert!(summer.dst_active, "July is daylight time");
        assert_eq!(winter.offset, "-05:00");
        assert_eq!(summer.offset, "-04:00");
    }

    #[test]
    fn the_southern_hemisphere_is_not_assumed_away() {
        // The whole reason the standard offset is the year's minimum rather than January's.
        let jan = zone_clock(Tz::Australia__Sydney, at(2026, 1, 15));
        let jul = zone_clock(Tz::Australia__Sydney, at(2026, 7, 15));
        assert!(jan.dst_active, "Sydney is on summer time in January");
        assert!(!jul.dst_active, "and off it in July");
    }
}

//! Row slicing — ONE engine, two callers.
//!
//! The render layer has been able to say "the most recent 25 rows of that cached table" since
//! 2026-07-07 (`dataCacheKey` + `dataLimit`/`dataRange`, added when a "최근 3개월" request rendered
//! as a 600-candle chart). Module inputs could not: `cacheInputs` expansion always injected the
//! FULL rows, and the docs contract said so in as many words. A model that wanted a window had
//! exactly one way to express it — hand-typing the rows — and that is what it did, every time
//! (measured 2026-08-12: it read the tail with `cache_read {limit, offset}`, then typed 23 rows
//! into a 3.5KB `sheets` string that broke mid-serialization at char 1828).
//!
//! So the vocabulary moves here and both sides speak it: same words, same semantics, one
//! implementation. What differs is only the FAILURE POLICY, and that difference is deliberate —
//! see `Sliced::range_emptied`.

use serde_json::Value;

/// Digits-only compare key: "2026-04-07" / "20260407" / "2026-04-07T09:30" all order correctly
/// under prefix-truncated lexicographic compare.
pub fn date_compare_key(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// A row's date-ish value as a compare key. Broker/yfinance normalization uses `date`; small
/// generic fallback list for other cached shapes.
pub fn row_date_key(row: &Value) -> Option<String> {
    for k in ["date", "datetime", "dt", "timestamp"] {
        match row.get(k) {
            Some(Value::String(s)) if !s.is_empty() => return Some(date_compare_key(s)),
            Some(Value::Number(n)) => return Some(format!("{:020}", n.as_i64().unwrap_or(0))),
            _ => {}
        }
    }
    None
}

/// Prefix-truncated compare — "202604070930" vs bound "20260407" compares on the first 8 digits,
/// so a `to` date includes that whole day.
fn date_in_bound(row_key: &str, bound: &str, is_from: bool) -> bool {
    let n = bound.len().min(row_key.len());
    let prefix = &row_key[..n];
    if is_from { prefix >= bound } else { prefix <= bound }
}

/// A slice plus the one fact the caller must decide about.
pub struct Sliced {
    pub rows: Vec<Value>,
    /// The range matched nothing, so the rows below are UNFILTERED. Reported, not decided: a
    /// chart that blanks is a worse answer than an unfiltered chart, but a document that silently
    /// carries 500 rows under a "최근 15일" label is a lie the reader cannot see. Render keeps the
    /// full set and warns; a module input refuses.
    pub range_emptied: bool,
}

/// The rows' first and last date key, for an error that can name the span that DOES exist.
pub fn date_span(rows: &[Value]) -> Option<(String, String)> {
    let first = rows.iter().find_map(row_date_key)?;
    let last = rows.iter().rev().find_map(row_date_key)?;
    Some(if first <= last { (first, last) } else { (last, first) })
}

/// Applies `from`/`to` (filter by the row's date field) and then `limit` (keep the most recent N).
///
/// Order-aware: newest-first rows (kiwoom) take the head, oldest-first (yfinance) take the tail,
/// and rows without dates take the tail as a stable default. Idempotent — re-slicing an already
/// sliced set is a no-op.
pub fn slice_rows(
    rows: Vec<Value>,
    limit: Option<usize>,
    from: Option<&str>,
    to: Option<&str>,
) -> Sliced {
    let mut rows = rows;
    let mut range_emptied = false;
    let from = from.map(date_compare_key).filter(|s| !s.is_empty());
    let to = to.map(date_compare_key).filter(|s| !s.is_empty());
    if from.is_some() || to.is_some() {
        let filtered: Vec<Value> = rows
            .iter()
            .filter(|r| {
                let Some(key) = row_date_key(r) else { return true };
                let from_ok = from.as_deref().map(|f| date_in_bound(&key, f, true)).unwrap_or(true);
                let to_ok = to.as_deref().map(|t| date_in_bound(&key, t, false)).unwrap_or(true);
                from_ok && to_ok
            })
            .cloned()
            .collect();
        if filtered.is_empty() {
            range_emptied = true;
        } else {
            rows = filtered;
        }
    }
    if let Some(limit) = limit {
        if limit > 0 && rows.len() > limit {
            let newest_first = match (row_date_key(&rows[0]), row_date_key(&rows[rows.len() - 1])) {
                (Some(a), Some(b)) => a > b,
                _ => false,
            };
            rows = if newest_first {
                rows[..limit].to_vec()
            } else {
                rows[rows.len() - limit..].to_vec()
            };
        }
    }
    Sliced { rows, range_emptied }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bars(dates: &[&str]) -> Vec<Value> {
        dates.iter().map(|d| json!({ "date": *d, "close": 1 })).collect()
    }

    #[test]
    fn limit_keeps_the_most_recent_rows_whichever_way_they_are_sorted() {
        let oldest_first = bars(&["2026-08-01", "2026-08-02", "2026-08-03"]);
        let out = slice_rows(oldest_first, Some(2), None, None);
        assert_eq!(out.rows[0]["date"], "2026-08-02", "oldest-first takes the tail");
        assert_eq!(out.rows.len(), 2);

        let newest_first = bars(&["2026-08-03", "2026-08-02", "2026-08-01"]);
        let out = slice_rows(newest_first, Some(2), None, None);
        assert_eq!(out.rows[0]["date"], "2026-08-03", "newest-first takes the head");
        assert_eq!(out.rows.len(), 2);
    }

    #[test]
    fn range_filters_by_date_and_a_to_bound_includes_that_whole_day() {
        let rows = bars(&["2026-08-01", "2026-08-02T15:30", "2026-08-03"]);
        let out = slice_rows(rows, None, Some("2026-08-02"), Some("20260802"));
        assert_eq!(out.rows.len(), 1);
        assert_eq!(out.rows[0]["date"], "2026-08-02T15:30");
        assert!(!out.range_emptied);
    }

    /// The empty-range fact is REPORTED, never silently decided — the two callers answer it
    /// differently and both answers must stay possible.
    #[test]
    fn an_empty_range_reports_itself_and_leaves_the_rows_unfiltered() {
        let rows = bars(&["2026-08-01", "2026-08-02"]);
        let out = slice_rows(rows, None, Some("2027-01-01"), None);
        assert!(out.range_emptied);
        assert_eq!(out.rows.len(), 2, "unfiltered — the caller decides what that means");
    }

    #[test]
    fn the_span_of_the_rows_is_nameable_for_an_error_message() {
        let (from, to) = date_span(&bars(&["2026-08-03", "2026-08-01"])).unwrap();
        assert_eq!((from.as_str(), to.as_str()), ("20260801", "20260803"));
        assert!(date_span(&[json!({"x": 1})]).is_none());
    }
}

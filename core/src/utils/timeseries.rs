//! Timeseries permanent store — declarative spec parsing + date normalization (pure).
//!
//! A module opts in via a `timeseries` block in config.json (per action):
//! ```json
//! "timeseries": {
//!   "history": {
//!     "idParams": {"symbol": "", "interval": "1d"},
//!     "startParam": "start", "endParam": "end",
//!     "paramFormat": "YYYY-MM-DD",
//!     "dateField": "date",
//!     "rows": ["$", "_cache.records"]
//!   }
//! }
//! ```
//! ModuleManager.run parses this into a `TsSpec` (pure data) and passes it via
//! `SandboxExecuteOpts.timeseries`; the sandbox choke-point does gap-narrowing/merge/serve.
//! Not declared / no explicit range / `limit` present = None (bypass — 기존 30분 ephemeral).

use crate::ports::{TsMode, TsSpec};

/// Flexible date normalization — keep digits, require >= 8 (yyyymmdd), zero-pad to 14
/// (yyyymmddHHMMSS). Handles "2026-07-04", "20260704", ISO datetimes ("2026-07-04T09:30:00+09:00"
/// → first 14 digits). Returns None when fewer than 8 digits (not a date).
pub fn normalize_date(s: &str) -> Option<i64> {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).take(14).collect();
    if digits.len() < 8 {
        return None;
    }
    let padded = format!("{digits:0<14}");
    padded.parse::<i64>().ok()
}

/// 14-digit normalized date → module param string ("YYYY-MM-DD" | "YYYYMMDD").
pub fn format_param(date14: i64, fmt: &str) -> String {
    let s = format!("{date14:014}");
    let (y, m, d) = (&s[0..4], &s[4..6], &s[6..8]);
    match fmt {
        "YYYYMMDD" => format!("{y}{m}{d}"),
        _ => format!("{y}-{m}-{d}"),
    }
}

/// Read a param that may be flat ("start") or dot-pathed into a nested envelope
/// ("query.FID_INPUT_DATE_1") — broker modules nest params under `query`/`body`. Returns the
/// scalar as a string (String verbatim / Number stringified). None if the path is absent or
/// non-scalar.
pub fn param_value(input: &serde_json::Value, path: &str) -> Option<String> {
    let mut cur = input;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    match cur {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Set a possibly dot-pathed param on an input Value, creating intermediate objects as needed
/// (mirror of `param_value` for the gap-narrow write). Flat path = top-level insert.
pub fn set_param(input: &mut serde_json::Value, path: &str, val: serde_json::Value) {
    let segs: Vec<&str> = path.split('.').collect();
    let mut cur = input;
    for (i, seg) in segs.iter().enumerate() {
        if i == segs.len() - 1 {
            if let Some(obj) = cur.as_object_mut() {
                obj.insert((*seg).to_string(), val);
            }
            return;
        }
        // ensure cur[seg] is an object, then descend
        let needs_obj = !cur.get(*seg).map(|v| v.is_object()).unwrap_or(false);
        if needs_obj {
            if let Some(obj) = cur.as_object_mut() {
                obj.insert((*seg).to_string(), serde_json::Value::Object(serde_json::Map::new()));
            } else {
                return;
            }
        }
        cur = match cur.as_object_mut().and_then(|o| o.get_mut(*seg)) {
            Some(next) => next,
            None => return,
        };
    }
}

/// Coverage clamp — completed-past boundary. now − 24h 의 자정(UTC). 마지막 일봉이
/// 미완결(장중 갱신)일 수 있어 하루 여유를 두고 그 이후는 커버로 표시하지 않는다
/// (저장은 하되 다음 조회 때 항상 재fetch = 신선도 우선, 재fetch 하루치 = 무해).
pub fn coverage_clamp_now() -> i64 {
    let yesterday = chrono::Utc::now() - chrono::Duration::hours(24);
    let s = yesterday.format("%Y%m%d").to_string();
    format!("{s}000000").parse::<i64>().unwrap_or(0)
}

/// config `timeseries` 블록 + action + input → TsSpec. 적용 불가 조건은 전부 None(bypass):
/// - 액션 미선언 / dateField·rows 누락
/// - input 에 start 없음 (period 모드 = 범위 비명시)
/// - input 에 limit 있음 (부분 rows 가 요청 range 커버로 오기록되는 것 차단)
/// - start/end 파싱 실패 또는 start >= end
/// Canonical series key from idParams (map `{param: default}` or array `[param]`) — values
/// normalized (lowercase/trim) + default substitution so "interval 생략" ≡ "1d 명시" (soft-dup
/// 차단). None if idParams absent (id 없는 시계열 = 키 충돌 위험 → 선언 강제).
fn ts_id_key(
    module: &str,
    action: &str,
    decl: &serde_json::Value,
    input: &serde_json::Value,
) -> Option<String> {
    let mut id_pairs: Vec<(String, String)> = Vec::new();
    match decl.get("idParams") {
        Some(serde_json::Value::Object(map)) => {
            for (k, default) in map {
                let val = param_value(input, k)
                    .unwrap_or_else(|| default.as_str().unwrap_or("").to_string());
                id_pairs.push((k.clone(), val.trim().to_lowercase()));
            }
        }
        Some(serde_json::Value::Array(arr)) => {
            for k in arr.iter().filter_map(|v| v.as_str()) {
                let val = param_value(input, k).unwrap_or_default().trim().to_lowercase();
                id_pairs.push((k.to_string(), val));
            }
        }
        _ => return None,
    }
    id_pairs.sort();
    Some(format!(
        "{module}:{action}:{}",
        id_pairs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("|")
    ))
}

/// 지금(+여유) — end 미지정 / cursor 최신 anchor.
fn now_plus() -> Option<i64> {
    let tomorrow = chrono::Utc::now() + chrono::Duration::hours(24);
    normalize_date(&tomorrow.format("%Y%m%d").to_string())
}

pub fn parse_ts_spec(
    ts_config: &serde_json::Value,
    module: &str,
    action: &str,
    input: &serde_json::Value,
) -> Option<TsSpec> {
    let decl = ts_config.get(action)?;
    let date_field = decl.get("dateField")?.as_str()?.to_string();
    let rows_paths: Vec<String> = decl
        .get("rows")?
        .as_array()?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    if rows_paths.is_empty() {
        return None;
    }
    let param_format = decl
        .get("paramFormat")
        .and_then(|v| v.as_str())
        .unwrap_or("YYYY-MM-DD")
        .to_string();
    let key = ts_id_key(module, action, decl, input)?;
    let cov_clamp = coverage_clamp_now();

    // ── Cursor 모드 (broker 캔들: anchor 날짜 + count) — start/end 없음 ──
    if decl.get("fetchMode").and_then(|v| v.as_str()) == Some("cursor") {
        let anchor_param = decl.get("anchorParam")?.as_str()?.to_string();
        let count_param = decl.get("countParam").and_then(|v| v.as_str()).unwrap_or("");
        let next_cursor_field = decl
            .get("nextCursorField")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // anchor = input[anchorParam](과거 페이지 요청) 또는 now(최신 요청).
        let anchor = match param_value(input, &anchor_param) {
            Some(a) => normalize_date(&a)?,
            None => now_plus()?,
        };
        let count = if count_param.is_empty() {
            0
        } else {
            param_value(input, count_param)
                .and_then(|c| {
                    c.chars()
                        .filter(|ch| ch.is_ascii_digit())
                        .collect::<String>()
                        .parse::<i64>()
                        .ok()
                })
                .unwrap_or(0)
        };
        return Some(TsSpec {
            key,
            date_field,
            rows_paths,
            start_param: String::new(),
            end_param: String::new(),
            param_format,
            start: 0,
            end: 0,
            cov_clamp,
            mode: TsMode::Cursor,
            anchor,
            count,
            anchor_param,
            next_cursor_field,
        });
    }

    // ── Range 모드 (start/end 날짜 범위) ──
    let start_param = decl
        .get("startParam")
        .and_then(|v| v.as_str())
        .unwrap_or("start")
        .to_string();
    let end_param = decl
        .get("endParam")
        .and_then(|v| v.as_str())
        .unwrap_or("end")
        .to_string();
    // limit = partial rows — coverage 오기록 위험이라 bypass.
    if input.get("limit").is_some_and(|v| !v.is_null()) {
        return None;
    }
    // 범위 명시 호출만 — start 필수, end 미지정 = 현재(+여유)까지. dot-path 지원(중첩 봉투).
    let start_raw = param_value(input, &start_param)?;
    let start = normalize_date(&start_raw)?;
    let end = match param_value(input, &end_param) {
        Some(e) => normalize_date(&e)?,
        None => now_plus()?,
    };
    if start >= end {
        return None;
    }

    Some(TsSpec {
        key,
        date_field,
        rows_paths,
        start_param,
        end_param,
        param_format,
        start,
        end,
        cov_clamp,
        mode: TsMode::Range,
        anchor: 0,
        count: 0,
        anchor_param: String::new(),
        next_cursor_field: String::new(),
    })
}

/// data 에서 rows 배열 추출 — rows_paths 후보 순서대로 ("$" = data 자체, dot-path).
pub fn extract_rows<'a>(
    data: &'a serde_json::Value,
    rows_paths: &[String],
) -> Option<&'a Vec<serde_json::Value>> {
    for path in rows_paths {
        if path == "$" {
            if let Some(arr) = data.as_array() {
                return Some(arr);
            }
            continue;
        }
        let mut cur = data;
        let mut ok = true;
        for seg in path.split('.') {
            match cur.get(seg) {
                Some(v) => cur = v,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            if let Some(arr) = cur.as_array() {
                return Some(arr);
            }
        }
    }
    None
}

/// row 에서 date_field 값 → normalized date_key.
pub fn row_date_key(row: &serde_json::Value, date_field: &str) -> Option<i64> {
    let mut cur = row;
    for seg in date_field.split('.') {
        cur = cur.get(seg)?;
    }
    match cur {
        serde_json::Value::String(s) => normalize_date(s),
        serde_json::Value::Number(n) => normalize_date(&n.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_date_formats() {
        assert_eq!(normalize_date("2026-07-04"), Some(20260704000000));
        assert_eq!(normalize_date("20260704"), Some(20260704000000));
        assert_eq!(
            normalize_date("2026-07-04T09:30:00+09:00"),
            Some(20260704093000)
        );
        assert_eq!(normalize_date("abc"), None);
        assert_eq!(normalize_date("2026-07"), None); // 6 digits
    }

    #[test]
    fn format_param_shapes() {
        assert_eq!(format_param(20260704000000, "YYYY-MM-DD"), "2026-07-04");
        assert_eq!(format_param(20260704093000, "YYYYMMDD"), "20260704");
    }

    fn cfg() -> serde_json::Value {
        json!({
            "history": {
                "idParams": {"symbol": "", "interval": "1d"},
                "startParam": "start", "endParam": "end",
                "paramFormat": "YYYY-MM-DD",
                "dateField": "date",
                "rows": ["$", "_cache.records"]
            }
        })
    }

    #[test]
    fn spec_parses_and_canonicalizes_key() {
        let input = json!({"action":"history","symbol":"005930.KS","start":"2026-01-01","end":"2026-07-01"});
        let spec = parse_ts_spec(&cfg(), "yfinance", "history", &input).unwrap();
        // interval 생략 → default 1d 치환 = 명시 1d 와 같은 키.
        assert_eq!(spec.key, "yfinance:history:interval=1d|symbol=005930.ks");
        assert_eq!(spec.start, 20260101000000);
        assert_eq!(spec.end, 20260701000000);
        let input2 = json!({"action":"history","symbol":"005930.KS","interval":"1d","start":"2026-01-01","end":"2026-07-01"});
        let spec2 = parse_ts_spec(&cfg(), "yfinance", "history", &input2).unwrap();
        assert_eq!(spec.key, spec2.key);
    }

    #[test]
    fn spec_bypasses_unsafe_calls() {
        // limit = 부분 rows → bypass
        let with_limit = json!({"symbol":"A","start":"2026-01-01","limit":50});
        assert!(parse_ts_spec(&cfg(), "m", "history", &with_limit).is_none());
        // start 없음 (period 모드) → bypass
        let no_start = json!({"symbol":"A","period":"6mo"});
        assert!(parse_ts_spec(&cfg(), "m", "history", &no_start).is_none());
        // 미선언 액션 → bypass
        let ok = json!({"symbol":"A","start":"2026-01-01"});
        assert!(parse_ts_spec(&cfg(), "m", "quote", &ok).is_none());
        // start >= end → bypass
        let inverted = json!({"symbol":"A","start":"2026-07-01","end":"2026-01-01"});
        assert!(parse_ts_spec(&cfg(), "m", "history", &inverted).is_none());
    }

    #[test]
    fn extract_rows_candidates() {
        let bare = json!([{"date":"2026-01-02"}]);
        let paths = vec!["$".to_string(), "_cache.records".to_string()];
        assert_eq!(extract_rows(&bare, &paths).unwrap().len(), 1);
        let nested = json!({"symbol":"A","_cache":{"records":[{"date":"2026-01-02"},{"date":"2026-01-03"}]}});
        assert_eq!(extract_rows(&nested, &paths).unwrap().len(), 2);
        let none = json!({"symbol":"A"});
        assert!(extract_rows(&none, &paths).is_none());
    }

    #[test]
    fn row_date_key_reads_dot_path() {
        let row = json!({"date":"2026-07-04T00:00:00+09:00","close":1.0});
        assert_eq!(row_date_key(&row, "date"), Some(20260704000000));
        let nested = json!({"t":{"d":"20260704"}});
        assert_eq!(row_date_key(&nested, "t.d"), Some(20260704000000));
    }

    #[test]
    fn param_value_flat_and_nested() {
        let v = json!({"query": {"FID_INPUT_DATE_1": "20260101"}, "start": "2026-02-02", "n": 5});
        assert_eq!(param_value(&v, "query.FID_INPUT_DATE_1").as_deref(), Some("20260101"));
        assert_eq!(param_value(&v, "start").as_deref(), Some("2026-02-02"));
        assert_eq!(param_value(&v, "n").as_deref(), Some("5")); // Number → string
        assert_eq!(param_value(&v, "query.NOPE"), None);
    }

    #[test]
    fn set_param_flat_and_nested() {
        let mut v = json!({"action": "x"});
        set_param(&mut v, "query.FID_INPUT_DATE_1", json!("20260101"));
        assert_eq!(v["query"]["FID_INPUT_DATE_1"], "20260101");
        set_param(&mut v, "flat", json!("y"));
        assert_eq!(v["flat"], "y");
        // existing nested object is preserved, not clobbered
        set_param(&mut v, "query.FID_INPUT_DATE_2", json!("20260701"));
        assert_eq!(v["query"]["FID_INPUT_DATE_1"], "20260101");
        assert_eq!(v["query"]["FID_INPUT_DATE_2"], "20260701");
    }

    #[test]
    fn spec_parses_nested_envelope() {
        // broker 스타일 — date/id 파라미터가 query 봉투 안에 중첩.
        let cfg = json!({
            "daily": {
                "idParams": {"query.FID_INPUT_ISCD": "", "query.FID_PERIOD_DIV_CODE": "D"},
                "startParam": "query.FID_INPUT_DATE_1", "endParam": "query.FID_INPUT_DATE_2",
                "paramFormat": "YYYYMMDD", "dateField": "date", "rows": ["_cache.records"]
            }
        });
        let input = json!({"action":"daily","query":{"FID_INPUT_ISCD":"005930","FID_INPUT_DATE_1":"20260101","FID_INPUT_DATE_2":"20260701"}});
        let spec = parse_ts_spec(&cfg, "korea-invest", "daily", &input).unwrap();
        assert_eq!(spec.start, 20260101000000);
        assert_eq!(spec.end, 20260701000000);
        assert!(spec.key.contains("query.fid_input_iscd=005930"));
        assert!(spec.key.contains("query.fid_period_div_code=d"));
    }

    #[test]
    fn spec_parses_cursor_mode() {
        let cfg = json!({
            "candles": {
                "fetchMode": "cursor",
                "anchorParam": "before", "countParam": "count", "nextCursorField": "nextBefore",
                "idParams": {"symbol": "", "interval": "1d"},
                "dateField": "date", "rows": ["result.candles", "records"]
            }
        });
        // 과거 페이지 (anchor 지정)
        let input = json!({"action":"candles","symbol":"005930","interval":"1d","count":200,"before":"2026-01-01"});
        let spec = parse_ts_spec(&cfg, "toss-invest", "candles", &input).unwrap();
        assert_eq!(spec.mode, TsMode::Cursor);
        assert_eq!(spec.anchor, 20260101000000);
        assert_eq!(spec.count, 200);
        assert_eq!(spec.anchor_param, "before");
        assert_eq!(spec.next_cursor_field, "nextBefore");
        // 최신 요청 (anchor 부재) → anchor = now(+여유), 여전히 cursor 모드.
        let latest = json!({"action":"candles","symbol":"005930","interval":"1d","count":200});
        let spec2 = parse_ts_spec(&cfg, "toss-invest", "candles", &latest).unwrap();
        assert_eq!(spec2.mode, TsMode::Cursor);
        assert!(spec2.anchor > 20260101000000);
    }
}

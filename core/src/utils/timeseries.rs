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

use crate::ports::TsSpec;

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
    let param_format = decl
        .get("paramFormat")
        .and_then(|v| v.as_str())
        .unwrap_or("YYYY-MM-DD")
        .to_string();

    // limit = partial rows — coverage 오기록 위험이라 bypass.
    if input.get("limit").is_some_and(|v| !v.is_null()) {
        return None;
    }
    // 범위 명시 호출만 — start 필수, end 미지정 = 현재(+여유)까지.
    let start_raw = input.get(&start_param).and_then(|v| v.as_str())?;
    let start = normalize_date(start_raw)?;
    let end = match input.get(&end_param).and_then(|v| v.as_str()) {
        Some(e) => normalize_date(e)?,
        None => {
            let tomorrow = chrono::Utc::now() + chrono::Duration::hours(24);
            normalize_date(&tomorrow.format("%Y%m%d").to_string())?
        }
    };
    if start >= end {
        return None;
    }

    // Canonical key — module:action + id params (map 형 {param: default} 또는 배열 [param]).
    // 값 정규화(lowercase/trim) + 미지정 = default 치환 → "interval 생략" 과 "1d 명시" 가
    // 같은 시계열로 수렴 (soft-dup 차단).
    let mut id_pairs: Vec<(String, String)> = Vec::new();
    match decl.get("idParams") {
        Some(serde_json::Value::Object(map)) => {
            for (k, default) in map {
                let val = input
                    .get(k)
                    .and_then(|v| match v {
                        serde_json::Value::String(s) => Some(s.clone()),
                        serde_json::Value::Number(n) => Some(n.to_string()),
                        _ => None,
                    })
                    .unwrap_or_else(|| default.as_str().unwrap_or("").to_string());
                id_pairs.push((k.clone(), val.trim().to_lowercase()));
            }
        }
        Some(serde_json::Value::Array(arr)) => {
            for k in arr.iter().filter_map(|v| v.as_str()) {
                let val = input
                    .get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_lowercase();
                id_pairs.push((k.to_string(), val));
            }
        }
        _ => return None, // id 없는 시계열 = 키 충돌 위험 → 선언 강제
    }
    id_pairs.sort();
    let key = format!(
        "{module}:{action}:{}",
        id_pairs
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("|")
    );

    Some(TsSpec {
        key,
        date_field,
        rows_paths,
        start_param,
        end_param,
        param_format,
        start,
        end,
        cov_clamp: coverage_clamp_now(),
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
}

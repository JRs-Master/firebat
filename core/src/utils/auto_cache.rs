//! The single place a large tool result becomes a cache key plus a preview.
//!
//! Every response that can be big passes through here, so no individual tool has to think about
//! size: the model always gets `_cacheKey` + `_cacheMeta`, and `cache_read` / `cache_grep` /
//! `cache_aggregate` reach the rest.
//!
//! **Why it lives in core.** It used to sit in the sandbox adapter, which made it reachable only
//! from module and WS results — `network_request`, a core tool, could not call it and returned
//! raw bodies instead. Measured 2026-08-15: a 172 KB page came back whole, the CLI clipped it to
//! the `<head>`, and the model reported the page had no timetable when it did. Nothing here
//! touches infra (`SysmodCacheAdapter` is a core type), so the choke point belongs on this side
//! and every surface — sandbox, WS, network — shares one implementation.

use crate::utils::sysmod_cache::SysmodCacheAdapter;

const AUTO_CACHE_THRESHOLD: usize = 30;
const AUTO_CACHE_PREVIEW: usize = 5;
const TEXT_CACHE_THRESHOLD: usize = 8000;
const TEXT_PREVIEW_CHARS: usize = 1500;
const AUTO_CACHE_MAX_DEPTH: usize = 4;

/// How much text goes in one row when a line is too long to be a row by itself.
///
/// Line-per-row is right for documents that have lines. A fetched web page frequently is ONE
/// line: measured 2026-08-15, a 172,201-char HTML page arrived as a single line, so "cached as
/// {line, text} rows" produced exactly one row — `cache_read` handed the whole 172 KB straight
/// back and the page stayed as unreadable as before it was cached. Splitting long lines into
/// fixed-size rows is what makes grep and paging mean something, and minified JSON or CSS needs
/// the same treatment. A keyword straddling a row boundary can be missed; the note says so.
const TEXT_CHUNK_CHARS: usize = 1000;

/// Rows for a long text field: one per line, with over-long lines split into chunks.
fn text_rows(full: &str) -> (Vec<serde_json::Value>, usize) {
    let mut rows = Vec::new();
    let mut lines = 0usize;
    for (i, line) in full.lines().enumerate() {
        // 빈/공백 줄 제외 — newline 많은 콘텐츠(마크다운·위키 등)에서 레코드 폭발 방지.
        // 2026-06-19: 56k자가 15778레코드로 터진 건. line 번호는 원본 유지(gap 허용 = 위치 정확).
        if line.trim().is_empty() {
            continue;
        }
        lines += 1;
        let chars: Vec<char> = line.chars().collect();
        if chars.len() <= TEXT_CHUNK_CHARS {
            rows.push(serde_json::json!({ "line": i + 1, "text": line }));
            continue;
        }
        for (part, chunk) in chars.chunks(TEXT_CHUNK_CHARS).enumerate() {
            rows.push(serde_json::json!({
                "line": i + 1,
                "part": part + 1,
                "text": chunk.iter().collect::<String>(),
            }));
        }
    }
    (rows, lines)
}

/// auto-cache 후보 수집 — data 객체를 (배열엔 내려가지 않고) 중첩 object 로 재귀 하강하며
/// 배열/문자열 후보의 (경로, 크기) 를 모은다. 모듈마다 envelope 모양이 달라서
/// (kiwoom/korea-invest = 스프레드 직접 자식 / toss = `result` 중첩 / 기타 임의 중첩)
/// 최상위만 보면 사각지대가 생기는 것을 일반화 (2026-07-08 — toss investor-trading 88KB
/// 가 verbatim 으로 LLM 에 들어가 Solar 128K 초과 400 난 실측 fix).
fn collect_cache_candidates(
    obj: &serde_json::Map<String, serde_json::Value>,
    depth: usize,
    path: &mut Vec<String>,
    arrays: &mut Vec<(Vec<String>, usize)>,
    strings: &mut Vec<(Vec<String>, usize)>,
) {
    for (k, v) in obj {
        // 예약 필드는 캐시 대상 아님 (명시 envelope 잔재 / 기 주입 메타)
        if k == "_cacheKey" || k == "_cacheMeta" || k == "_cache" {
            continue;
        }
        path.push(k.clone());
        match v {
            serde_json::Value::Array(a) => arrays.push((path.clone(), a.len())),
            serde_json::Value::String(s) => strings.push((path.clone(), s.chars().count())),
            serde_json::Value::Object(o) if depth + 1 < AUTO_CACHE_MAX_DEPTH => {
                collect_cache_candidates(o, depth + 1, path, arrays, strings);
            }
            _ => {}
        }
        path.pop();
    }
}

/// 경로(세그먼트 배열)로 중첩 값 mutable 접근. 세그먼트는 전부 object 키 (배열 인덱스 없음).
fn value_at_path_mut<'a>(
    root: &'a mut serde_json::Map<String, serde_json::Value>,
    path: &[String],
) -> Option<&'a mut serde_json::Value> {
    let (first, rest) = path.split_first()?;
    let mut cur = root.get_mut(first)?;
    for seg in rest {
        cur = cur.as_object_mut()?.get_mut(seg)?;
    }
    Some(cur)
}

/// How long this cached key has left, as fields the model can act on.
///
/// The TTL was invisible: a multi-round analysis fetched a long series, spent rounds on
/// discovery and arithmetic, and the cache died in between — the answer came back quietly
/// narrowed to a shorter period rather than re-fetched (measured 2026-08-05). Knowing the
/// deadline changes the order of work: compute first, narrate second.
fn expiry_fields(cache: &SysmodCacheAdapter, key: &str) -> Option<(i64, i64)> {
    let dl = cache.deadline_ms(key)?;
    let left = (dl - crate::utils::time::now_ms()) / 1000;
    Some((dl, left.max(0)))
}

/// 저장 + in-place 프리뷰 축약 + `_cacheKey` / `_cacheMeta` 형제 필드 주입 (메타는 항상 data 최상위).
///
/// 도구별 코드 0 으로 현재·미래 도구 자동 적용.
/// **중첩 스캔** (2026-07-08 일반화): 큰 필드가 `data` 직접 자식이 아니라 `data.result.records`
/// 처럼 중첩돼 있어도 찾는다 (object 로만 하강, 깊이 캡 4, 배열 안으로는 안 내려감).
/// 두 종류를 자동 인식:
/// - 큰 **배열** (≥ `AUTO_CACHE_THRESHOLD`(30) 개) → 첫 5개만 남기고 나머지 캐시 (시세 / 공시 목록 등).
/// - 큰 **문자열** (≥ `TEXT_CACHE_THRESHOLD`(8000) 자) → `{line, text}` 행으로 캐시 + 앞
///   `TEXT_PREVIEW_CHARS`(1500) 자만 프리뷰로 남김 (firecrawl 본문 / law-search 조문 / 웹 페이지).
///   `cache_grep(field="text", op="contains")` 로 키워드 검색, `cache_read` 로 범위 조회.
///
/// 룰:
/// - data 가 object 가 아니면 변형 없음
/// - `_cacheKey` 가 이미 있으면 skip (명시 envelope 처리 결과 우선)
/// - 배열 우선 — 자격 배열이 있으면 그것, 없으면 큰 문자열. 한 응답당 1개만.
///   동률이면 얕은 경로 우선. `_cacheMeta.fieldName` = 점 표기 경로 (예: "result.records").
/// - cache.data() 실패 시 원본 data 그대로 통과 (warn log)
pub fn apply_auto_cache(
    data: serde_json::Value,
    cache: &SysmodCacheAdapter,
    module_name: &str,
    input_action: &str,
) -> serde_json::Value {
    apply_auto_cache_opts(data, cache, module_name, input_action, false, false, None)
}

pub fn apply_auto_cache_opts(
    data: serde_json::Value,
    cache: &SysmodCacheAdapter,
    module_name: &str,
    input_action: &str,
    keep_full_rows: bool,
    cache_whole: bool,
    cache_whole_note: Option<&str>,
) -> serde_json::Value {
    let mut obj = match data.as_object().cloned() {
        Some(o) => o,
        None => return data,
    };
    if obj.contains_key("_cacheKey") {
        return serde_json::Value::Object(obj);
    }
    // Declared whole-object caching (`autoCacheWhole`) — a multi-section response
    // (output1..output4 style) is ONE datum. The largest-sub-array rule below would store
    // a torn-off page: the key held output3 alone, so `estimatesCacheKey` could never
    // reproduce the response and the model retyped it by hand (2026-08-11 turn 33).
    // Store the whole object as a single record; nothing inline is removed (declared
    // responses are small), the key exists so `cacheInputs` expands it back losslessly.
    if cache_whole {
        let snapshot = serde_json::Value::Object(obj.clone());
        let action_label = format!("{}:_", input_action);
        match cache.data(
            module_name,
            &action_label,
            serde_json::Value::Null,
            vec![snapshot],
            None,
        ) {
            Ok(key) => {
                obj.insert(
                    "_cacheKey".to_string(),
                    serde_json::Value::String(key.clone()),
                );
                obj.insert("_cacheMeta".to_string(), {
                    let note = match cache_whole_note {
                        Some(n) if !n.is_empty() => {
                            format!("the whole response object is cached as one record. {n}")
                        }
                        _ => "the whole response object is cached as one record — pass this key to a <param>CacheKey input that accepts this response".to_string(),
                    };
                    let mut m = serde_json::json!({
                        "sysmod": module_name,
                        "action": action_label,
                        "kind": "whole",
                        "truncated": false,
                        "autoCached": true,
                        "note": note,
                    });
                    if let Some((at, left)) = expiry_fields(cache, &key) {
                        m["expiresAt"] = serde_json::json!(at);
                        m["expiresInSec"] = serde_json::json!(left);
                    }
                    m
                });
                tracing::info!(
                    target: "auto_cache",
                    module = module_name,
                    action = input_action,
                    cache_key = %key,
                    "auto-cache applied — whole response cached (declared autoCacheWhole)"
                );
            }
            Err(e) => {
                tracing::warn!(
                    target: "auto_cache",
                    module = module_name,
                    action = input_action,
                    error = %e,
                    "auto-cache (whole) save failed — discarded"
                );
            }
        }
        return serde_json::Value::Object(obj);
    }
    let mut arrays: Vec<(Vec<String>, usize)> = Vec::new();
    let mut strings: Vec<(Vec<String>, usize)> = Vec::new();
    let mut path_buf: Vec<String> = Vec::new();
    collect_cache_candidates(&obj, 0, &mut path_buf, &mut arrays, &mut strings);

    // ── 1) array field (preferred) — largest, shallow-path on tie, ANY size (Part 2:
    //     uniform cache attaches a _cacheKey regardless of size so the model's procedure is
    //     consistent; truncation to a preview still only happens when large) ──
    let largest_arr: Option<(Vec<String>, usize)> = arrays
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.len().cmp(&a.0.len())));
    if let Some((field_path, total_count)) = largest_arr {
        let field_name = field_path.join(".");
        let records =
            match value_at_path_mut(&mut obj, &field_path).and_then(|v| v.as_array().cloned()) {
                Some(r) => r,
                None => return serde_json::Value::Object(obj),
            };
        let action_label = format!("{}:{}", input_action, field_name);
        match cache.data(
            module_name,
            &action_label,
            serde_json::Value::Null,
            records,
            None,
        ) {
            Ok(key) => {
                let truncated = total_count >= AUTO_CACHE_THRESHOLD && !keep_full_rows;
                if truncated {
                    if let Some(arr) =
                        value_at_path_mut(&mut obj, &field_path).and_then(|v| v.as_array_mut())
                    {
                        arr.truncate(AUTO_CACHE_PREVIEW);
                    }
                }
                obj.insert(
                    "_cacheKey".to_string(),
                    serde_json::Value::String(key.clone()),
                );
                let mut meta = serde_json::json!({
                    "sysmod": module_name,
                    "action": action_label,
                    "fieldName": field_name,
                    "kind": "array",
                    "totalCount": total_count,
                    "truncated": truncated,
                    "truncatedTo": if truncated { AUTO_CACHE_PREVIEW } else { total_count },
                    "autoCached": true,
                });
                if let Some((at, left)) = expiry_fields(cache, &key) {
                    meta["expiresAt"] = serde_json::json!(at);
                    meta["expiresInSec"] = serde_json::json!(left);
                }
                // Next-step pointer — without it a model re-calls the module with a larger
                // `limit` expecting more inline rows (the preview stays truncated) and burns
                // rounds hunting for the hidden data (07-11 날씨 cron 실측: limit 30→50 재호출
                // + 검색 4회 후 캡). 에러/응답 = 다음 단계 포인터 원칙.
                if truncated {
                    // The window clause is the load-bearing half. Without it the contract read
                    // as all-or-nothing, so a turn that wanted the last fifteen candles of five
                    // hundred hand-typed them — and the string broke mid-serialization
                    // (2026-08-12). Say it where the truncated preview is being read, not in a
                    // resident rule: the consumption-point channel is the one that lands.
                    meta["next"] = serde_json::Value::String(format!(
                        "Only {AUTO_CACHE_PREVIEW} of {total_count} rows are shown inline. The FULL data is already cached — page it with cache_read({{cacheKey}}) or filter rows with cache_grep({{cacheKey, field, op, value}}); numeric aggregates via cache_aggregate; to render everything use dataCacheKey in the fence. Feeding these rows to another module? Pass this key as its <param>CacheKey — and for part of the table add <param>Limit:N (the most-recent N rows) or <param>Range:{{from,to}} beside it. NEVER retype rows to trim them. Do NOT re-call the module with a larger limit — the inline preview stays truncated."
                    ));
                }
                obj.insert("_cacheMeta".to_string(), meta);
                tracing::info!(
                    target: "auto_cache",
                    module = module_name,
                    action = input_action,
                    field = %field_name,
                    cache_key = %key,
                    total = total_count,
                    truncated,
                    "auto-cache applied — array field cached"
                );
            }
            Err(e) => {
                tracing::warn!(
                    target: "auto_cache",
                    module = module_name,
                    action = input_action,
                    error = %e,
                    "auto-cache save failed — discarded"
                );
            }
        }
        return serde_json::Value::Object(obj);
    }

    // ── 2) text field — largest string ≥ 8000 chars (documents: firecrawl body, law article,
    //     a fetched web page). Small strings are NOT row-cached (a 6-char field is not a
    //     document); they fall through to the whole-object cache below, so a _cacheKey is still
    //     attached uniformly. ──
    let largest_str: Option<(Vec<String>, usize)> = strings
        .into_iter()
        .filter(|(_, l)| *l >= TEXT_CACHE_THRESHOLD)
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.len().cmp(&a.0.len())));
    if let Some((field_path, total_chars)) = largest_str {
        let field_name = field_path.join(".");
        let full = value_at_path_mut(&mut obj, &field_path)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let (records, total_lines) = text_rows(&full);
        let total_rows = records.len();
        let chunked = total_rows > total_lines;
        let action_label = format!("{}:{}", input_action, field_name);
        match cache.data(
            module_name,
            &action_label,
            serde_json::Value::Null,
            records,
            None,
        ) {
            Ok(key) => {
                let truncated = total_chars >= TEXT_CACHE_THRESHOLD;
                if truncated {
                    let mut preview: String = full.chars().take(TEXT_PREVIEW_CHARS).collect();
                    preview.push('…');
                    if let Some(slot) = value_at_path_mut(&mut obj, &field_path) {
                        *slot = serde_json::Value::String(preview);
                    }
                }
                obj.insert(
                    "_cacheKey".to_string(),
                    serde_json::Value::String(key.clone()),
                );
                let mut meta = serde_json::json!({
                    "sysmod": module_name,
                    "action": action_label,
                    "fieldName": field_name,
                    "kind": "text",
                    "grepField": "text",
                    "totalChars": total_chars,
                    "totalLines": total_lines,
                    "totalRows": total_rows,
                    "truncated": truncated,
                    "previewChars": if truncated { TEXT_PREVIEW_CHARS.min(total_chars) } else { total_chars },
                    "autoCached": true,
                });
                if let Some((at, left)) = expiry_fields(cache, &key) {
                    meta["expiresAt"] = serde_json::json!(at);
                    meta["expiresInSec"] = serde_json::json!(left);
                }
                if truncated {
                    let mut next = format!(
                        "Only a preview of the text is inline. The FULL text is cached as {total_rows} {{line, text}} rows — search it with cache_grep({{cacheKey, field:\"text\", op:\"contains\", value}}) or page it with cache_read({{cacheKey}}). Do NOT re-call the module — the inline preview stays truncated."
                    );
                    if chunked {
                        // Say it here, where the rows are about to be searched: a keyword can
                        // sit across a split and grep will not see it.
                        next.push_str(&format!(
                            " Long lines were split into rows of about {TEXT_CHUNK_CHARS} characters (a row carries `part` when it is a piece of a longer line), so a phrase landing on a boundary can be missed — search a short distinctive word rather than a sentence."
                        ));
                    }
                    meta["next"] = serde_json::Value::String(next);
                }
                obj.insert("_cacheMeta".to_string(), meta);
                tracing::info!(
                    target: "auto_cache",
                    module = module_name,
                    action = input_action,
                    field = %field_name,
                    cache_key = %key,
                    total_chars = total_chars,
                    total_lines = total_lines,
                    total_rows = total_rows,
                    chunked,
                    truncated,
                    "auto-cache applied — text field cached row-by-row"
                );
            }
            Err(e) => {
                tracing::warn!(
                    target: "auto_cache",
                    module = module_name,
                    action = input_action,
                    error = %e,
                    "auto-cache (text) save failed — discarded"
                );
            }
        }
        return serde_json::Value::Object(obj);
    }

    // ── 3) scalar-only object (no array/string field anywhere) — cache the whole object so
    //     the model's procedure stays uniform: a _cacheKey is ALWAYS present regardless of
    //     size. Nothing is removed (truncated:false) so there is no extra cache_read round;
    //     the key just lets render/dataCacheKey reference it consistently.
    let snapshot = serde_json::Value::Object(obj.clone());
    let action_label = format!("{}:_", input_action);
    match cache.data(
        module_name,
        &action_label,
        serde_json::Value::Null,
        vec![snapshot],
        None,
    ) {
        Ok(key) => {
            obj.insert(
                "_cacheKey".to_string(),
                serde_json::Value::String(key.clone()),
            );
            obj.insert("_cacheMeta".to_string(), {
                let mut m = serde_json::json!({
                    "sysmod": module_name,
                    "action": action_label,
                    "kind": "scalar",
                    "truncated": false,
                    "autoCached": true,
                });
                if let Some((at, left)) = expiry_fields(cache, &key) {
                    m["expiresAt"] = serde_json::json!(at);
                    m["expiresInSec"] = serde_json::json!(left);
                }
                m
            });
            tracing::info!(
                target: "auto_cache",
                module = module_name,
                action = input_action,
                cache_key = %key,
                "auto-cache applied — scalar object cached (uniform key)"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "auto_cache",
                module = module_name,
                action = input_action,
                error = %e,
                "auto-cache (scalar) save failed — discarded"
            );
        }
    }
    serde_json::Value::Object(obj)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_with_lines_keeps_one_row_per_line() {
        let text = (1..=40)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (rows, lines) = text_rows(&text);
        assert_eq!(lines, 40);
        assert_eq!(rows.len(), 40, "no splitting when lines are short");
        assert!(rows[0].get("part").is_none(), "unsplit rows carry no part");
    }

    #[test]
    fn one_enormous_line_becomes_many_rows() {
        // The shape a fetched web page arrives in: measured 2026-08-15, 172,201 chars, 1 line.
        let text = "x".repeat(172_201);
        let (rows, lines) = text_rows(&text);
        assert_eq!(lines, 1);
        assert_eq!(rows.len(), 173, "172201 / 1000, rounded up");
        assert_eq!(rows[0]["line"], 1);
        assert_eq!(rows[0]["part"], 1);
        assert_eq!(rows[1]["part"], 2);
        let joined: String = rows
            .iter()
            .map(|r| r["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .concat();
        assert_eq!(joined, text, "splitting loses nothing");
    }

    #[test]
    fn chunk_boundaries_do_not_split_a_character() {
        // Korean text is multi-byte; chunking by chars must not cut one in half.
        let text = "가".repeat(2_500);
        let (rows, _) = text_rows(&text);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["text"].as_str().unwrap().chars().count(), 1000);
        assert_eq!(rows[2]["text"].as_str().unwrap().chars().count(), 500);
    }

    #[test]
    fn blank_lines_are_dropped_and_numbering_stays_true() {
        let (rows, lines) = text_rows("first\n\n\nfourth");
        assert_eq!(lines, 2);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["line"], 4, "the gap is kept so positions stay right");
    }
}

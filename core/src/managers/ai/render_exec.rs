//! render 도구 실행 — blocks 검증/정규화 단일 소스.
//!
//! 두 경로가 같은 로직을 써야 한다:
//! - **ToolManager**(FC 모델 = Gemini/Vertex) — `tool_registry::register_meta_render_tools` 의 핸들러.
//! - **MCP 서버**(hosted = CLI/Anthropic/OpenAI) — `infra::mcp_server::RenderUnifiedHandler`.
//!
//! 옛에는 render 실행 본체가 infra(mcp_server) 에만 있어 FC 모델은 render 를 아예 못 불렀다(drift).
//! 본 함수로 추출해 양쪽이 호출 → 동작 일치 + drift 차단.
//!
//! 결과 = `{ success: true, blocks: [{type:"component", name, props}], failed: [...] }`.
//! block 별 graceful 처리 — 1개 block 이 hallucinate 여도 나머지 정상 block 은 표시,
//! 실패 block 만 `failed` 배열로 분리(AI 가 보고 retry 자율 결정). 전부 실패 시만 Err.

use serde_json::Value;

use super::component_registry;

/// Components still allowed via the render tool: code/markup-heavy, where quotes,
/// newlines, and backslashes are easy to break when hand-escaped inside fence JSON, so tool args (safely escaped by the FC layer) are better. All other
/// components (table/callout/text/chart/...) are **fence-only**: putting Korean in tool args
/// makes the model degrade the spelling (Korean corrupts in tool_use input). html uses the separate render_iframe path.
pub const TOOL_ALLOWED_TYPES: &[&str] = &["code", "math", "diagram"];

/// Resolves a sysmod `_cacheKey` to its full records for server-side data injection.
/// Wired by AiManager over SysmodCacheAdapter; `None` on paths without cache access.
pub type FenceDataResolver<'a> = &'a dyn Fn(&str) -> Result<Vec<Value>, String>;

/// Injection row cap — protects message size when a huge cache (e.g. line-text cache of a
/// scraped page) is referenced. Time-series keep the most recent rows (tail).
const MAX_INJECT_ROWS: usize = 5000;

/// `render` 도구 인자(`{blocks: [...]}` 또는 stringified / 배열 직접)를 검증·정규화해
/// `{success, blocks, failed}` 반환. ToolManager + MCP 공용.
///
/// `tool_mode` = true on the render **tool** path (FC/MCP). When true, fence-able components
/// (everything except code/math/diagram) are rejected, forcing the model to emit a firebat-render fence (text channel).
/// Structurally blocks Korean corruption in tool args (prompt soft-hint becomes hard enforcement). The fence path
/// (mask_and_sanitize_fences) calls with tool_mode=false, so all components pass.
///
/// `resolver` = sysmod cache lookup for `dataCacheKey` props (fence path only; tool paths pass
/// None — data-heavy components are rejected there anyway). When a block's props carry
/// `dataCacheKey`, the server injects the cached records as `props.data` so the model never
/// hand-copies large arrays (hand-copied rows get truncated and even fabricated — 2026-07-06
/// 실측: 123봉 캐시에서 74행만 베끼고 주말 날짜 봉을 지어냄).
pub fn render_blocks(
    args: &Value,
    tool_mode: bool,
    resolver: Option<FenceDataResolver>,
) -> Result<Value, String> {
    // args 형태 robustness — 일부 CLI 어댑터 / 모델이 args 를 stringified JSON 으로 보내거나
    // blocks 배열 자체를 직접 보내는 경우 수용.
    let parsed_args: Value = match args.as_str() {
        Some(s) => serde_json::from_str(s).unwrap_or_else(|_| args.clone()),
        None => args.clone(),
    };
    let blocks_val = parsed_args.get("blocks").cloned();
    let blocks_owned: Vec<Value> = if let Some(bv) = blocks_val {
        match bv {
            Value::Array(a) => a,
            Value::String(s) => serde_json::from_str::<Vec<Value>>(&s)
                .map_err(|_| "render: 'blocks' 가 array 가 아닙니다".to_string())?,
            _ => return Err("render: 'blocks' (array) 가 필요합니다".to_string()),
        }
    } else if let Value::Array(a) = &parsed_args {
        a.clone()
    } else {
        return Err("render: 'blocks' (array) 가 필요합니다".to_string());
    };
    let blocks = &blocks_owned;
    if blocks.is_empty() {
        return Err("render: 'blocks' 가 비어있습니다 (최소 1개 필요)".to_string());
    }

    // block 별 graceful 처리 — 정상은 rendered, 실패는 failed 로 분리.
    let mut rendered = Vec::with_capacity(blocks.len());
    let mut failed: Vec<Value> = Vec::new();
    for (idx, block) in blocks.iter().enumerate() {
        let block_type = match block.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => {
                failed.push(serde_json::json!({
                    "idx": idx,
                    "type": Value::Null,
                    "error": format!("blocks[{idx}]: 'type' (string) 가 필요합니다"),
                }));
                continue;
            }
        };
        let mut props = block
            .get("props")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        // 정규화 전 원본 키 — 검증 실패 진단용(synonym 매핑 필요 vs 통째 누락 구분).
        let original_keys: Vec<String> = props
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();

        let comp = match component_registry::find_component(block_type) {
            Some(c) => c,
            None => {
                failed.push(serde_json::json!({
                    "idx": idx,
                    "type": block_type,
                    "error": format!("알 수 없는 컴포넌트 '{}'. components.json 의 26 종 중 하나여야", block_type),
                }));
                continue;
            }
        };

        // Tool-path fence enforcement: components other than code/math/diagram cannot be built via the tool (Korean corruption).
        // Reject to steer the model to write a firebat-render fence directly in the reply text. The fence path passes through.
        if tool_mode && !TOOL_ALLOWED_TYPES.contains(&comp.component_type.as_str()) {
            failed.push(serde_json::json!({
                "idx": idx,
                "type": block_type,
                "error": format!(
                    "'{}' cannot be built with the render tool. Emit it as a ```firebat-render``` fenced block in your reply TEXT instead (putting it in tool args corrupts non-ASCII spelling). The render tool handles only code/math/diagram.",
                    comp.component_type
                ),
                "useFence": true,
            }));
            continue;
        }

        // dataCacheKey → server-side data injection (generic — no per-component branching).
        // The model references the sysmod `_cacheKey` instead of hand-copying rows; the full
        // cached records become `props.data`. Kills inline truncation/fabrication and the
        // token double-spend (cache_read into context + rows written back out).
        if let Some(key) = props
            .get("dataCacheKey")
            .and_then(|v| v.as_str())
            .map(String::from)
        {
            if let Some(obj) = props.as_object_mut() {
                obj.remove("dataCacheKey");
            }
            let resolved: Result<Vec<Value>, String> = match resolver {
                Some(r) => r(&key),
                None => Err("no cache resolver on this path".to_string()),
            };
            match resolved {
                Ok(records) => {
                    let rows = if records.len() > MAX_INJECT_ROWS {
                        records[records.len() - MAX_INJECT_ROWS..].to_vec()
                    } else {
                        records
                    };
                    tracing::info!(
                        target: "render",
                        cache_key = %key,
                        rows = rows.len(),
                        "[render] dataCacheKey resolved — full records injected server-side"
                    );
                    if let Some(obj) = props.as_object_mut() {
                        obj.insert("data".to_string(), Value::Array(rows));
                    }
                }
                Err(err) => {
                    let has_data = props
                        .get("data")
                        .and_then(|v| v.as_array())
                        .map(|a| !a.is_empty())
                        .unwrap_or(false);
                    if has_data {
                        // Model supplied (partial) rows alongside the key — keep them rather
                        // than dropping the whole block.
                        tracing::warn!(
                            target: "render",
                            cache_key = %key,
                            error = %err,
                            "[render] dataCacheKey resolve failed — keeping model-supplied data"
                        );
                    } else {
                        failed.push(serde_json::json!({
                            "idx": idx,
                            "type": block_type,
                            "error": format!(
                                "dataCacheKey '{key}' resolve failed: {err}. Re-run the sysmod call and use the fresh _cacheKey."
                            ),
                        }));
                        continue;
                    }
                }
            }
        }

        // AI hallucination normalize — 'name' → 'title' 매핑 후 sanitize_to_schema 재귀 정규화.
        if let Some(obj) = props.as_object_mut() {
            if !obj.contains_key("title") {
                if let Some(name_val) = obj.remove("name") {
                    obj.insert("title".to_string(), name_val);
                }
            }
        }
        component_registry::sanitize_to_schema(&mut props, &comp.props_schema);

        // propsSchema validation — only failed blocks are split out.
        if let Err(e) = crate::managers::module::validate_value(&props, &comp.props_schema) {
            // A block with no props at all (empty) has nothing to render and lost nothing — drop
            // it silently instead of logging a validation failure (avoids WARN noise from stray
            // empty blocks, e.g. an empty header the model emitted). Blocks that DID carry keys
            // but failed validation are still reported (real content was dropped → diagnose).
            if original_keys.is_empty() {
                continue;
            }
            failed.push(serde_json::json!({
                "idx": idx,
                "type": block_type,
                "error": format!("props 검증 실패: {}", e),
                "gotKeys": original_keys,
            }));
            continue;
        }

        rendered.push(serde_json::json!({
            "type": "component",
            "name": comp.component_type,
            "props": props,
        }));
    }

    // All blocks failed. If they were all fence-redirects, tell the model plainly to emit a
    // firebat-render fence in its reply text and NOT re-call the tool — the old "retry the
    // schema" wording made models re-invoke the render tool and loop. Real schema errors → retry.
    if rendered.is_empty() && !failed.is_empty() {
        let all_fence = failed
            .iter()
            .all(|f| f.get("useFence").and_then(|v| v.as_bool()).unwrap_or(false));
        if all_fence {
            return Err(
                "render: emit these components as a ```firebat-render``` fenced block in your \
                 reply TEXT — do NOT call the render tool again for them (tool args corrupt \
                 non-ASCII spelling). The render tool handles only code/math/diagram."
                    .to_string(),
            );
        }
        let summary = failed
            .iter()
            .filter_map(|f| f.get("error").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!(
            "render: all blocks failed validation ({}). Re-call matching the schema.",
            summary
        ));
    }

    // 부분 성공 진단 — 검증 실패 block 이 silent skip 되어 화면 누락되는 root cause 추적.
    if !failed.is_empty() {
        tracing::warn!(
            target: "render",
            rendered_count = rendered.len(),
            failed_count = failed.len(),
            failed = %serde_json::to_string(&failed).unwrap_or_default(),
            "[render] 일부 block 검증 실패 — silent skip (사용자 화면 미표시)"
        );
    }

    Ok(serde_json::json!({
        "success": true,
        "blocks": rendered,
        "failed": failed,
    }))
}

/// Mask `firebat-render` fences (render blocks the model wrote into its TEXT reply instead of calling
/// the `render` tool) with `@@FBRENDER<n>@@` placeholders, validating/normalizing each fence's blocks
/// through `render_blocks`. Masking protects the fence JSON from the reply post-processing that
/// follows (sanitize_reply / markdown-structure extraction would otherwise mangle the JSON's quotes,
/// brackets, `**`, `<>` etc.). Returns `(masked_text, fences)` where `fences[n]` is the rebuilt,
/// sanitized fence string to splice back via `restore_fences` after that post-processing.
///
/// Why the text channel: the model corrupts Korean spelling inside tool_use JSON arguments but not in
/// free text — so routing render through text fixes the corruption AND keeps render content inside
/// `reply`/content so it is embedded + recalled (no amnesia). See CLAUDE.md 한국어 깨짐 진단 (2026-06-17).
/// Returns `(masked_text, fences, block_groups, failed_groups)`: `fences[n]` = rebuilt sanitized fence
/// string to restore; `block_groups[n]` = the parsed/sanitized blocks array of fence n (or `Null` if it
/// failed to parse); `failed_groups[n]` = the array of blocks that FAILED validation in fence n (each
/// `{idx,type,error,gotKeys}`) — surfaced as a `success:false` "render" badge so a dropped block is
/// visible to the user, not just a journald warn (debug convenience).
pub fn mask_and_sanitize_fences(
    text: &str,
    resolver: Option<FenceDataResolver>,
) -> (String, Vec<String>, Vec<Value>, Vec<Value>) {
    const OPEN: &str = "```firebat-render";
    if !text.contains(OPEN) {
        return (text.to_string(), Vec::new(), Vec::new(), Vec::new());
    }
    let mut out = String::with_capacity(text.len());
    let mut store: Vec<String> = Vec::new();
    let mut block_groups: Vec<Value> = Vec::new();
    let mut failed_groups: Vec<Value> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        // Body begins right after the opening line's newline.
        let Some(nl) = after.find('\n') else {
            out.push_str(after); // unterminated fence — keep raw
            rest = "";
            break;
        };
        let body_start_rel = nl + 1;
        let body_and_rest = &after[body_start_rel..];
        let Some(close_rel) = body_and_rest.find("```") else {
            out.push_str(after); // no closing fence — keep raw
            rest = "";
            break;
        };
        let body = &body_and_rest[..close_rel];
        let (sanitized, blocks, failed) = sanitize_fence_body(body, resolver);
        store.push(format!("```firebat-render\n{}\n```", sanitized));
        block_groups.push(blocks);
        failed_groups.push(failed);
        out.push_str(&format!("@@FBRENDER{}@@", store.len() - 1));
        rest = &rest[start + body_start_rel + close_rel + 3..]; // past closing ```
    }
    out.push_str(rest);
    (out, store, block_groups, failed_groups)
}

/// Validate/normalize a fence body (a JSON array of blocks, or `{blocks:[...]}`) via `render_blocks`.
/// Returns `(json_string, blocks_value)`. On parse/validation failure, returns the trimmed original
/// string + `Null` blocks so the frontend renders it raw (visible + debuggable, never silently dropped).
fn sanitize_fence_body(body: &str, resolver: Option<FenceDataResolver>) -> (String, Value, Value) {
    let trimmed = body.trim();
    let Ok(parsed) = serde_json::from_str::<Value>(trimmed) else {
        return (trimmed.to_string(), Value::Null, Value::Null);
    };
    let args = if parsed.is_array() {
        serde_json::json!({ "blocks": parsed })
    } else {
        parsed
    };
    // Fence path, tool_mode=false: all components pass (fence is the Korean-safe channel).
    match render_blocks(&args, false, resolver) {
        Ok(result) => {
            let blocks = result.get("blocks").cloned().unwrap_or_else(|| serde_json::json!([]));
            let failed = result.get("failed").cloned().unwrap_or_else(|| serde_json::json!([]));
            let s = serde_json::to_string(&blocks).unwrap_or_else(|_| trimmed.to_string());
            (s, blocks, failed)
        }
        Err(_) => (trimmed.to_string(), Value::Null, Value::Null),
    }
}

/// Restore `@@FBRENDER<n>@@` placeholders left by `mask_and_sanitize_fences` with their sanitized
/// fence strings.
pub fn restore_fences(text: &str, fences: &[String]) -> String {
    if fences.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    for (i, fence) in fences.iter().enumerate() {
        out = out.replace(&format!("@@FBRENDER{}@@", i), fence);
    }
    out
}

/// Convert `firebat-render` fences in a message's `content` to plain human-readable text — the block
/// values only, not the JSON. Used by anything that READS chat content for memory/recall (extraction
/// transcript, embedding, history injection): with X (render lives in `content` as a fence) those
/// readers would otherwise ingest raw render JSON → noisy embeddings, mis-extracted "facts", and raw
/// JSON shown back in recall. This strips the JSON structure, keeping the Korean/text values so the
/// memory layer sees clean prose. Non-fence text passes through unchanged (additive).
pub fn fence_to_plaintext(text: &str) -> String {
    const OPEN: &str = "```firebat-render";
    if !text.contains(OPEN) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(nl) = after.find('\n') else {
            out.push_str(after);
            rest = "";
            break;
        };
        let body_and_rest = &after[nl + 1..];
        let Some(close_rel) = body_and_rest.find("```") else {
            out.push_str(after);
            rest = "";
            break;
        };
        let body = &body_and_rest[..close_rel];
        match serde_json::from_str::<Value>(body.trim()) {
            Ok(v) => {
                let mut collected = String::new();
                collect_text_values(&v, "", &mut collected);
                out.push_str(collected.trim());
            }
            // parse 실패 = 그냥 본문(JSON 마커만 떼고) — raw JSON 보다 나음.
            Err(_) => out.push_str(body.trim()),
        }
        rest = &rest[start + nl + 1 + close_rel + 3..];
    }
    out.push_str(rest);
    out
}

/// Recursively collect human-readable string values from a render block tree, skipping structural
/// identifier values (`type` / `name` = component ids like "header"/"component", pure noise).
fn collect_text_values(v: &Value, key: &str, out: &mut String) {
    match v {
        Value::String(s) => {
            if !matches!(key, "type" | "name") && !s.trim().is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(s.trim());
            }
        }
        Value::Object(o) => {
            for (k, val) in o {
                collect_text_values(val, k, out);
            }
        }
        Value::Array(a) => {
            for val in a {
                collect_text_values(val, key, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ohlcv_rows(n: usize) -> Vec<Value> {
        (0..n)
            .map(|i| {
                serde_json::json!({
                    "date": format!("2026-01-{:02}", (i % 28) + 1),
                    "open": 100.0 + i as f64, "high": 110.0 + i as f64,
                    "low": 90.0 + i as f64, "close": 105.0 + i as f64, "volume": 1000 + i
                })
            })
            .collect()
    }

    #[test]
    fn data_cache_key_injects_full_records() {
        let rows = ohlcv_rows(123);
        let rows_clone = rows.clone();
        let resolver = move |key: &str| -> Result<Vec<Value>, String> {
            assert_eq!(key, "yf-history-abc");
            Ok(rows_clone.clone())
        };
        let args = serde_json::json!({
            "blocks": [{"type": "stock_chart", "props": {"symbol": "005930.KS", "dataCacheKey": "yf-history-abc"}}]
        });
        let out = render_blocks(&args, false, Some(&resolver)).unwrap();
        let blocks = out["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        let props = &blocks[0]["props"];
        assert!(props.get("dataCacheKey").is_none(), "key removed after injection");
        assert_eq!(props["data"].as_array().unwrap().len(), 123);
    }

    #[test]
    fn data_cache_key_resolve_failure_without_data_fails_block() {
        let resolver =
            |_: &str| -> Result<Vec<Value>, String> { Err("cache expired".to_string()) };
        let args = serde_json::json!({
            "blocks": [{"type": "stock_chart", "props": {"symbol": "A", "dataCacheKey": "gone"}}]
        });
        // 유일 블록이 실패 → 전체 Err 로 모델에 재시도 힌트.
        let err = render_blocks(&args, false, Some(&resolver)).unwrap_err();
        assert!(err.contains("dataCacheKey"), "err mentions cache: {err}");
    }

    #[test]
    fn data_cache_key_resolve_failure_keeps_model_data() {
        let resolver = |_: &str| -> Result<Vec<Value>, String> { Err("expired".to_string()) };
        let args = serde_json::json!({
            "blocks": [{"type": "stock_chart", "props": {
                "symbol": "A", "dataCacheKey": "gone",
                "data": [{"date": "2026-01-02", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10}]
            }}]
        });
        let out = render_blocks(&args, false, Some(&resolver)).unwrap();
        let props = &out["blocks"][0]["props"];
        assert_eq!(props["data"].as_array().unwrap().len(), 1, "model rows kept");
    }
}

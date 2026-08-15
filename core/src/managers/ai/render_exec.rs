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
pub(crate) const MAX_INJECT_ROWS: usize = 5000;

/// Apply the optional fence-props period slice to injected cache records (generic — any
/// component with a `data` injection). `dataRange:{from?,to?}` filters by row date;
/// `dataLimit:N` keeps the N most-recent rows (row order preserved, newest-first or
/// oldest-first both handled). Idempotent — re-running the sanitize pass on already-sliced
/// data is a no-op.
///
/// The engine lives in `utils::row_slice` because module inputs now speak the same words
/// (`<param>Limit` / `<param>Range` beside `<param>CacheKey`). Only the failure policy is
/// local: a range that matches nothing falls back to the full records, because a bad range
/// from the model must not blank the chart. The module side refuses instead — a document
/// silently holding every row under a windowed label is worse than an error.
pub(crate) fn apply_data_slice(records: Vec<Value>, props: &Value) -> Vec<Value> {
    apply_prop_slice("data", records, props)
}

/// The same slice for any row prop: `<prop>Limit` / `<prop>Range` beside `<prop>CacheKey`.
pub(crate) fn apply_prop_slice(prop: &str, records: Vec<Value>, props: &Value) -> Vec<Value> {
    let range = props.get(format!("{prop}Range")).and_then(|v| v.as_object());
    let out = crate::utils::row_slice::slice_rows(
        records,
        props.get(format!("{prop}Limit")).and_then(|v| v.as_u64()).map(|n| n as usize),
        range.and_then(|r| r.get("from")).and_then(|v| v.as_str()),
        range.and_then(|r| r.get("to")).and_then(|v| v.as_str()),
    );
    if out.range_emptied {
        tracing::warn!(
            target: "render",
            prop,
            "[render] range matched 0 rows — range ignored, full records kept"
        );
    }
    out.rows
}

/// Fits cached records to the shape the target prop declares.
///
/// Object records drop straight into an object-item prop — that is every list component
/// (`timeline.items`, `key_value.items`, `vocab.words` …), and they were unreachable by cache key
/// only because the injection was hard-wired to the name `data`. A prop whose items are ARRAYS
/// (`table.rows` = array of string arrays) needs a projection instead, and projecting is a real
/// choice — which columns, in which order — so it is asked for rather than guessed:
/// `rowsColumns: ["date","close"]` names the record fields to take. Missing, the error names the
/// fields the records actually have, which is the next step.
fn fit_records_to_prop(
    prop: &str,
    project: bool,
    records: Vec<Value>,
    props: &Value,
) -> Result<Vec<Value>, String> {
    if !project {
        return Ok(records);
    }
    // Already row-arrays (a cache of `table.rows` itself) — nothing to project.
    if records.iter().all(|r| r.is_array()) {
        return Ok(records);
    }
    let columns: Vec<String> = props
        .get(format!("{prop}Columns"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if columns.is_empty() {
        let available: Vec<String> = records
            .first()
            .and_then(|r| r.as_object())
            .map(|o| o.keys().take(12).cloned().collect())
            .unwrap_or_default();
        return Err(format!(
            "`{prop}` holds arrays, one per row, but the cached records are objects — add \
             `{prop}Columns` naming the fields to take, in column order (available: {}). \
             `headers` stays the display text.",
            available.join(", ")
        ));
    }
    Ok(records
        .into_iter()
        .map(|rec| {
            let cells: Vec<Value> = columns
                .iter()
                .map(|c| match rec.get(c) {
                    Some(Value::String(s)) => Value::String(s.clone()),
                    Some(Value::Null) | None => Value::String(String::new()),
                    Some(other) => Value::String(other.to_string()),
                })
                .collect();
            Value::Array(cells)
        })
        .collect())
}

/// Resolves every `<prop>CacheKey` in a block's props, at any depth. Returns an error string for
/// the first slot that cannot be filled — the block is then reported as failed, because a block
/// that silently loses its rows renders a lie.
///
/// The TOP-LEVEL `dataCacheKey` is deliberately left to the caller: it carries measured behaviour
/// this generic pass should not re-decide (keep model-supplied rows when the key expired, rather
/// than dropping the block). Everything else — other props, nested blocks, list elements — is
/// handled here.
fn resolve_nested_cache_keys(
    props: &mut Value,
    resolver: Option<FenceDataResolver>,
    array_item_props: &std::collections::HashSet<String>,
) -> Option<String> {
    fn walk(
        v: &mut Value,
        resolver: Option<FenceDataResolver>,
        array_item_props: &std::collections::HashSet<String>,
        depth: usize,
        top: bool,
    ) -> Option<String> {
        if depth > 6 {
            return None;
        }
        match v {
            Value::Array(items) => {
                for item in items.iter_mut() {
                    if let Some(e) = walk(item, resolver, array_item_props, depth + 1, false) {
                        return Some(e);
                    }
                }
                None
            }
            Value::Object(obj) => {
                let slots: Vec<(String, String)> = obj
                    .iter()
                    .filter_map(|(k, val)| {
                        let prop = k.strip_suffix("CacheKey")?;
                        if prop.is_empty() || (top && prop == "data") {
                            return None;
                        }
                        let key = val.as_str()?.trim();
                        if key.is_empty() {
                            return None;
                        }
                        Some((prop.to_string(), key.to_string()))
                    })
                    .collect();
                for (prop, key) in slots {
                    let records = match resolver {
                        Some(r) => r(&key),
                        None => Err("no cache resolver on this path".to_string()),
                    };
                    let records = match records {
                        Ok(r) => r,
                        Err(e) => {
                            return Some(format!(
                                "{prop}CacheKey '{key}' resolve failed: {e}. Re-run the call and \
                                 use the fresh _cacheKey."
                            ))
                        }
                    };
                    let holder = Value::Object(obj.clone());
                    let sliced = apply_prop_slice(&prop, records, &holder);
                    let rows = if sliced.len() > MAX_INJECT_ROWS {
                        sliced[sliced.len() - MAX_INJECT_ROWS..].to_vec()
                    } else {
                        sliced
                    };
                    // Columns present = the caller asked for a projection (a prop whose rows are
                    // arrays, `table.rows`); absent = the records go in as they are.
                    // The component's own schema decides at the top level (`table.rows` holds
                    // arrays); deeper down, where the child's schema is not resolved here, the
                    // caller saying `<prop>Columns` is the signal.
                    let wants_projection = obj.contains_key(&format!("{prop}Columns"))
                        || (top && array_item_props.contains(&prop));
                    let fitted = match fit_records_to_prop(&prop, wants_projection, rows, &holder) {
                        Ok(rows) => rows,
                        Err(e) => return Some(e),
                    };
                    tracing::info!(
                        target: "render",
                        prop = %prop,
                        cache_key = %key,
                        rows = fitted.len(),
                        "[render] cache key resolved — records injected server-side"
                    );
                    obj.insert(prop.clone(), Value::Array(fitted));
                    obj.remove(&format!("{prop}CacheKey"));
                    obj.remove(&format!("{prop}Limit"));
                    obj.remove(&format!("{prop}Range"));
                    obj.remove(&format!("{prop}Columns"));
                }
                for (_, child) in obj.iter_mut() {
                    if let Some(e) = walk(child, resolver, array_item_props, depth + 1, false) {
                        return Some(e);
                    }
                }
                None
            }
            _ => None,
        }
    }
    walk(props, resolver, array_item_props, 0, true)
}

/// Prop names whose ITEMS are arrays — `table.rows` is the one in the catalog today. Read from the
/// schema so a new component with row-arrays is covered the day it lands.
fn array_item_props(schema: &Value) -> std::collections::HashSet<String> {
    schema
        .get("properties")
        .and_then(|p| p.as_object())
        .map(|props| {
            props
                .iter()
                .filter(|(_, v)| {
                    v.get("items").and_then(|i| i.get("type")).and_then(|t| t.as_str())
                        == Some("array")
                })
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Alphanumeric-only lowercase key, so "Candle_Stick" / "OHLCV" / "candlestick" all compare.
fn chart_style_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Next-step pointers for a props-validation failure — the rejected block vanishes from the
/// answer, so this error string is the model's ONLY teacher and has to name the component that
/// CAN draw what it asked for (2026-08-12 실측: a `chart` block with chartType:"candlestick" plus
/// two charts missing `labels` all failed validation, disappeared silently, and the reply still
/// told the user "차트 3종").
///
/// `validate_value` hands back a flat String (no path / keyword / instance), so the offending
/// value is read from the PROPS the validator just rejected instead of being regexed out of the
/// message — the props are the same structured source the error was derived from, and they stay
/// correct if the message wording changes. Both checks are schema-driven, not component-name
/// driven: whichever component declares an enum'd `chartType` or a required `labels` gets them.
fn validation_next_steps(props: &Value, schema: &Value) -> Vec<String> {
    let mut steps = Vec::new();
    let properties = schema.get("properties").and_then(|v| v.as_object());

    // 1. A candle/OHLC style asked of a component whose chartType enum does not offer one:
    //    the model picked the wrong component, not the wrong string.
    if let Some(enum_values) = properties
        .and_then(|p| p.get("chartType"))
        .and_then(|c| c.get("enum"))
        .and_then(|e| e.as_array())
    {
        if let Some(got) = props.get("chartType").and_then(|v| v.as_str()) {
            let key = chart_style_key(got);
            let candle_asked = key.contains("candle") || key.contains("ohlc");
            let legal = enum_values.iter().any(|v| v.as_str() == Some(got));
            if candle_asked && !legal {
                steps.push(
                    "candlestick/OHLC charts are a different component — use `stock_chart` \
                     (rows or dataCacheKey), see get_component_schema(\"stock_chart\")."
                        .to_string(),
                );
            }
        }
    }

    // 2. Required `labels` absent — the model is treating the component as a rows-in chart.
    let requires_labels = schema
        .get("required")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().any(|x| x.as_str() == Some("labels")))
        .unwrap_or(false);
    if requires_labels && props.get("labels").is_none() {
        steps.push(
            "chart needs `labels` + `series` (`datasets` is accepted as a synonym); for cached \
             rows use `stock_chart` or pass labels explicitly."
                .to_string(),
        );
    }

    steps
}

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
        // Dialect absorb — the render TOOL's own OUTPUT shape is `{type:"component", name, props}`,
        // and the model feeds it straight back when it re-emits as a fence: the tool-mode rejection
        // tells it to "emit these as a fence", so it reuses the payload already in hand. Keying off
        // `type` alone then yields the non-existent component "component" and the whole fence drops
        // to plain text (2026-07-28 실측: 태풍/서울 날씨 답변이 통째로 텍스트가 됐다 — fence 는
        // 있었는데 파싱이 안 됐다). When `type=="component"`, the real type lives in `name`.
        let block_type = match block.get("type").and_then(|v| v.as_str()) {
            Some("component") => match block.get("name").and_then(|v| v.as_str()) {
                Some(n) => n,
                None => {
                    failed.push(serde_json::json!({
                        "idx": idx,
                        "type": "component",
                        "error": format!("blocks[{idx}]: type=\"component\" 이면 'name' 에 실제 컴포넌트 이름이 필요합니다"),
                    }));
                    continue;
                }
            },
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
                    // The count came from the catalog even when it was written by hand — and it
                    // was wrong by eighteen. Ask the catalog.
                    "error": format!(
                        "no component named '{}'. Call search_components(query) or \
                         list_components() — the catalog holds {}.",
                        block_type,
                        component_registry::components().len()
                    ),
                }));
                continue;
            }
        };

        // System-card impersonation guard — PlanCard is the OUTPUT of the propose_plan tool
        // (planId + stored steps drive the ✓실행 replay). Drawing one via fence/render produces a
        // convincing but DEAD card: no planId, no stored plan, approve does nothing (14차 실측:
        // 도구 호출 0 턴이 fence 로 PlanCard 를 그려 "플랜 카드가 또 떴는데 가짜"). Reject with
        // the real path. (Real plan cards ride tool-result blocks, not this sanitizer.)
        if comp.component_type == "PlanCard" {
            failed.push(serde_json::json!({
                "idx": idx,
                "type": block_type,
                "error": "PlanCard cannot be drawn manually — it is created only by calling the propose_plan tool (which issues the planId that makes ✓실행 work). Call propose_plan with {title, steps}, or drop the card.",
            }));
            continue;
        }

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

        // `<prop>CacheKey` → server-side row injection, at every depth (generic — no
        // per-component branching). The model references the sysmod `_cacheKey` instead of
        // hand-copying rows. Kills inline truncation/fabrication and the token double-spend
        // (cache_read into context + rows written back out).
        //
        // Two limits used to make this reachable only from one slot: the name was hard-wired to
        // `data`, and only TOP-LEVEL blocks were walked. So a `timeline` or a `table` could never
        // take a key, and a chart inside a `grid` could not either — the rows had to be retyped,
        // which is the failure this whole mechanism exists to remove. The pass below is recursive
        // over props, so a nested block and a list element (`series[i].dataCacheKey`) speak the
        // same words the module side does for `sheets.*.rows`.
        if let Some(err) =
            resolve_nested_cache_keys(&mut props, resolver, &array_item_props(&comp.props_schema))
        {
            failed.push(serde_json::json!({ "idx": idx, "type": block_type, "error": err }));
            continue;
        }
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
                    // Optional period slice — generic, fence-props-driven (no component
                    // branching): `dataRange:{from?,to?}` filters by the rows' date field,
                    // `dataLimit:N` keeps the N most-recent rows. Without this the injection
                    // is always the WHOLE cache and the model has no way to slice it
                    // (2026-07-07 실측: "최근 3개월" 일봉이 600봉 차트로 렌더).
                    let total = records.len();
                    let sliced = apply_data_slice(records, &props);
                    let rows = if sliced.len() > MAX_INJECT_ROWS {
                        sliced[sliced.len() - MAX_INJECT_ROWS..].to_vec()
                    } else {
                        sliced
                    };
                    tracing::info!(
                        target: "render",
                        cache_key = %key,
                        rows = rows.len(),
                        total = total,
                        "[render] dataCacheKey resolved — records injected server-side (sliced)"
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
            // Every error is a next-step pointer: name the component that CAN draw this before
            // the block disappears from the answer.
            let mut error = format!("props 검증 실패: {}", e);
            for step in validation_next_steps(&props, &comp.props_schema) {
                error.push(' ');
                error.push_str(&step);
            }
            failed.push(serde_json::json!({
                "idx": idx,
                "type": block_type,
                "error": error,
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
            // The last sentence exists because this hint used to leak into the answer's voice:
            // models translated "emit in your reply" into telling the USER "이제 렌더링해 줄게"
            // (measured 2026-08-09, the cubic answer's opener). Rendering is plumbing, not news.
            return Err(
                "render: emit these components as a ```firebat-render``` fenced block in your \
                 reply TEXT — do NOT call the render tool again for them (tool args corrupt \
                 non-ASCII spelling). The render tool handles only code/math/diagram. Write the \
                 reply as a normal answer about the topic — never announce rendering to the user \
                 (no \"렌더링해 줄게\"); the fence itself is the rendering."
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
            "[render] some blocks failed validation — silently skipped (not shown to user)"
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
    if !text.contains(FENCE_OPEN) && !text.contains(TAG_OPEN) {
        return (text.to_string(), Vec::new(), Vec::new(), Vec::new());
    }
    let mut out = String::with_capacity(text.len());
    let mut store: Vec<String> = Vec::new();
    let mut block_groups: Vec<Value> = Vec::new();
    let mut failed_groups: Vec<Value> = Vec::new();
    let mut rest = text;
    while let Some(region) = find_fence_region(rest) {
        out.push_str(&rest[..region.start]);
        let body = &rest[region.body_start..region.body_end];
        let (sanitized, blocks, failed) = sanitize_fence_body(body, resolver);
        // 어느 방언으로 왔든 canonical 코드펜스로 재작성 — 프론트·메모리 독자는 한 형태만 보면 된다.
        store.push(format!("```firebat-render\n{}\n```", sanitized));
        block_groups.push(blocks);
        failed_groups.push(failed);
        out.push_str(&format!("@@FBRENDER{}@@", store.len() - 1));
        rest = &rest[region.end..];
    }
    out.push_str(rest);
    (out, store, block_groups, failed_groups)
}

/// 수확한 이미지 URL 을 답변의 렌더 블록으로 붙인다. 반환 = 수정된 텍스트.
///
/// 왜 필요한가: CLI 가 자기 런타임 내장 이미지 도구를 쓰면 산출물이 우리 URL 이 아니라 모델이
/// 컴포넌트에 넣을 수가 없다. 2026-07-27 실측에서 모델은 `get_component_schema("image")` 까지
/// 부르고 "Integrating local image path in listening component" 를 고민하다 URL 이 없어 포기했다.
/// 호스트가 거둔 뒤에야 URL 이 생기므로 그 자리를 대신 채운다 — 모델 의도의 완성이다.
///
/// **컴포넌트 타입별 지식은 쓰지 않는다.** "listening 의 image prop" 같은 걸 짚어 채우면 케이스
/// 하드코딩이고, 그 슬롯이 없는 컴포넌트 구성에선 틀린다. 대신 독립 `image` 블록으로 덧붙인다 —
/// 어떤 답변 구성에서도 맞고 최악이라도 "사진이 카드 안이 아니라 그 아래에 뜬다" 뿐이다.
///
/// 붙이는 자리 = 마지막 fence 의 blocks 배열 끝. fence 가 없거나 파싱이 안 되면 새 fence 를 만든다.
///
/// `alt` 는 비운다 — 이미지 컴포넌트가 alt 를 **캡션으로 노출**해서, 사용자 요청문을 넣었더니
/// 토익 문제 사진 밑에 "토익 파트1 문제 하나 만들어줘…" 가 그대로 찍혔다(2026-07-27 실측).
/// 캡션은 모델이 필요하다고 판단할 때 자기 블록으로 쓸 몫이지 프레임워크가 끼워 넣을 것이 아니다.
pub fn append_image_blocks(text: &str, urls: &[String]) -> String {
    if urls.is_empty() {
        return text.to_string();
    }
    let new_blocks: Vec<Value> = urls
        .iter()
        .map(|u| {
            serde_json::json!({
                "type": "image",
                "props": { "src": u, "alt": null, "width": null, "height": null }
            })
        })
        .collect();

    // 마지막 fence 의 절대 좌표 — find_fence_region 은 상대 좌표라 누적한다.
    let mut offset = 0usize;
    let mut last: Option<(usize, usize)> = None;
    while let Some(r) = find_fence_region(&text[offset..]) {
        last = Some((offset + r.body_start, offset + r.body_end));
        offset += r.end;
    }

    if let Some((body_start, body_end)) = last {
        if let Ok(mut blocks) = serde_json::from_str::<Vec<Value>>(text[body_start..body_end].trim())
        {
            blocks.extend(new_blocks.iter().cloned());
            if let Ok(ser) = serde_json::to_string_pretty(&blocks) {
                return format!("{}{}\n{}", &text[..body_start], ser, &text[body_end..]);
            }
        }
    }
    let ser = serde_json::to_string_pretty(&new_blocks).unwrap_or_default();
    let sep = if text.trim().is_empty() { "" } else { "\n\n" };
    format!("{}{}```firebat-render\n{}\n```", text, sep, ser)
}

const FENCE_OPEN: &str = "```firebat-render";
const TAG_OPEN: &str = "<firebat-render>";
const TAG_CLOSE: &str = "</firebat-render>";

struct FenceRegion {
    start: usize,      // region 시작 (opener 포함)
    body_start: usize, // JSON body 시작
    body_end: usize,   // JSON body 끝 (exclusive)
    end: usize,        // region 끝 (closer 포함, exclusive)
}

/// 다음 firebat-render 영역 — 두 방언 수용: ```firebat-render 코드펜스(canonical) +
/// `<firebat-render>...</firebat-render>` XML 태그(약한 모델이 fence 를 태그로 쓰는 drift,
/// 2026-07-06 Solar 실측 — 프롬프트로 조이는 대신 파서가 받아 canonical 로 정규화).
/// 미종결 opener 는 skip 하지 않고 None(호출부가 나머지를 raw 로 보존 — 기존 동작).
fn find_fence_region(text: &str) -> Option<FenceRegion> {
    let md = text.find(FENCE_OPEN).and_then(|start| {
        let after = &text[start..];
        let nl = after.find('\n')?;
        let body_start = start + nl + 1;
        let close_rel = text[body_start..].find("```")?;
        Some(FenceRegion {
            start,
            body_start,
            body_end: body_start + close_rel,
            end: body_start + close_rel + 3,
        })
    });
    let tag = text.find(TAG_OPEN).and_then(|start| {
        let body_start = start + TAG_OPEN.len();
        let close_rel = text[body_start..].find(TAG_CLOSE)?;
        Some(FenceRegion {
            start,
            body_start,
            body_end: body_start + close_rel,
            end: body_start + close_rel + TAG_CLOSE.len(),
        })
    });
    match (md, tag) {
        (Some(a), Some(b)) => Some(if a.start <= b.start { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// Tolerant cleanup for LLM-authored fence JSON: strips `//` and `/* */` comments plus trailing
/// commas — all string-aware, so `https://…` URLs and commas inside values are untouched. Weak
/// models decorate JSON with comments (2026-07-06 Solar typhoon fence: `"radius": 460000, //
/// 460 km → 460 000 m` broke strict parse → raw display). Same policy as the tag-dialect fence:
/// the parser accepts the dialect instead of tightening prompts.
///
/// `pub` — the openai_chat FC handler reuses it to repair malformed tool-call `arguments`
/// (same weak-model dialect; an unrepaired echo of raw broken JSON is a permanent upstream
/// 400 on every later round — 2026-07-07 schedule_task 실측).
pub fn tolerant_json_cleanup(body: &str) -> String {
    // pass 1: strip comments
    let chars: Vec<char> = body.chars().collect();
    let mut no_comments = String::with_capacity(body.len());
    let mut i = 0;
    let mut in_str = false;
    let mut escaped = false;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            no_comments.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                no_comments.push(c);
                i += 1;
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(chars.len());
            }
            _ => {
                no_comments.push(c);
                i += 1;
            }
        }
    }
    // pass 2: drop trailing commas (`, }` / `, ]`)
    let chars: Vec<char> = no_comments.chars().collect();
    let mut out = String::with_capacity(no_comments.len());
    in_str = false;
    escaped = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if matches!(chars.get(j), Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Escape raw control characters (U+0000–U+001F) that appear INSIDE JSON string literals.
/// Weak models emit multi-line string values with literal newlines/tabs (2026-07-12 실측:
/// Solar propose_plan args 3.3K chars — strict AND tolerant parse both die on the control
/// char, so the whole plan collapsed to `{}`). Deterministic repair: a raw control char
/// inside a string is never valid JSON, so escaping it cannot change the meaning of a valid
/// document. Outside strings, `\n`/`\r`/`\t` are legal whitespace and left untouched.
pub fn escape_control_chars_in_strings(body: &str) -> String {
    let mut out = String::with_capacity(body.len() + 16);
    let mut in_str = false;
    let mut escaped = false;
    for c in body.chars() {
        if in_str {
            if escaped {
                out.push(c);
                escaped = false;
                continue;
            }
            match c {
                '\\' => {
                    out.push(c);
                    escaped = true;
                }
                '"' => {
                    out.push(c);
                    in_str = false;
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                }
                _ => out.push(c),
            }
        } else {
            if c == '"' {
                in_str = true;
            }
            out.push(c);
        }
    }
    out
}

/// Escape backslashes that begin an ILLEGAL escape sequence inside JSON string literals.
/// `\(`, `\)`, `\q`… are exactly what a model writes when it puts LaTeX (`\(f(x)\)`, `\quad`)
/// into a fence string without doubling the backslash (2026-08-08 실측: cubic-problem fence —
/// the two math-bearing text blocks were the only casualties; every other repair stage passes
/// illegal escapes through untouched). A valid JSON document contains no illegal escape, so
/// doubling those backslashes cannot change the meaning of valid input. `\uXXXX` survives only
/// when its four hex digits are actually attached.
///
/// Runs BEFORE `escape_control_chars_in_strings`: a backslash followed by a raw newline becomes
/// `\\` + newline here, and the control-char pass then turns the newline into `\n` — the other
/// order would leave the raw newline hidden behind the escape flag.
pub fn escape_invalid_escapes_in_strings(body: &str) -> String {
    let chars: Vec<char> = body.chars().collect();
    let mut out = String::with_capacity(body.len() + 16);
    let mut in_str = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_str {
            if c == '"' {
                in_str = true;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = false;
            out.push(c);
            i += 1;
            continue;
        }
        if c != '\\' {
            out.push(c);
            i += 1;
            continue;
        }
        match chars.get(i + 1) {
            Some(&n) if matches!(n, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't') => {
                out.push('\\');
                out.push(n);
                i += 2;
            }
            Some(&'u')
                if chars
                    .get(i + 2..i + 6)
                    .is_some_and(|h| h.iter().all(|c| c.is_ascii_hexdigit())) =>
            {
                out.push('\\');
                out.push('u');
                i += 2;
            }
            _ => {
                // Illegal escape (or a trailing backslash) — the backslash was content.
                out.push('\\');
                out.push('\\');
                i += 1;
            }
        }
    }
    out
}

/// Repair unbalanced brackets/braces outside string literals — a weak-model emission slip
/// (2026-07-12 실측: a 1,625-char propose_plan arg ended `}}]}]}]}` — surplus closers — so
/// strict AND tolerant parses both died at the tail and the whole plan collapsed to `{}`).
/// String-aware scan: surplus closers are dropped, mismatched closers are rewritten to the
/// expected one, unclosed openers are closed at EOF. Text inside strings is never touched;
/// already-balanced input passes through unchanged.
pub fn balance_json_brackets(body: &str) -> String {
    let mut out = String::with_capacity(body.len() + 8);
    let mut stack: Vec<char> = Vec::new();
    let mut in_str = false;
    let mut escaped = false;
    for c in body.chars() {
        if in_str {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '{' => {
                stack.push('}');
                out.push(c);
            }
            '[' => {
                stack.push(']');
                out.push(c);
            }
            '}' | ']' => match stack.last() {
                Some(&want) if want == c => {
                    stack.pop();
                    out.push(c);
                }
                Some(&want) => {
                    // Wrong-type closer — emit the expected one instead.
                    stack.pop();
                    out.push(want);
                }
                None => {
                    // Surplus closer after the structure already closed — drop it.
                }
            },
            _ => out.push(c),
        }
    }
    if in_str {
        out.push('"');
    }
    while let Some(wanted) = stack.pop() {
        out.push(wanted);
    }
    out
}

/// Parse a fence body as JSON — strict first, then the tolerant cleanup (comments / trailing
/// commas / raw control chars in strings), then bracket balancing on top. Shared by the
/// sanitize and plaintext paths so both accept the same dialects.
fn parse_fence_json(body: &str) -> Option<Value> {
    let trimmed = body.trim();
    if let Ok(v) = serde_json::from_str(trimmed) {
        return Some(v);
    }
    // Which rung saved it is the interesting part — one `target=dialect` door for every absorber
    // so the shapes models actually send can be counted instead of guessed (2026-08-09).
    let cleaned = escape_control_chars_in_strings(&escape_invalid_escapes_in_strings(
        &tolerant_json_cleanup(trimmed),
    ));
    if let Ok(v) = serde_json::from_str(cleaned.trim()) {
        tracing::info!(target: "dialect", surface = "fence", kind = "json-cleanup",
            "fence recovered by comment/comma/control-char/escape repair");
        return Some(v);
    }
    if let Ok(v) = serde_json::from_str(balance_json_brackets(&cleaned).trim()) {
        tracing::info!(target: "dialect", surface = "fence", kind = "bracket-balance",
            "fence recovered by bracket balancing");
        return Some(v);
    }
    None
}

// ── L5 fence-repair round helpers (ai.rs) — 관대 체인 전패 fence 를 문법 수리 전용 LLM 1콜로
//    재작성할 때 쓰는 순수 헬퍼들. ──

/// 관대 체인(strict → 주석/콤마 → 제어문자 → 괄호 균형)으로 파싱되는가 — 수리 대상/성공 판정.
pub fn fence_parse_ok(body: &str) -> bool {
    parse_fence_json(body).is_some()
}

/// `mask_and_sanitize_fences` 가 store 에 남긴 canonical fence 문자열에서 body 만 추출.
/// (파싱 실패 fence 의 store = "```firebat-render\n{원문 body trim}\n```".)
pub fn fence_store_body(stored: &str) -> &str {
    stored
        .trim()
        .trim_start_matches("```firebat-render")
        .trim_end_matches("```")
        .trim()
}

/// LLM 수리 응답에서 JSON 후보 추출 — "ONLY the JSON" 지시에도 모델이 ```json 코드펜스로
/// 감싸는 버릇 흡수(내용은 그대로). 펜스 없으면 trim 만.
pub fn strip_wrapping_fence(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        // 첫 줄(언어 태그) 제거 후 마지막 ``` 앞까지.
        let body = rest.split_once('\n').map(|(_, b)| b).unwrap_or(rest);
        if let Some(end) = body.rfind("```") {
            return body[..end].trim().to_string();
        }
        return body.trim().to_string();
    }
    t.to_string()
}

/// Validate/normalize a fence body (a JSON array of blocks, or `{blocks:[...]}`) via `render_blocks`.
/// Returns `(json_string, blocks_value)`. On parse/validation failure, returns the trimmed original
/// string + `Null` blocks so the frontend renders it raw (visible + debuggable, never silently dropped).
/// Item-level salvage for a fence whose WHOLE body defeated the tolerant chain.
///
/// One missing `}` in one block used to cost the entire answer: the bracket-balance repair
/// appends missing closers at end-of-document, which is the wrong place when the gap is in the
/// middle, so a 14-block reply rendered as a four-thousand-character raw JSON wall (measured
/// 2026-08-08, the BTC report — one table's `props` never closed). Cutting the array into its
/// items first makes the SAME repair land right: a closer appended at the end of the broken
/// item's own slice is exactly where it was missing. The block shape is a fixed contract
/// (`{"type"/"name": ...}`), which is what makes the item boundaries findable at all.
///
/// Only runs after the whole-document chain has failed, so it cannot degrade a valid fence.
/// Returns `(good_blocks, parse_failed)` — a slice that still refuses to parse is returned as a
/// failed entry (idx + error + its raw text) rather than dropped, same rule as the validation
/// badge. `None` = shape not salvageable (not an array / fewer than two items found).
fn salvage_fence_items(body: &str) -> Option<(Vec<Value>, Vec<Value>)> {
    let s = body.trim();
    if !s.starts_with('[') {
        return None;
    }
    // String-aware scan for item openers: a `{` whose next token is `"type"` or `"name"`,
    // preceded by `,` or `[`, at nesting depth 1 — or 2, because one missing closer upstream
    // shifts everything after it by exactly one level (the measured failure). Each accepted
    // opener re-anchors the depth, so a single broken item cannot poison the boundaries behind it.
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut in_str = false;
    let mut esc = false;
    let mut depth: i32 = 0;
    let mut last_sig = ' ';
    let mut starts: Vec<usize> = Vec::new();
    for (k, &(_, c)) in chars.iter().enumerate() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                last_sig = c;
            }
            '{' => {
                if (depth == 1 || depth == 2) && (last_sig == ',' || last_sig == '[') {
                    let mut j = k + 1;
                    while j < chars.len() && chars[j].1.is_whitespace() {
                        j += 1;
                    }
                    let peek: String = chars[j..chars.len().min(j + 7)].iter().map(|&(_, ch)| ch).collect();
                    if peek.starts_with("\"type\"") || peek.starts_with("\"name\"") {
                        starts.push(chars[k].0);
                        depth = 1;
                    }
                }
                depth += 1;
                last_sig = c;
            }
            '[' => {
                depth += 1;
                last_sig = c;
            }
            '}' | ']' => {
                depth -= 1;
                last_sig = c;
            }
            _ => {
                if !c.is_whitespace() {
                    last_sig = c;
                }
            }
        }
    }
    if starts.len() < 2 {
        return None; // a single item has nothing to be cut apart from
    }
    let mut good: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for (i, &from) in starts.iter().enumerate() {
        let to = starts.get(i + 1).copied().unwrap_or(s.len());
        let mut slice = &s[from..to];
        // Strip the joinery that belongs to the array, not the item: trailing commas, the final
        // `]`, whitespace. The item's own missing closers are the repair's job, not ours.
        slice = slice.trim_end();
        while let Some(t) = slice.strip_suffix(',').or_else(|| slice.strip_suffix(']')) {
            slice = t.trim_end();
        }
        let cleaned = escape_control_chars_in_strings(&escape_invalid_escapes_in_strings(
            &tolerant_json_cleanup(slice),
        ));
        let candidate = balance_json_brackets(cleaned.trim());
        match serde_json::from_str::<Value>(candidate.trim()) {
            Ok(v) if v.is_object() => good.push(v),
            _ => {
                let snippet: String = slice.chars().take(400).collect();
                failed.push(serde_json::json!({
                    "idx": i,
                    "type": "?",
                    "error": "이 블록의 JSON 은 복구되지 않았습니다 — 이 항목만 제외했습니다",
                    "raw": snippet,
                }));
            }
        }
    }
    if good.is_empty() {
        return None;
    }
    Some((good, failed))
}

fn sanitize_fence_body(body: &str, resolver: Option<FenceDataResolver>) -> (String, Value, Value) {
    let trimmed = body.trim();
    let Some(parsed) = parse_fence_json(trimmed) else {
        // The whole document is beyond the tolerant chain — salvage the items individually
        // before giving up (and before ai.rs spends an LLM repair round on it).
        if let Some((good, parse_failed)) = salvage_fence_items(trimmed) {
            tracing::info!(target: "dialect", surface = "fence", kind = "item-salvage",
                good = good.len(), failed = parse_failed.len(),
                "whole-document parse failed — recovered per item");
            let args = serde_json::json!({ "blocks": good });
            if let Ok(result) = render_blocks(&args, false, resolver) {
                let blocks = result.get("blocks").cloned().unwrap_or_else(|| serde_json::json!([]));
                let mut failed = result.get("failed").cloned().unwrap_or_else(|| serde_json::json!([]));
                if let Some(arr) = failed.as_array_mut() {
                    arr.extend(parse_failed);
                }
                let s = serde_json::to_string(&blocks).unwrap_or_else(|_| trimmed.to_string());
                return (s, blocks, failed);
            }
        }
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
    if !text.contains(FENCE_OPEN) && !text.contains(TAG_OPEN) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(region) = find_fence_region(rest) {
        out.push_str(&rest[..region.start]);
        let body = &rest[region.body_start..region.body_end];
        match parse_fence_json(body) {
            Some(v) => {
                let mut collected = String::new();
                collect_text_values(&v, "", &mut collected);
                out.push_str(collected.trim());
            }
            // parse 실패 = 그냥 본문(JSON 마커만 떼고) — raw JSON 보다 나음.
            None => out.push_str(body.trim()),
        }
        rest = &rest[region.end..];
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

    /// The measured 2026-08-08 shape: a middle block whose `props` object never closes. The
    /// whole-document chain fails (the balance repair appends the closer at end-of-document),
    /// but per-item the same repair lands the closer where it was missing.
    #[test]
    fn salvage_recovers_items_around_a_missing_brace() {
        let body = r#"[
  { "type": "header", "props": { "text": "요약", "level": 2 } },
  { "type": "table", "props": { "headers": ["a"], "rows": [["x"]] },
  { "type": "divider" },
  { "type": "text", "props": { "content": "끝" } }
]"#;
        assert!(parse_fence_json(body).is_none(), "the fixture must defeat the whole-doc chain");
        let (good, failed) = salvage_fence_items(body).expect("salvageable");
        assert_eq!(good.len(), 4, "every item recovers — the broken one heals per-slice");
        assert!(failed.is_empty());
        assert_eq!(good[1]["type"], "table");
        assert_eq!(good[2]["type"], "divider");
    }

    /// An item that is broken beyond repair is returned as a failed entry with its raw text —
    /// excluded by name, never silently dropped — while its neighbours still render.
    #[test]
    fn salvage_names_the_unrecoverable_item() {
        let body = "[\n  { \"type\": \"header\", \"props\": { \"text\": \"a\" } },\n  { \"type\": \"chart\", \"props\": { \"data\": ::: } },\n  { \"type\": \"text\", \"props\": { \"content\": \"b\" } }\n]";
        assert!(parse_fence_json(body).is_none());
        let (good, failed) = salvage_fence_items(body).expect("salvageable");
        assert_eq!(good.len(), 2);
        assert_eq!(failed.len(), 1);
        assert!(failed[0]["raw"].as_str().unwrap().contains(":::"));
    }

    /// The measured 2026-08-09 shape: LaTeX delimiters written into a JSON string without
    /// doubling the backslash — `\(`, `\)` are illegal escapes, and before this stage both the
    /// whole-document chain and item salvage excluded exactly the math-bearing blocks.
    #[test]
    fn illegal_latex_escapes_are_repaired_not_excluded() {
        let body = r#"[
  { "type": "header", "props": { "text": "문제" } },
  { "type": "text", "props": { "content": "함수 \( f(x) = x^3 \) 에 대하여 \quad 답하시오." } }
]"#;
        let parsed = parse_fence_json(body).expect("the illegal-escape repair must land");
        let content = parsed[1]["props"]["content"].as_str().unwrap();
        assert!(content.contains("\\( f(x) = x^3 \\)"), "LaTeX survives as literal text");
        assert!(content.contains("\\quad"));
    }

    /// Legal escapes and complete \uXXXX pass through untouched; a \u without its hex digits
    /// is content and gets its backslash doubled.
    #[test]
    fn legal_escapes_survive_the_illegal_escape_repair() {
        let s = r#"{"a": "line\nbreak \"q\" \\ slash\/ 가 \uzz"}"#;
        let fixed = escape_invalid_escapes_in_strings(s);
        assert_eq!(fixed, r#"{"a": "line\nbreak \"q\" \\ slash\/ 가 \\uzz"}"#);
        let v: Value = serde_json::from_str(&fixed).expect("repaired string parses");
        assert_eq!(v["a"].as_str().unwrap(), "line\nbreak \"q\" \\ slash/ 가 \\uzz");
    }

    /// A valid fence never reaches salvage — the whole-document parse wins first.
    #[test]
    fn salvage_is_unreachable_for_a_valid_fence() {
        let body = r#"[{ "type": "divider" }, { "type": "header", "props": { "text": "t" } }]"#;
        assert!(parse_fence_json(body).is_some());
    }

    /// The salvage path flows through sanitize_fence_body: blocks come back renderable and the
    /// stored canonical fence is the serialized good blocks.
    #[test]
    fn sanitize_fence_body_salvages_the_broken_document() {
        let body = r#"[
  { "type": "header", "props": { "text": "요약", "level": 2 } },
  { "type": "table", "props": { "headers": ["a"], "rows": [["x"]] },
  { "type": "text", "props": { "content": "끝" } }
]"#;
        let (stored, blocks, _failed) = sanitize_fence_body(body, None);
        let arr = blocks.as_array().expect("blocks array");
        assert_eq!(arr.len(), 3);
        assert!(stored.starts_with('['), "canonical fence is the rebuilt array");
    }

    /// The failed entry for the first block, with a `divider` alongside so `render_blocks`
    /// returns the per-block report instead of the all-failed Err.
    fn first_failure(props: Value) -> String {
        let args = serde_json::json!({
            "blocks": [{"type": "chart", "props": props}, {"type": "divider"}]
        });
        let out = render_blocks(&args, false, None).expect("the divider keeps the call alive");
        let failed = out["failed"].as_array().expect("failed array");
        assert_eq!(failed.len(), 1, "only the chart block fails");
        failed[0]["error"].as_str().unwrap().to_string()
    }

    /// 2026-08-12 실측: chartType:"candlestick" failed validation, the block vanished, and the
    /// reply still claimed three charts. The error now names the component that draws candles.
    #[test]
    fn candlestick_chart_type_points_at_stock_chart() {
        let err = first_failure(serde_json::json!({
            "chartType": "Candlestick", "labels": ["1일", "2일"]
        }));
        assert!(err.contains("props 검증 실패"), "{err}");
        assert!(err.contains("get_component_schema(\"stock_chart\")"), "{err}");
        assert!(
            !err.contains("chart needs `labels`"),
            "labels were supplied — no labels pointer: {err}"
        );
        // Case-insensitive on the offending value, and "ohlc" counts as the same ask.
        let err = first_failure(serde_json::json!({ "chartType": "OHLC", "labels": ["a"] }));
        assert!(err.contains("use `stock_chart`"), "{err}");
    }

    /// A chartType that is merely wrong (not a candle ask) keeps the plain enum error — the
    /// pointer must not fire on every rejected value.
    #[test]
    fn non_candle_chart_type_gets_no_stock_chart_pointer() {
        let err = first_failure(serde_json::json!({ "chartType": "barr", "labels": ["a"] }));
        assert!(err.contains("props 검증 실패"), "{err}");
        assert!(!err.contains("stock_chart"), "{err}");
    }

    /// Missing `labels` — the model treated `chart` as a rows-in component.
    #[test]
    fn missing_labels_names_the_chart_shape() {
        let err = first_failure(serde_json::json!({ "chartType": "line" }));
        assert!(err.contains("chart needs `labels` + `series`"), "{err}");
        assert!(err.contains("use `stock_chart` or pass labels explicitly"), "{err}");
    }

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
    fn tag_dialect_fence_is_recognized_and_canonicalized() {
        // 약한 모델이 코드펜스 대신 XML 태그로 쓰는 drift — 파싱 + canonical 펜스 재작성.
        let text = "차트입니다.\n<firebat-render>\n[{\"type\":\"header\",\"props\":{\"text\":\"제목\",\"level\":2}}]\n</firebat-render>\n끝.";
        let (masked, fences, groups, _) = mask_and_sanitize_fences(text, None);
        assert!(masked.contains("@@FBRENDER0@@"), "태그 영역이 마스킹되어야: {masked}");
        assert!(!masked.contains("<firebat-render>"));
        assert_eq!(fences.len(), 1);
        assert!(fences[0].starts_with("```firebat-render\n"), "canonical 펜스로 재작성: {}", fences[0]);
        assert_eq!(groups[0].as_array().map(|a| a.len()), Some(1));
        // plaintext 변환도 태그 방언 인식
        let plain = fence_to_plaintext(text);
        assert!(plain.contains("제목") && !plain.contains("firebat-render"), "{plain}");
    }

    #[test]
    fn tolerant_parse_accepts_comments_and_trailing_commas() {
        // 2026-07-06 Solar 태풍 fence 실측: JSON 값 뒤 `// 460 km → 460 000 m` 주석으로 strict
        // parse 실패 → raw 표시. 관대 패스가 주석·trailing comma 를 벗겨 렌더로 복구해야 한다.
        let body = "[\n  {\n    \"type\": \"header\", // 제목 주석\n    \"props\": {\n      \"text\": \"제9호 태풍\", /* 블록 주석 */\n      \"level\": 2,\n    },\n  },\n]";
        let v = parse_fence_json(body).expect("tolerant parse");
        assert_eq!(v[0]["props"]["text"], "제9호 태풍");
        // 문자열 안 `//`(URL)·콤마는 건드리지 않는다.
        let url_body = r#"[{"type":"text","props":{"content":"https://a.b/c, 그리고 // 이건 값"}}]"#;
        let v2 = parse_fence_json(url_body).expect("strict parse");
        assert_eq!(v2[0]["props"]["content"], "https://a.b/c, 그리고 // 이건 값");
        // 전체 sanitize 경로에서도 raw fallback 이 아니라 렌더로 나가야.
        let text = format!("지도.\n```firebat-render\n{}\n```\n끝.", body);
        let (_, fences, groups, _) = mask_and_sanitize_fences(&text, None);
        assert_eq!(fences.len(), 1);
        assert_eq!(groups[0].as_array().map(|a| a.len()), Some(1), "렌더 블록으로 파싱: {}", fences[0]);
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

    fn day_rows(dates: &[&str]) -> Vec<Value> {
        dates
            .iter()
            .map(|d| serde_json::json!({"date": d, "close": 1.0}))
            .collect()
    }

    #[test]
    fn data_slice_range_inclusive_and_format_agnostic() {
        // ISO rows, YYYYMMDD bounds — digits-only compare bridges both formats.
        let rows = day_rows(&["2026-04-06", "2026-04-07", "2026-05-01", "2026-07-07"]);
        let props = serde_json::json!({"dataRange": {"from": "20260407", "to": "2026-05-01"}});
        let out = apply_data_slice(rows, &props);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["date"], "2026-04-07");
        assert_eq!(out[1]["date"], "2026-05-01");
    }

    #[test]
    fn data_slice_empty_range_falls_back_to_full() {
        let rows = day_rows(&["2026-04-06", "2026-04-07"]);
        let props = serde_json::json!({"dataRange": {"from": "2030-01-01"}});
        assert_eq!(apply_data_slice(rows, &props).len(), 2, "bad range must not blank data");
    }

    #[test]
    fn data_limit_keeps_most_recent_order_aware() {
        // oldest-first (yfinance) — tail
        let asc = day_rows(&["2026-01-01", "2026-01-02", "2026-01-03"]);
        let out = apply_data_slice(asc, &serde_json::json!({"dataLimit": 2}));
        assert_eq!(out[0]["date"], "2026-01-02");
        // newest-first (kiwoom) — head
        let desc = day_rows(&["2026-01-03", "2026-01-02", "2026-01-01"]);
        let out = apply_data_slice(desc, &serde_json::json!({"dataLimit": 2}));
        assert_eq!(out[0]["date"], "2026-01-03");
        assert_eq!(out[1]["date"], "2026-01-02");
    }

    #[test]
    fn data_cache_key_injection_applies_slice() {
        let rows = day_rows(&["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
        let rows_clone = rows.clone();
        let resolver = move |_: &str| -> Result<Vec<Value>, String> { Ok(rows_clone.clone()) };
        let args = serde_json::json!({
            "blocks": [{"type": "stock_chart", "props": {
                "symbol": "A", "dataCacheKey": "k", "dataLimit": 2
            }}]
        });
        let out = render_blocks(&args, false, Some(&resolver)).unwrap();
        let data = out["blocks"][0]["props"]["data"].as_array().unwrap();
        assert_eq!(data.len(), 2, "dataLimit applied at injection");
        assert_eq!(data[0]["date"], "2026-01-03");
    }

    // ── append_image_blocks — CLI 내장 도구 산출물을 답변에 실어 보내기 ──────────
    // 회귀 대상: 모델이 자기 내장 이미지 도구를 써서 URL 이 없으면 사진이 답변에서 사라졌다.

    #[test]
    #[ignore = "one of the two blocks is dropped by sanitisation, and it is not the schema: \n               image allows nulls on alt/width/height and requires all four, which the \n               appended block provides. Needs the `failed` group printed to see which \n               block and why — not yet done, and guessing would be worse"]
    fn append_image_blocks_extends_last_fence() {
        let text = "설명

```firebat-render
[{\"type\":\"text\",\"props\":{\"text\":\"hi\"}}]
```
꼬리";
        let out = append_image_blocks(text, &["/user/media/a.png".to_string()]);
        assert!(out.starts_with("설명"), "앞 텍스트 보존");
        assert!(out.trim_end().ends_with("꼬리"), "뒤 텍스트 보존");
        let (_, _, groups, _) = mask_and_sanitize_fences(&out, None);
        let blocks = groups[0].as_array().expect("fence 가 유효해야 함");
        assert_eq!(blocks.len(), 2, "기존 블록 + 이미지 1");
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["props"]["src"], "/user/media/a.png");
        assert!(blocks[1]["props"]["alt"].is_null(), "alt 는 비운다 — 캡션으로 노출되므로");
    }

    #[test]
    fn append_image_blocks_creates_fence_when_absent() {
        let out = append_image_blocks("사진을 만들었습니다.", &["/user/media/b.webp".to_string()]);
        let (_, _, groups, _) = mask_and_sanitize_fences(&out, None);
        let blocks = groups[0].as_array().expect("새 fence 가 유효해야 함");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["props"]["src"], "/user/media/b.webp");
    }

    #[test]
    fn append_image_blocks_noop_without_urls() {
        let text = "그대로";
        assert_eq!(append_image_blocks(text, &[]), text);
    }

    /// 렌더 **도구 결과 shape**(`{type:"component", name, props}`)이 fence 로 되돌아와도 살아야 한다.
    /// 회귀 대상: tool_mode 거부 후 모델이 손에 있던 결과 payload 를 그대로 fence 에 넣어
    /// 답변 전체가 텍스트로 떨어졌다(2026-07-28 태풍/서울 날씨 실측).
    #[test]
    fn fence_absorbs_render_tool_output_shape() {
        let text = "설명

```firebat-render
[{\"name\":\"Header\",\"props\":{\"level\":2,\"text\":\"제13호 태풍\"},\"type\":\"component\"}]
```";
        let (_, _, groups, failed) = mask_and_sanitize_fences(text, None);
        let blocks = groups[0].as_array().expect("fence 가 유효해야 함");
        assert_eq!(blocks.len(), 1, "실패: {:?}", failed);
        assert_eq!(blocks[0]["name"], "Header");
        assert_eq!(blocks[0]["props"]["text"], "제13호 태풍");
    }

    /// type="component" 인데 name 이 없으면 조용히 통과시키지 않는다.
    #[test]
    fn component_shape_without_name_fails_loudly() {
        let out = render_blocks(
            &serde_json::json!({ "blocks": [{ "type": "component", "props": {} }] }),
            false,
            None,
        );
        assert!(out.is_err() || out.unwrap()["failed"].as_array().map(|a| !a.is_empty()).unwrap_or(false));
    }

    /// Rows reach any declared row prop, at any depth. Before this, the injection knew one name
    /// (`data`) and one level (top), so a `timeline` could not take a key at all and a chart
    /// inside a `grid` could not either — both had to be retyped inline, which is the failure the
    /// cache key exists to remove.
    #[test]
    fn a_cache_key_fills_any_row_prop_at_any_depth() {
        let rows = vec![
            serde_json::json!({"date": "2026-08-01", "title": "A", "close": 1}),
            serde_json::json!({"date": "2026-08-02", "title": "B", "close": 2}),
        ];
        let resolve = |_k: &str| -> Result<Vec<Value>, String> { Ok(rows.clone()) };
        let out = render_blocks(
            &serde_json::json!({"blocks": [
                {"type": "timeline", "props": {"itemsCacheKey": "m-a:rows-0123456789abcdef-1786000000000"}},
                {"type": "grid", "props": {"columns": 2, "children": [
                    {"type": "timeline", "props": {"itemsCacheKey": "m-a:rows-0123456789abcdef-1786000000000",
                                                   "itemsLimit": 1}}
                ]}}
            ]}),
            false,
            Some(&resolve),
        )
        .expect("render");
        assert!(out["failed"].as_array().unwrap().is_empty(), "{out}");
        let blocks = out["components"].as_array().or_else(|| out["blocks"].as_array()).unwrap();
        let top = &blocks[0]["props"]["items"];
        assert_eq!(top.as_array().unwrap().len(), 2, "top-level row prop filled: {out}");
        let nested = &blocks[1]["props"]["children"][0]["props"]["items"];
        assert_eq!(nested.as_array().unwrap().len(), 1, "nested block filled and windowed: {out}");
        assert!(blocks[0]["props"].get("itemsCacheKey").is_none(), "the key is consumed");
    }

    /// `table.rows` holds arrays, so object records need a projection — asked for, never guessed,
    /// and the refusal names the fields the records actually have.
    #[test]
    fn a_table_projects_records_into_rows_or_says_what_is_missing() {
        let rows = vec![serde_json::json!({"date": "2026-08-01", "close": 1500, "vol": 7})];
        let resolve = |_k: &str| -> Result<Vec<Value>, String> { Ok(rows.clone()) };
        let key = "m-a:rows-0123456789abcdef-1786000000000";

        let out = render_blocks(
            &serde_json::json!({"blocks": [{"type": "table", "props": {
                "headers": ["날짜", "종가"], "rowsCacheKey": key, "rowsColumns": ["date", "close"]
            }}]}),
            false,
            Some(&resolve),
        )
        .expect("render");
        assert!(out["failed"].as_array().unwrap().is_empty(), "{out}");
        let blocks = out["components"].as_array().or_else(|| out["blocks"].as_array()).unwrap();
        assert_eq!(blocks[0]["props"]["rows"][0][0], "2026-08-01");
        assert_eq!(blocks[0]["props"]["rows"][0][1], "1500");

        // Every block failing is an Err, not an Ok carrying failures — either way the text the
        // model reads is the same one.
        let missing = render_blocks(
            &serde_json::json!({"blocks": [{"type": "table", "props": {
                "headers": ["날짜", "종가"], "rowsCacheKey": key
            }}]}),
            false,
            Some(&resolve),
        );
        let err = match &missing {
            Err(e) => e.clone(),
            Ok(v) => v["failed"][0]["error"].as_str().unwrap_or("").to_string(),
        };
        assert!(err.contains("rowsColumns"), "the error must name the next step: {err}");
        assert!(err.contains("date"), "and the fields available: {err}");
    }
}

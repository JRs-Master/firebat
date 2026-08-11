//! Cache keys as module INPUT — the mirror of `dataCacheKey` on the render side.
//!
//! A large result is cached and the caller gets a key, so it never carries the rows in context. But
//! a module that consumes those rows had no way to accept the key: `technical-analysis` declares
//! `bars` as an array, so calling it meant serialising six hundred candles back into the tool call.
//! The model already held the data from `cache_read`, and computing a moving average itself is far
//! cheaper than echoing the series — so it computed, by hand, without the fee, tax, slippage and
//! stop handling the module would have applied (measured 2026-07-31, a golden-cross backtest).
//!
//! That is an economics problem, not a discovery one. Steering a model toward a tool that is
//! expensive to call does not work; making the call cheap does. A module declares which of its array
//! parameters may arrive as a key:
//!
//! ```json
//! "cacheInputs": ["bars"]
//! ```
//!
//! and the caller may then send `barsCacheKey` instead of `bars`. Expansion happens before schema
//! validation, so the module itself is unchanged and its `required` list still means what it says.
//!
//! # Nested declarations
//!
//! The rows a model wants to hand over are not always a top-level parameter. `docs.make_xlsx` takes
//! `sheets: [{name, headers, rows}]`, so the big array lives one level down and there was no key
//! path at all — measured 2026-08-12, a "일봉 (최근 120일)" sheet shipped whose `rows` were the
//! five-row inline preview the auto-cache truncation had shown the model. The chart was five stale
//! points under a 120-day label: the worst failure shape, because it looks like data.
//!
//! An entry may therefore be a path of exactly the shape `"<listParam>.*.<field>"`:
//!
//! ```json
//! "cacheInputs": ["blocks", "sheets.*.rows"]
//! ```
//!
//! Every element of `sheets` may then carry `rowsCacheKey` in place of `rows`. Plain entries keep
//! today's behaviour exactly; the two forms live in the same array.

use std::sync::Arc;

use crate::utils::sysmod_cache::SysmodCacheAdapter;

/// `bars` → `barsCacheKey`. Convention rather than a second declaration: one name to get wrong
/// instead of two.
pub fn key_field(param: &str) -> String {
    format!("{param}CacheKey")
}

/// A `"<list>.*.<field>"` declaration, split. The wildcard is the only supported path element:
/// "every element of this array may swap `<field>` for `<field>CacheKey`".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NestedSpec {
    pub list: String,
    pub field: String,
}

/// Parses the nested form. Returns `None` for a plain param name — so callers can branch on it
/// without a second membership test — and also for anything dotted that is not exactly
/// `<list>.*.<field>`: an unrecognised path is not silently reinterpreted as a flat param.
pub fn parse_nested(entry: &str) -> Option<NestedSpec> {
    let (list, field) = entry.split_once(".*.")?;
    if list.is_empty() || field.is_empty() || list.contains('.') || field.contains('.') {
        return None;
    }
    Some(NestedSpec {
        list: list.to_string(),
        field: field.to_string(),
    })
}

/// Whether the module's input schema declares this param as an object (plain `"object"` or
/// the nullable union `["object","null"]`). Such a param takes the cached record itself.
fn param_wants_object(config: &serde_json::Value, param: &str) -> bool {
    let ty = config
        .get("input")
        .and_then(|i| i.get("properties"))
        .and_then(|p| p.get(param))
        .and_then(|s| s.get("type"));
    match ty {
        Some(serde_json::Value::String(s)) => s == "object",
        Some(serde_json::Value::Array(arr)) => {
            let mut non_null = arr
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|s| *s != "null");
            matches!((non_null.next(), non_null.next()), (Some("object"), None))
        }
        _ => false,
    }
}

/// Array parameters this module accepts as a cache key, as declared — plain names and nested
/// `"<list>.*.<field>"` paths alike, unparsed. Empty unless declared.
///
/// Returning the raw entries keeps this the single source for both readers: `expand` parses them,
/// while the validation-error hint in `module.rs` substring-matches them against a failing JSON
/// pointer. A nested entry simply never matches there, which costs a hint, not correctness.
pub fn declared(config: &serde_json::Value) -> Vec<String> {
    config
        .get("cacheInputs")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a string has the cache-key SHAPE (`…-<16 hex>-<13 digit ms>`). Models hand keys to
/// the value slot instead of the key slot ("statements": "<key>" — measured 2026-08-12, turn
/// 39, two rounds burned); the shape is distinctive enough to read the intent losslessly.
pub fn looks_like_cache_key(s: &str) -> bool {
    let s = s.trim();
    let Some((head, ts)) = s.rsplit_once('-') else { return false };
    let Some((_, hash)) = head.rsplit_once('-') else { return false };
    ts.len() == 13
        && ts.bytes().all(|b| b.is_ascii_digit())
        && hash.len() == 16
        && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether a cache key points at a WHOLE-response entry (scalar/autoCacheWhole path — the
/// action label's field segment is `_`). Such an entry is one object, never a rows list.
fn is_whole_entry_key(key: &str) -> bool {
    let Some((head, _ts)) = key.trim().rsplit_once('-') else { return false };
    let Some((label, _hash)) = head.rsplit_once('-') else { return false };
    label.ends_with(":_")
}

/// Reads the records behind one key. `where_` names the argument slot (`barsCacheKey` or
/// `sheets[2].rowsCacheKey`) so every failure below says which one died.
fn read_records(
    cache: &Arc<SysmodCacheAdapter>,
    key: &str,
    where_: &str,
) -> Result<Vec<serde_json::Value>, String> {
    cache
        .read(key, 0, usize::MAX)
        .map_err(|e| format!("{where_}: {e}"))?
        .get("records")
        .and_then(|r| r.as_array())
        .cloned()
        .ok_or_else(|| format!("{where_}: cache entry {key} holds no records"))
}

/// Expands `<field>CacheKey` inside every element of a `<list>.*.<field>` declaration.
///
/// Returns `Ok(None)` when no element carried a key, so the caller can leave the input untouched.
/// Unlike the flat case there is no object-slot unwrap here: a nested field is always an array of
/// records (a sheet's `rows`), and `param_wants_object` reads the TOP-LEVEL schema, which describes
/// the list, not its items. Keeping nested fields array-only means one shape to reason about.
fn expand_nested(
    module: &str,
    spec: &NestedSpec,
    list: &[serde_json::Value],
    cache: Option<&Arc<SysmodCacheAdapter>>,
) -> Result<Option<Vec<serde_json::Value>>, String> {
    let field = key_field(&spec.field);
    let mut out: Option<Vec<serde_json::Value>> = None;
    for (i, item) in list.iter().enumerate() {
        let Some(item_obj) = item.as_object() else {
            continue;
        };
        let Some(key) = item_obj
            .get(&field)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let key = key.to_string();
        let at = format!("{}[{i}].{field}", spec.list);
        // A whole-response key can never be rows. Turn 39 (2026-08-12) shipped a "일봉
        // (120일)" sheet that was EMPTY: the model grabbed an earlier dud call's `…:_`
        // key while the real 500-row array key sat one call later in the history.
        // Expanding it faithfully injects one response object where rows belong — data
        // loss that looks like data. Refuse with the shape named instead.
        if is_whole_entry_key(&key) {
            return Err(format!(
                "{at}: {key} is a WHOLE-response cache entry (label ':_'), not a rows list — \
                 pass the _cacheKey whose label names the rows field (e.g. \
                 module-action:rowsField-…), from the call that actually returned the rows."
            ));
        }
        let items = out.get_or_insert_with(|| list.to_vec());
        let target = items[i].as_object_mut().expect("checked above");
        // Inline wins: the element already carries the real rows, so the stray key is just
        // dropped (leaving it would fail schemas that forbid extra properties).
        if target.get(&spec.field).is_some_and(|v| !v.is_null()) {
            target.remove(&field);
            continue;
        }
        let Some(cache) = cache else {
            return Err(format!(
                "{at} was given but this server has no result cache — send `{}` inline.",
                spec.field
            ));
        };
        let records = read_records(cache, &key, &at)?;
        let count = records.len();
        target.insert(spec.field.clone(), serde_json::Value::Array(records));
        target.remove(&field);
        tracing::info!(
            target: "module",
            module,
            param = %format!("{}.*.{}", spec.list, spec.field),
            index = i,
            rows = count,
            cache_key = %key,
            "nested cache key expanded into input"
        );
    }
    Ok(out)
}

/// Replaces declared `<param>CacheKey` arguments with the cached rows — top-level params and
/// nested `<list>.*.<field>` slots alike.
///
/// Returns `Ok(None)` when there is nothing to do — the overwhelmingly common case, and it clones
/// nothing. An unreadable key is an error rather than a silent skip: the alternative is the module
/// failing validation on a missing parameter, which says nothing about the expired key that caused
/// it.
pub fn expand(
    module: &str,
    config: &serde_json::Value,
    input: &serde_json::Value,
    cache: Option<&Arc<SysmodCacheAdapter>>,
) -> Result<Option<serde_json::Value>, String> {
    let params = declared(config);
    if params.is_empty() {
        return Ok(None);
    }
    let Some(obj) = input.as_object() else {
        return Ok(None);
    };

    let mut out: Option<serde_json::Map<String, serde_json::Value>> = None;
    for param in params {
        if let Some(spec) = parse_nested(&param) {
            // Read the list from the working copy when an earlier entry already touched it.
            let source: &serde_json::Map<String, serde_json::Value> = out.as_ref().unwrap_or(obj);
            let Some(list) = source.get(&spec.list).and_then(|v| v.as_array()).cloned() else {
                continue;
            };
            if let Some(expanded) = expand_nested(module, &spec, &list, cache)? {
                let target = out.get_or_insert_with(|| obj.clone());
                target.insert(spec.list.clone(), serde_json::Value::Array(expanded));
            }
            continue;
        }
        let field = key_field(&param);
        let key_owned: Option<String> = obj
            .get(&field)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                // Dialect: the key handed to the VALUE slot — "statements": "<key>" (string
                // coercion then wraps it into a one-item list, so both shapes arrive).
                // The key shape is unmistakable; reading the intent is lossless and saves
                // the relearning round (measured 2026-08-12 turn 39: two rounds burned).
                match obj.get(&param) {
                    Some(serde_json::Value::String(s)) if looks_like_cache_key(s) => {
                        Some(s.trim().to_string())
                    }
                    Some(serde_json::Value::Array(a)) if a.len() == 1 => a[0]
                        .as_str()
                        .filter(|s| looks_like_cache_key(s))
                        .map(|s| s.trim().to_string()),
                    _ => None,
                }
            });
        let Some(key) = key_owned else {
            continue;
        };
        let key = key.as_str();
        let records = read_records(
            cache.ok_or_else(|| {
                format!(
                    "{field} was given but this server has no result cache — send `{param}` directly."
                )
            })?,
            key,
            &field,
        )?;
        // A param declared as an OBJECT receives the record itself, not a one-element list.
        // Whole-object caching (`autoCacheWhole`) stores a multi-section response as a single
        // record; wrapping it in an array here would fail the very schema the expansion exists
        // to satisfy (fa `estimates` is `object|null` — measured 2026-08-11 turn 33).
        let value = if param_wants_object(config, &param)
            && records.len() == 1
            && records[0].is_object()
        {
            records.into_iter().next().unwrap()
        } else {
            serde_json::Value::Array(records)
        };
        let target = out.get_or_insert_with(|| obj.clone());
        target.insert(param.clone(), value);
        // The key itself is dropped: it is not a declared parameter, so leaving it would fail
        // validation on modules whose schema forbids extra properties.
        target.remove(&field);
        tracing::info!(
            target: "module",
            module,
            param = %param,
            cache_key = %key,
            "cache key expanded into input"
        );
    }
    Ok(out.map(serde_json::Value::Object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn cache_with(records: Vec<serde_json::Value>) -> (Arc<SysmodCacheAdapter>, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let c = SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap();
        let key = c.data("m", "a", serde_json::json!({}), records, None).unwrap();
        (Arc::new(c), key, dir)
    }

    #[test]
    fn undeclared_module_is_left_alone() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        let input = serde_json::json!({"barsCacheKey": key});
        let out = expand("m", &serde_json::json!({}), &input, Some(&cache)).unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn declared_key_becomes_the_array_and_the_key_is_dropped() {
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"close": 1}),
            serde_json::json!({"close": 2}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"action": "signals", "barsCacheKey": key});
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        assert_eq!(out["bars"].as_array().unwrap().len(), 2);
        assert_eq!(out["action"], "signals");
        assert!(out.get("barsCacheKey").is_none());
    }

    #[test]
    fn an_inline_array_is_untouched() {
        let (cache, _key, _d) = cache_with(vec![]);
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"bars": [{"close": 1}]});
        assert!(expand("m", &cfg, &input, Some(&cache)).unwrap().is_none());
    }

    #[test]
    fn an_object_param_receives_the_record_itself() {
        // autoCacheWhole stores a multi-section response as ONE record; a param declared
        // `["object","null"]` (fa estimates) must get the object back, not a 1-element list.
        let (cache, key, _d) = cache_with(vec![serde_json::json!({
            "output1": {"name": "x"}, "output2": [1, 2], "output4": [{"dt": "2026E"}],
        })]);
        let cfg = serde_json::json!({
            "cacheInputs": ["estimates"],
            "input": {"properties": {"estimates": {"type": ["object", "null"]}}},
        });
        let input = serde_json::json!({"action": "ratios", "estimatesCacheKey": key});
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        assert!(out["estimates"].is_object(), "{out}");
        assert_eq!(out["estimates"]["output2"].as_array().unwrap().len(), 2);
        assert!(out.get("estimatesCacheKey").is_none());
    }

    #[test]
    fn a_nested_key_expands_into_the_element_and_the_key_is_dropped() {
        // "sheets.*.rows": the 120-day candle sheet gets its real rows, and the sibling sheet
        // that never carried a key is passed through byte-for-byte.
        let (cache, key, _d) = cache_with(vec![
            serde_json::json!({"d": "2026-08-10", "close": 1}),
            serde_json::json!({"d": "2026-08-11", "close": 2}),
            serde_json::json!({"d": "2026-08-12", "close": 3}),
        ]);
        let cfg = serde_json::json!({"cacheInputs": ["blocks", "sheets.*.rows"]});
        let input = serde_json::json!({
            "action": "make_xlsx",
            "sheets": [
                {"name": "요약", "headers": ["k", "v"], "rows": [["a", 1]]},
                {"name": "일봉 (최근 120일)", "headers": ["d", "close"], "rowsCacheKey": key},
            ],
        });
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        let sheets = out["sheets"].as_array().unwrap();
        assert_eq!(sheets[0], input["sheets"][0], "sibling sheet was touched");
        assert_eq!(sheets[1]["rows"].as_array().unwrap().len(), 3);
        assert_eq!(sheets[1]["rows"][2]["close"], 3);
        assert!(sheets[1].get("rowsCacheKey").is_none());
        assert_eq!(sheets[1]["name"], "일봉 (최근 120일)");
        assert_eq!(out["action"], "make_xlsx");
    }

    #[test]
    fn nested_inline_rows_win_over_a_stray_key() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 9})]);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({
            "sheets": [{"name": "s", "rows": [["a", 1]], "rowsCacheKey": key}],
        });
        let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
        let sheet = &out["sheets"][0];
        assert_eq!(sheet["rows"], serde_json::json!([["a", 1]]));
        // The key is still dropped — it is not a declared property of the item.
        assert!(sheet.get("rowsCacheKey").is_none());
    }

    #[test]
    fn a_nested_expired_key_is_an_error_naming_the_element() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        cache.drop_key(&key).unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [{"name": "s", "rowsCacheKey": key}]});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.starts_with("sheets[0].rowsCacheKey:"), "{err}");
    }

    #[test]
    fn a_nested_declaration_without_keys_changes_nothing() {
        let (cache, _key, _d) = cache_with(vec![]);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [{"name": "s", "rows": [["a", 1]]}]});
        assert!(expand("m", &cfg, &input, Some(&cache)).unwrap().is_none());
    }

    #[test]
    fn nested_paths_parse_only_in_the_exact_shape() {
        assert_eq!(
            parse_nested("sheets.*.rows"),
            Some(NestedSpec { list: "sheets".into(), field: "rows".into() })
        );
        assert_eq!(parse_nested("bars"), None);
        assert_eq!(parse_nested("a.*.b.*.c"), None);
        assert_eq!(parse_nested(".*.rows"), None);
        assert_eq!(parse_nested("sheets.*."), None);
        // declared() hands the raw entries on, nested ones included.
        let cfg = serde_json::json!({"cacheInputs": ["blocks", "sheets.*.rows"]});
        assert_eq!(declared(&cfg), vec!["blocks", "sheets.*.rows"]);
    }

    #[test]
    fn a_key_in_the_value_slot_is_read_as_the_key() {
        // "statements": "<key>" and "statements": ["<key>"] — the model hands the key to
        // the value slot; the shape is unmistakable, so the intent is read losslessly.
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"a": 1})]);
        let cfg = serde_json::json!({"cacheInputs": ["statements"]});
        for input in [
            serde_json::json!({"action": "ratios", "statements": key}),
            serde_json::json!({"action": "ratios", "statements": [key]}),
        ] {
            let out = expand("m", &cfg, &input, Some(&cache)).unwrap().unwrap();
            assert_eq!(out["statements"].as_array().unwrap().len(), 1, "{out}");
            assert_eq!(out["statements"][0]["a"], 1);
        }
        // An ordinary string value is NOT mistaken for a key.
        let plain = serde_json::json!({"statements": "hello world"});
        assert!(expand("m", &cfg, &plain, Some(&cache)).unwrap().is_none());
    }

    #[test]
    fn a_whole_entry_key_is_refused_for_nested_rows() {
        // Turn 39: a `…:_` whole-response key in rowsCacheKey shipped an EMPTY 120-day
        // sheet. The label is decisive — refuse with the shape named.
        let dir = tempfile::tempdir().unwrap();
        let c = SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap();
        let key = c
            .data("kiwoom", "ka10081:_", serde_json::json!({}), vec![serde_json::json!({"whole": true})], None)
            .unwrap();
        let cache = Arc::new(c);
        let cfg = serde_json::json!({"cacheInputs": ["sheets.*.rows"]});
        let input = serde_json::json!({"sheets": [{"name": "일봉", "rowsCacheKey": key}]});
        let err = expand("docs", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.contains("WHOLE-response"), "{err}");
        assert!(err.starts_with("sheets[0].rowsCacheKey:"), "{err}");
    }

    #[test]
    fn an_expired_key_is_an_error_naming_the_field() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        cache.drop_key(&key).unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"barsCacheKey": key});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.starts_with("barsCacheKey:"), "{err}");
    }
}

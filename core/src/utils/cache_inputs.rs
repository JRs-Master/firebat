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

use std::sync::Arc;

use crate::utils::sysmod_cache::SysmodCacheAdapter;

/// `bars` → `barsCacheKey`. Convention rather than a second declaration: one name to get wrong
/// instead of two.
pub fn key_field(param: &str) -> String {
    format!("{param}CacheKey")
}

/// Array parameters this module accepts as a cache key. Empty unless declared.
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

/// Replaces declared `<param>CacheKey` arguments with the cached rows.
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
        let field = key_field(&param);
        let Some(key) = obj.get(&field).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(cache) = cache else {
            return Err(format!(
                "{field} was given but this server has no result cache — send `{param}` directly."
            ));
        };
        let records = cache
            .read(key, 0, usize::MAX)
            .map_err(|e| format!("{field}: {e}"))?
            .get("records")
            .and_then(|r| r.as_array())
            .cloned()
            .ok_or_else(|| format!("{field}: cache entry {key} holds no records"))?;
        let target = out.get_or_insert_with(|| obj.clone());
        target.insert(param.clone(), serde_json::Value::Array(records));
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
    fn an_expired_key_is_an_error_naming_the_field() {
        let (cache, key, _d) = cache_with(vec![serde_json::json!({"close": 1})]);
        cache.drop_key(&key).unwrap();
        let cfg = serde_json::json!({"cacheInputs": ["bars"]});
        let input = serde_json::json!({"barsCacheKey": key});
        let err = expand("m", &cfg, &input, Some(&cache)).unwrap_err();
        assert!(err.starts_with("barsCacheKey:"), "{err}");
    }
}

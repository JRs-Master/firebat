//! Tool Call Cache — 도구 호출 idempotency + per-turn duplicate guard.
//!
//! 옛 TS `lib/tool-cache.ts` 1:1 port (Phase B-19 / AiManager A8).
//!
//! 배경: AI 가 timeout/error 응답 받고 같은 인자로 retry 하는 패턴 (CLI 모드 image_gen 비용 폭탄 사건).
//! 백엔드는 정상 처리됐는데 응답만 늦은 상태에서 AI 가 retry → 중복 부작용 발생.
//!
//! 해결: 모든 도구 호출에 일반적으로 적용되는 2-Layer 가드.
//!
//! - **Layer 1 — Cross-turn idempotency cache (60초 TTL)**
//!   같은 (toolName + argsHash) 가 60초 내 호출됐으면 직전 결과 그대로 반환.
//!   AI 가 retry 해도 백엔드는 한 번만 실행. 추가 비용 0.
//! - **Layer 2 — Per-turn duplicate set** (호출자가 turn 안에서 직접 set 관리)
//!   한 turn 안에서 같은 (toolName + argsHash) 두 번째 호출 차단.
//!
//! 일반 로직 — 도구 이름·인자 형태·비용 무관. 모든 도구에 동등 적용.
//!
//! 본 모듈은 Layer 1 cache 만 박힘 (`get_cached_tool_result` / `set_cached_tool_result`).
//! Layer 2 는 호출자 (AiManager.process_with_tools) 가 turn-scope `HashSet<String>` 으로 관리.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_SIZE: usize = 200;

#[derive(Debug, Clone)]
struct CachedEntry {
    result: serde_json::Value,
    inserted_at: Instant,
}

fn cache_lock() -> &'static Mutex<HashMap<String, CachedEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stable JSON stringify — key 순서 무관, 동일 객체는 동일 문자열.
/// 옛 TS `stableStringify` 1:1 port — re-implements canonical sort.
fn stable_stringify(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        serde_json::Value::Array(arr) => {
            let mut out = String::from("[");
            for (i, v) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&stable_stringify(v));
            }
            out.push(']');
            out
        }
        serde_json::Value::Object(map) => {
            // 옛 TS 와 동일하게 key 사전순 정렬
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = String::from("{");
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                out.push_str(&stable_stringify(&map[*k]));
            }
            out.push('}');
            out
        }
    }
}

/// 옛 TS `toolCacheKey(name, args)` 1:1 — `<name>:<sha256(name:canonical_args)[..16]>`.
pub fn tool_cache_key(name: &str, args: &serde_json::Value) -> String {
    let canonical = match args {
        serde_json::Value::Null => stable_stringify(&serde_json::json!({})),
        _ => stable_stringify(args),
    };
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update(b":");
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let hex_str = hex::encode(digest);
    format!("{}:{}", name, &hex_str[..16])
}

/// Cache miss 면 None. Hit 면 cached result.
pub fn get_cached_tool_result(key: &str) -> Option<serde_json::Value> {
    let mut cache = cache_lock().lock().ok()?;
    let entry = cache.get(key)?.clone();
    if entry.inserted_at.elapsed() > CACHE_TTL {
        cache.remove(key);
        return None;
    }
    Some(entry.result)
}

/// 호출 성공 시만 cache. error 결과는 cache 안 함 (다음 호출은 재시도 가능).
/// 옛 TS `setCachedToolResult` 1:1.
pub fn set_cached_tool_result(key: &str, result: &serde_json::Value) {
    // 명시적 실패는 cache 에서 제외 — AI 가 다른 시점에 retry 시 (인프라 회복 등) 재시도 가능
    if result
        .get("success")
        .and_then(|v| v.as_bool())
        .map(|b| !b)
        .unwrap_or(false)
    {
        return;
    }
    let Ok(mut cache) = cache_lock().lock() else {
        return;
    };
    // 크기 제한 — 가장 오래된 entry 제거 (LRU 근사)
    if cache.len() >= MAX_CACHE_SIZE {
        let oldest_key = cache
            .iter()
            .min_by_key(|(_, e)| e.inserted_at)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest_key {
            cache.remove(&k);
        }
    }
    cache.insert(
        key.to_string(),
        CachedEntry {
            result: result.clone(),
            inserted_at: Instant::now(),
        },
    );
}

/// 디버깅·테스트용 — 강제 비우기.
pub fn clear_tool_cache() {
    if let Ok(mut cache) = cache_lock().lock() {
        cache.clear();
    }
}

/// 디버깅용 — 현재 cache 크기.
pub fn tool_cache_size() -> usize {
    cache_lock().lock().map(|c| c.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_state() {
        clear_tool_cache();
    }

    #[test]
    fn key_stable_for_same_args() {
        fresh_state();
        let k1 = tool_cache_key("image_gen", &serde_json::json!({"prompt": "cat"}));
        let k2 = tool_cache_key("image_gen", &serde_json::json!({"prompt": "cat"}));
        assert_eq!(k1, k2);
    }

    #[test]
    fn key_stable_regardless_of_obj_order() {
        fresh_state();
        // serde_json 의 Map 은 입력 순서 유지하지만 stable_stringify 가 key 정렬
        let k1 = tool_cache_key(
            "image_gen",
            &serde_json::json!({"prompt": "cat", "size": "1024x1024"}),
        );
        let k2 = tool_cache_key(
            "image_gen",
            &serde_json::json!({"size": "1024x1024", "prompt": "cat"}),
        );
        assert_eq!(k1, k2);
    }

    #[test]
    fn key_differs_for_different_args() {
        fresh_state();
        let k1 = tool_cache_key("image_gen", &serde_json::json!({"prompt": "cat"}));
        let k2 = tool_cache_key("image_gen", &serde_json::json!({"prompt": "dog"}));
        assert_ne!(k1, k2);
    }

    #[test]
    fn key_differs_for_different_tool_names() {
        fresh_state();
        let args = serde_json::json!({"q": "x"});
        let k1 = tool_cache_key("search_history", &args);
        let k2 = tool_cache_key("search_media", &args);
        assert_ne!(k1, k2);
    }

    #[test]
    fn key_handles_null_args() {
        fresh_state();
        let k1 = tool_cache_key("ping", &serde_json::Value::Null);
        let k2 = tool_cache_key("ping", &serde_json::json!({}));
        // null → {} 로 정규화 — 두 호출은 cache 동일 hit
        assert_eq!(k1, k2);
    }

    #[test]
    fn miss_returns_none() {
        fresh_state();
        let out = get_cached_tool_result("nonexistent:0123456789abcdef");
        assert!(out.is_none());
    }

    #[test]
    fn set_then_get_returns_result() {
        fresh_state();
        let key = tool_cache_key("search_history", &serde_json::json!({"q": "test"}));
        let result = serde_json::json!({"success": true, "data": [1, 2, 3]});
        set_cached_tool_result(&key, &result);
        let cached = get_cached_tool_result(&key).unwrap();
        assert_eq!(cached, result);
    }

    #[test]
    fn failures_not_cached() {
        fresh_state();
        let key = tool_cache_key("flaky", &serde_json::json!({}));
        let failure = serde_json::json!({"success": false, "error": "timeout"});
        set_cached_tool_result(&key, &failure);
        assert!(get_cached_tool_result(&key).is_none());
    }

    #[test]
    fn implicit_success_cached() {
        // success 필드 미박음 결과도 cache (옛 TS 동작과 일치)
        fresh_state();
        let key = tool_cache_key("read", &serde_json::json!({}));
        let result = serde_json::json!({"data": "abc"});
        set_cached_tool_result(&key, &result);
        let cached = get_cached_tool_result(&key);
        assert!(cached.is_some());
    }

    #[test]
    fn size_grows_with_unique_keys() {
        fresh_state();
        let r = serde_json::json!({"success": true});
        for i in 0..5 {
            let k = tool_cache_key("t", &serde_json::json!({"i": i}));
            set_cached_tool_result(&k, &r);
        }
        assert!(tool_cache_size() >= 5);
    }

    #[test]
    fn lru_evicts_oldest_when_full() {
        fresh_state();
        let r = serde_json::json!({"success": true});
        // 200 개 채움 + 추가 1개 → 가장 오래된 1개 제거되어 size <= 200 유지
        for i in 0..MAX_CACHE_SIZE + 1 {
            let k = tool_cache_key("t", &serde_json::json!({"i": i}));
            set_cached_tool_result(&k, &r);
        }
        assert!(tool_cache_size() <= MAX_CACHE_SIZE);
    }
}

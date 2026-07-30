//! Data-on-hand index — what this conversation has already fetched and can still read back.
//!
//! Injected as `<DATA_ON_HAND>` every turn. The problem it solves: history injection carries message
//! text only, so a follow-up turn had no evidence that the previous turn had fetched anything and
//! re-ran the whole discovery ladder from scratch. Only the INDEX goes in (key, what produced it, row
//! count, age) — the records stay in the cache and the model drills in with `cache_read` /
//! `cache_grep` / `cache_aggregate`, which is the same progressive-disclosure shape the rest of the
//! tool surface uses.
//!
//! Scoping is by construction: the keys come from this conversation's own stored turns, so a session
//! can never be shown another session's data even though the cache itself is not partitioned.

use crate::managers::conversation::ConversationManager;
use crate::utils::sysmod_cache::SysmodCacheAdapter;

/// Assistant turns to look back over. Cache TTL is 30 minutes, so anything older has almost always
/// expired — walking further just reads JSON for keys that are gone.
const RECENT_TURNS: usize = 8;
/// Entries to list. Past this the index competes with the rest of the prompt for attention; the
/// newest are the ones a follow-up question is about.
const MAX_ENTRIES: usize = 12;

/// Builds the index, or None when this conversation has no live cached data (the common case — most
/// turns call no tool, and then nothing is injected at all).
pub fn build_index(
    conversation: &ConversationManager,
    cache: &SysmodCacheAdapter,
    owner: &str,
    conv_id: &str,
) -> Option<String> {
    let record = conversation.get(owner, conv_id)?;
    let messages = record.messages.as_array()?;

    let start = messages.len().saturating_sub(RECENT_TURNS * 2);
    let mut keys: Vec<String> = Vec::new();
    for msg in messages[start..].iter().rev() {
        for key in cache_keys_of(msg) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    if keys.is_empty() {
        // Logged so a failed follow-up can be told apart: nothing recorded (this path) vs recorded
        // but expired vs injected-and-ignored. Without the distinction the only observable is "the
        // model fetched again", which has three different causes and three different fixes.
        tracing::debug!(
            target: "data_on_hand",
            conv_id,
            scanned = messages.len() - start,
            "no cache keys recorded in recent turns — nothing to offer"
        );
        return None;
    }

    let now = crate::utils::time::now_ms();
    let keys_seen = keys.len();
    let mut lines: Vec<String> = Vec::new();
    for key in keys {
        // Expired or evicted keys are simply absent — never advertise a key that cannot be read,
        // because a dead pointer costs a wasted round and teaches the model to distrust the index.
        let Some(meta) = cache.meta(&key) else {
            continue;
        };
        let age_min = ((now - meta.created_at).max(0)) / 60_000;
        let expires_min = ((meta.expires_at - now).max(0)) / 60_000;
        let params = params_digest(&meta.params);
        lines.push(format!(
            "- {} — {}.{}{} · {} rows · {}m ago, expires in {}m",
            key, meta.sysmod, meta.action, params, meta.record_count, age_min, expires_min
        ));
        if lines.len() >= MAX_ENTRIES {
            break;
        }
    }
    if lines.is_empty() {
        tracing::debug!(
            target: "data_on_hand",
            conv_id,
            recorded = keys_seen,
            "every recorded cache key has expired — nothing to offer"
        );
        return None;
    }
    tracing::debug!(
        target: "data_on_hand",
        conv_id,
        recorded = keys_seen,
        offered = lines.len(),
        "data-on-hand index injected"
    );

    Some(format!(
        "Already fetched in this conversation and still readable — use cache_read / cache_grep / \
         cache_aggregate on these keys instead of calling the source again.\n{}",
        lines.join("\n")
    ))
}

/// Cache keys recorded on one stored message. Turn data sits under `data` (canonical) but the badge
/// channel also carries a copy at the top level on some paths — read both so the index does not
/// depend on which one wrote this row.
fn cache_keys_of(msg: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for scope in [msg.get("data"), Some(msg)] {
        let Some(results) = scope
            .and_then(|v| v.get("toolResults"))
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for entry in results {
            if let Some(key) = entry
                .get("cacheKey")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                if !out.contains(&key.to_string()) {
                    out.push(key.to_string());
                }
            }
        }
    }
    out
}

/// Short, readable rendering of the params a cached call used, so the model can tell two entries of
/// the same action apart (005930 vs 000660) without reading either.
fn params_digest(params: &serde_json::Value) -> String {
    let Some(obj) = params.as_object() else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in obj {
        let val = match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        if val.is_empty() {
            continue;
        }
        parts.push(format!("{k}={val}"));
        if parts.len() >= 4 {
            break;
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("({})", parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_keys_read_both_channels_and_dedupe() {
        let msg = serde_json::json!({
            "role": "assistant",
            "toolResults": [{"name": "sysmod_dart", "success": true, "cacheKey": "k1"}],
            "data": {"toolResults": [
                {"name": "sysmod_dart", "success": true, "cacheKey": "k1"},
                {"name": "sysmod_yfinance", "success": true, "cacheKey": "k2"},
                {"name": "get_skill", "success": true}
            ]}
        });
        assert_eq!(cache_keys_of(&msg), vec!["k1".to_string(), "k2".to_string()]);
    }

    #[test]
    fn cache_keys_empty_without_any() {
        let msg = serde_json::json!({"role": "user", "content": "hello"});
        assert!(cache_keys_of(&msg).is_empty());
    }

    #[test]
    fn params_digest_names_the_distinguishing_values() {
        let d = params_digest(&serde_json::json!({"stock_code": "005930", "fs_div": "CFS"}));
        assert!(d.contains("stock_code=005930"));
        assert!(d.starts_with('(') && d.ends_with(')'));
    }

    #[test]
    fn params_digest_empty_for_non_object() {
        assert_eq!(params_digest(&serde_json::Value::Null), "");
        assert_eq!(params_digest(&serde_json::json!({})), "");
    }
}

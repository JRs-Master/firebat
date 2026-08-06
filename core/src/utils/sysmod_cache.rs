//! SysmodCacheAdapter — sysmod result cache, JSONL records + meta JSON, with an LRU bound.
//!
//! Large sysmod responses (100+ price rows, 100+ DART filings) never enter the model's context. The
//! caller gets a `_cacheKey` and drills in with read/grep/aggregate instead.
//!
//! - `data` — records[] → JSONL + meta.json, returns the key
//! - `read` — pagination
//! - `grep` — eq/ne/gt/gte/lt/lte/contains/in
//! - `aggregate` — count/sum/avg/min/max
//! - `drop_key` — remove one key
//! - TTL 30 minutes; per-(sysmod+action) LRU of 20 keys + global backstop 1000 — one
//!   producer (a cron) must not evict another's (a chat) keys

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::ports::InfraResult;

const TTL_MS: i64 = 30 * 60 * 1000; // 30분 — drill-in 후속 질문 + 긴 본문 재참조 여유
/// Per-group (sysmod+action) key cap. The cap used to be one global LRU of 100 keys — and the
/// autotrade crons write ~900 keys per half hour, so a chart series a chat had just fetched was
/// evicted minutes later, mid-turn, by `autotrade-gate:trades` churn (2026-08-06 실측: render 가
/// "저장된 것이 없습니다"). One producer must not evict another's keys: each sysmod+action group
/// now buries only its own old keys.
const LRU_PER_GROUP: usize = 20;
/// Backstop so the sum of groups stays bounded (files are small; TTL already bounds lifetime).
const LRU_GLOBAL_CAP: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    pub key: String,
    pub sysmod: String,
    pub action: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(rename = "recordCount")]
    pub record_count: usize,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
}

pub struct SysmodCacheAdapter {
    cache_dir: PathBuf,
    /// In-memory LRU: key -> (last access time, group). Group = "{sysmod}-{action}"; eviction is
    /// per group (see LRU_PER_GROUP). After a restart the map is empty while files survive on
    /// disk — a key touched by a read then re-enters with an empty group, counted only against
    /// the global backstop.
    lru: Mutex<HashMap<String, (i64, String)>>,
}

fn now_ms() -> i64 {
    crate::utils::time::now_ms()
}

impl SysmodCacheAdapter {
    pub fn new(cache_dir: PathBuf) -> InfraResult<Self> {
        std::fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("cache dir 생성 실패: {e}"))?;
        Ok(Self {
            cache_dir,
            lru: Mutex::new(HashMap::new()),
        })
    }

    fn jsonl_path(&self, key: &str) -> PathBuf {
        self.cache_dir.join(format!("{key}.jsonl"))
    }

    fn meta_path(&self, key: &str) -> PathBuf {
        self.cache_dir.join(format!("{key}.meta.json"))
    }

    fn touch(&self, key: &str, group: Option<&str>) {
        let mut evicted: Vec<String> = Vec::new();
        {
            let mut lru = self.lru.lock().unwrap_or_else(|p| p.into_inner());
            // A read-path touch (group unknown) must not erase the group a data() stamp set.
            let g = group
                .map(str::to_string)
                .or_else(|| lru.get(key).map(|(_, g)| g.clone()))
                .unwrap_or_default();
            lru.insert(key.to_string(), (now_ms(), g.clone()));
            // Group cap — the producer buries only its own old keys.
            if !g.is_empty() {
                let mut members: Vec<(String, i64)> = lru
                    .iter()
                    .filter(|(_, (_, mg))| *mg == g)
                    .map(|(k, (t, _))| (k.clone(), *t))
                    .collect();
                if members.len() > LRU_PER_GROUP {
                    members.sort_by_key(|(_, t)| *t);
                    for (k, _) in members.into_iter().take(
                        // len > cap here, so this is at least 1.
                        lru.iter().filter(|(_, (_, mg))| *mg == g).count() - LRU_PER_GROUP,
                    ) {
                        lru.remove(&k);
                        evicted.push(k);
                    }
                }
            }
            // Global backstop.
            while lru.len() > LRU_GLOBAL_CAP {
                let Some((oldest_key, _)) = lru.iter().min_by_key(|(_, (t, _))| *t) else {
                    break;
                };
                let oldest = oldest_key.clone();
                lru.remove(&oldest);
                evicted.push(oldest);
            }
        }
        for k in evicted {
            let _ = self.drop_key(&k);
        }
    }

    pub fn data(
        &self,
        sysmod: &str,
        action: &str,
        params: serde_json::Value,
        records: Vec<serde_json::Value>,
        ttl_sec: Option<i64>,
    ) -> InfraResult<String> {
        let now = now_ms();
        let ttl_ms = ttl_sec.map(|s| s * 1000).unwrap_or(TTL_MS);
        let expires_at = now + ttl_ms;

        // Key = sysmod + action + params hash + creation time.
        let params_hash = {
            let raw = serde_json::to_string(&params).unwrap_or_default();
            let mut h: u64 = 0xcbf29ce484222325;
            for b in raw.bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            format!("{:016x}", h)
        };
        let key = format!("{}-{}-{}-{}", sysmod, action, params_hash, now);

        let mut jsonl = String::new();
        for rec in &records {
            let line = serde_json::to_string(rec)
                .map_err(|e| format!("record 직렬화: {e}"))?;
            jsonl.push_str(&line);
            jsonl.push('\n');
        }
        std::fs::write(self.jsonl_path(&key), jsonl)
            .map_err(|e| format!("cache jsonl write 실패: {e}"))?;

        let meta = CacheMeta {
            key: key.clone(),
            sysmod: sysmod.to_string(),
            action: action.to_string(),
            params,
            record_count: records.len(),
            created_at: now,
            expires_at,
        };
        let meta_raw = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("meta 직렬화: {e}"))?;
        std::fs::write(self.meta_path(&key), meta_raw)
            .map_err(|e| format!("cache meta write 실패: {e}"))?;

        self.touch(&key, Some(&format!("{sysmod}-{action}")));
        Ok(key)
    }

    fn read_records(&self, key: &str) -> InfraResult<Vec<serde_json::Value>> {
        if !self.is_valid(key) {
            // "Expired" and "never existed" call for different next moves — the first means fetch
            // it again and compute before narrating, the second means the key is wrong. Saying
            // only "expired or missing" made a model narrow its analysis window instead of
            // re-fetching (2026-08-05: a long daily series died mid-analysis and the answer came
            // back quietly shortened to six months).
            let detail = match self.deadline_ms(key) {
                Some(dl) => crate::i18n::t(
                    "core.error.cache.expired",
                    None,
                    &[
                        ("key", key),
                        ("ago", &(((now_ms() - dl).max(0)) / 1000).to_string()),
                        ("ttl", &(TTL_MS / 60_000).to_string()),
                    ],
                ),
                None => crate::i18n::t(
                    "core.error.cache.never_stored",
                    None,
                    &[("key", key), ("cap", &LRU_PER_GROUP.to_string())],
                ),
            };
            return Err(detail);
        }
        let raw = std::fs::read_to_string(self.jsonl_path(key))
            .map_err(|e| format!("cache jsonl read 실패: {e}"))?;
        let mut out = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let v: serde_json::Value = serde_json::from_str(line)
                .map_err(|e| format!("cache line 파싱: {e}"))?;
            out.push(v);
        }
        self.touch(key, None);
        Ok(out)
    }

    /// Meta for a key that is still within its TTL, or None (missing / unreadable / expired). Public
    /// so a caller can describe cached data without loading the records — the data-on-hand index a
    /// later turn is shown is built from these.
    pub fn meta(&self, key: &str) -> Option<CacheMeta> {
        let raw = std::fs::read_to_string(self.meta_path(key)).ok()?;
        let meta: CacheMeta = serde_json::from_str(&raw).ok()?;
        (meta.expires_at > now_ms()).then_some(meta)
    }

    fn is_valid(&self, key: &str) -> bool {
        self.meta(key).is_some()
    }

    /// When this key dies, **whether or not it already has**. `meta()` deliberately answers only
    /// for live keys, which is right for reading records and wrong for saying how long there is:
    /// "already gone" and "never existed" are different facts and a caller acts differently on
    /// each. Returns the deadline in epoch ms, or None when nothing was ever written under it.
    pub fn deadline_ms(&self, key: &str) -> Option<i64> {
        let raw = std::fs::read_to_string(self.meta_path(key)).ok()?;
        let meta: CacheMeta = serde_json::from_str(&raw).ok()?;
        Some(meta.expires_at)
    }

    pub fn read(
        &self,
        key: &str,
        offset: usize,
        limit: usize,
    ) -> InfraResult<serde_json::Value> {
        let records = self.read_records(key)?;
        let total = records.len();
        let slice: Vec<serde_json::Value> = records.into_iter().skip(offset).take(limit).collect();
        // success: true 명시 — CLI(cli_claude_code) 가 tool_result 의 success 필드로 done/error 판정.
        // 없으면 false 로 간주돼 빨간 에러 뱃지로 오인됨(실제론 성공). 다른 도구 컨벤션과 일치.
        Ok(serde_json::json!({
            "success": true,
            "records": slice,
            "total": total,
            "offset": offset,
            "limit": limit,
        }))
    }

    pub fn grep(
        &self,
        key: &str,
        field: &str,
        op: &str,
        value: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        let records = self.read_records(key)?;
        let matched: Vec<serde_json::Value> = records
            .into_iter()
            .filter(|r| {
                let actual = crate::utils::path_resolve::resolve_field_path(r, field)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                match op {
                    "eq" | "==" => actual == *value,
                    "ne" | "!=" => actual != *value,
                    "gt" | ">" => num_cmp(&actual, value).map(|o| o > 0).unwrap_or(false),
                    "gte" | ">=" => num_cmp(&actual, value).map(|o| o >= 0).unwrap_or(false),
                    "lt" | "<" => num_cmp(&actual, value).map(|o| o < 0).unwrap_or(false),
                    "lte" | "<=" => num_cmp(&actual, value).map(|o| o <= 0).unwrap_or(false),
                    "contains" => actual
                        .as_str()
                        .map(|s| s.contains(value.as_str().unwrap_or("")))
                        .unwrap_or(false),
                    "in" => value
                        .as_array()
                        .map(|arr| arr.contains(&actual))
                        .unwrap_or(false),
                    _ => false,
                }
            })
            .collect();
        Ok(serde_json::json!({
            "success": true,
            "matched": matched.len(),
            "records": matched,
        }))
    }

    pub fn aggregate(
        &self,
        key: &str,
        field: &str,
        op: &str,
    ) -> InfraResult<serde_json::Value> {
        let records = self.read_records(key)?;
        let mut nums: Vec<f64> = Vec::new();
        for r in &records {
            if let Some(v) = crate::utils::path_resolve::resolve_field_path(r, field) {
                if let Some(n) = v.as_f64() {
                    nums.push(n);
                } else if let Some(s) = v.as_str() {
                    if let Ok(n) = s.parse::<f64>() {
                        nums.push(n);
                    }
                }
            }
        }
        let result = match op {
            "count" => serde_json::json!(records.len()),
            "sum" => serde_json::json!(nums.iter().sum::<f64>()),
            "avg" => {
                if nums.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(nums.iter().sum::<f64>() / nums.len() as f64)
                }
            }
            "min" => nums
                .iter()
                .cloned()
                .fold(f64::INFINITY, f64::min)
                .into(),
            "max" => nums
                .iter()
                .cloned()
                .fold(f64::NEG_INFINITY, f64::max)
                .into(),
            _ => {
                return Err(crate::i18n::t(
                    "core.error.cache.aggregate_unsupported",
                    None,
                    &[("op", op)],
                ))
            }
        };
        Ok(serde_json::json!({
            "success": true,
            "field": field,
            "op": op,
            "value": result,
            "samples": nums.len(),
        }))
    }

    pub fn drop_key(&self, key: &str) -> InfraResult<()> {
        let _ = std::fs::remove_file(self.jsonl_path(key));
        let _ = std::fs::remove_file(self.meta_path(key));
        let mut lru = self.lru.lock().unwrap_or_else(|p| p.into_inner());
        lru.remove(key);
        Ok(())
    }
}

/// Ordering for the comparison ops. Numbers first, then a lexicographic fallback for strings.
///
/// The fallback is the fix for a silent wrong answer: `grep(field="date", op="gte",
/// value="2025-07-31")` on cached candles compared two strings that parse as no number, so every
/// record failed the test and the call returned **zero matches with success: true**. A caller cannot
/// tell that from "there is no data in that range" — the only reason it did not produce a wrong
/// answer on 2026-07-31 was that the model noticed and re-read the whole series instead.
///
/// Lexicographic order is the correct order for the formats this actually meets — ISO dates and
/// timestamps (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM`) sort chronologically as text. It is only compared
/// when both sides are strings, so a numeric field keeps numeric semantics ("9" < "10").
fn num_cmp(a: &serde_json::Value, b: &serde_json::Value) -> Option<i32> {
    let to_num = |v: &serde_json::Value| -> Option<f64> {
        match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        }
    };
    if let (Some(na), Some(nb)) = (to_num(a), to_num(b)) {
        return Some(if na > nb { 1 } else if na < nb { -1 } else { 0 });
    }
    match (a.as_str(), b.as_str()) {
        (Some(sa), Some(sb)) => Some(match sa.cmp(sb) {
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn cache() -> (SysmodCacheAdapter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let c = SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap();
        (c, dir)
    }

    #[test]
    fn data_then_read_pagination() {
        let (c, _dir) = cache();
        let records = vec![
            serde_json::json!({"id": 1, "price": 100}),
            serde_json::json!({"id": 2, "price": 200}),
            serde_json::json!({"id": 3, "price": 300}),
        ];
        let key = c
            .data("yfinance", "history", serde_json::json!({}), records, None)
            .unwrap();
        let result = c.read(&key, 1, 2).unwrap();
        assert_eq!(result["total"], 3);
        assert_eq!(result["records"].as_array().unwrap().len(), 2);
        assert_eq!(result["records"][0]["id"], 2);
    }

    #[test]
    fn grep_filters_records() {
        let (c, _dir) = cache();
        let records = vec![
            serde_json::json!({"id": 1, "price": 100}),
            serde_json::json!({"id": 2, "price": 200}),
        ];
        let key = c
            .data("test", "list", serde_json::json!({}), records, None)
            .unwrap();
        let result = c.grep(&key, "price", "gt", &serde_json::json!(150)).unwrap();
        assert_eq!(result["matched"], 1);
        assert_eq!(result["records"][0]["id"], 2);
    }

    #[test]
    fn grep_compares_iso_dates_as_dates() {
        let (c, _dir) = cache();
        let records = vec![
            serde_json::json!({"date": "2025-07-30", "close": 1}),
            serde_json::json!({"date": "2025-07-31", "close": 2}),
            serde_json::json!({"date": "2026-02-09", "close": 3}),
        ];
        let key = c
            .data("kiwoom", "ka10081", serde_json::json!({}), records, None)
            .unwrap();
        let from = c
            .grep(&key, "date", "gte", &serde_json::json!("2025-07-31"))
            .unwrap();
        assert_eq!(from["matched"], 2);
        assert_eq!(from["records"][0]["close"], 2);
        let before = c
            .grep(&key, "date", "lt", &serde_json::json!("2026-01-01"))
            .unwrap();
        assert_eq!(before["matched"], 2);
    }

    #[test]
    fn grep_keeps_numeric_semantics_for_numeric_strings() {
        // "9" vs "10" must compare as numbers, not as text — the string fallback is only for values
        // that are not numbers at all.
        let (c, _dir) = cache();
        let records = vec![
            serde_json::json!({"qty": "9"}),
            serde_json::json!({"qty": "10"}),
        ];
        let key = c
            .data("test", "list", serde_json::json!({}), records, None)
            .unwrap();
        let r = c.grep(&key, "qty", "gt", &serde_json::json!("9")).unwrap();
        assert_eq!(r["matched"], 1);
        assert_eq!(r["records"][0]["qty"], "10");
    }

    #[test]
    fn aggregate_sum_avg_min_max() {
        let (c, _dir) = cache();
        let records = vec![
            serde_json::json!({"price": 100}),
            serde_json::json!({"price": 200}),
            serde_json::json!({"price": 300}),
        ];
        let key = c
            .data("test", "list", serde_json::json!({}), records, None)
            .unwrap();
        let sum = c.aggregate(&key, "price", "sum").unwrap();
        assert_eq!(sum["value"], 600.0);
        let avg = c.aggregate(&key, "price", "avg").unwrap();
        assert_eq!(avg["value"], 200.0);
    }

    #[test]
    fn drop_removes_files() {
        let (c, _dir) = cache();
        let key = c
            .data("test", "list", serde_json::json!({}), vec![], None)
            .unwrap();
        c.drop_key(&key).unwrap();
        let result = c.read(&key, 0, 10);
        assert!(result.is_err());
    }

    #[test]
    fn group_churn_does_not_evict_other_groups() {
        // The 2026-08-06 incident: cron churn (autotrade-gate) evicted a chat's chart series
        // under the old global cap. A flood in one sysmod+action group must bury only its own
        // old keys.
        let (c, _dir) = cache();
        let chat_key = c
            .data("kiwoom", "ka10081", serde_json::json!({"stk_cd": "005930"}),
                  vec![serde_json::json!({"close": 1})], None)
            .unwrap();
        for i in 0..(LRU_PER_GROUP + 15) {
            let _ = c
                .data("autotrade", "gate", serde_json::json!({"i": i}),
                      vec![serde_json::json!({"i": i})], None)
                .unwrap();
        }
        // The chat key survives the flood…
        assert!(c.read(&chat_key, 0, 1).is_ok(), "chat key must survive cron churn");
        // …and the flooding group stays at its own cap.
        let lru = c.lru.lock().unwrap();
        let gate_count = lru.values().filter(|(_, g)| g == "autotrade-gate").count();
        assert!(gate_count <= LRU_PER_GROUP, "gate group exceeded its cap: {gate_count}");
    }

    #[test]
    fn expired_cache_returns_error() {
        let (c, _dir) = cache();
        let key = c
            .data(
                "test",
                "list",
                serde_json::json!({}),
                vec![serde_json::json!({"x": 1})],
                Some(-1), // expires immediately
            )
            .unwrap();
        let result = c.read(&key, 0, 10);
        assert!(result.is_err());
        // The message is an i18n key now, and asserting on the Korean text would break whenever
        // the wording changed — or, as here, whenever the translation file is not loadable.
        let err = result.unwrap_err();
        assert!(err.contains("cache.expired") || err.contains("만료"), "got {err}");
        // Expired and never-stored are different facts calling for different next moves, so they
        // must not arrive as one message. The deadline survives expiry on purpose — "gone 40
        // seconds ago" is what tells a caller to re-fetch rather than to doubt the key.
        assert!(c.deadline_ms(&key).is_some(), "an expired key still knows when it died");
        let unknown = c.read("test-list-deadbeef-1", 0, 10).unwrap_err();
        assert!(c.deadline_ms("test-list-deadbeef-1").is_none());
        assert_ne!(err, unknown, "expired and never-stored must not read the same");
        assert!(unknown.contains("never_stored") || unknown.contains("저장된 것이 없"),
                "got {unknown}");
    }
}

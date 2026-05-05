//! SysmodCacheAdapter — sysmod 결과 cache JSONL + LRU.
//!
//! 옛 TS 4-29 박힘: 큰 sysmod 응답 (yfinance 시계열 100행+ / DART 공시 100건+) 를 메인 context 안
//! 박지 않고 cacheKey 받아 read/grep/aggregate. JSONL 저장 + meta JSON.
//!
//! Phase B-17.5b minimum:
//! - cache_data — records[] → JSONL 저장 + meta.json
//! - cache_read — pagination + filter
//! - cache_grep — 9 op (eq/ne/gt/gte/lt/lte/contains/in/regex)
//! - cache_aggregate — count/sum/avg/min/max
//! - cache_drop — 단일 키 또는 전체
//! - TTL 5분 (만료 시 자동 정리)
//! - LRU 100개 (capacity 초과 시 가장 오래된 것 정리)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::ports::InfraResult;

const TTL_MS: i64 = 5 * 60 * 1000; // 5분
const LRU_CAPACITY: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// in-memory LRU — 키 → 마지막 access 시각. capacity 초과 시 가장 오래된 것 evict.
    lru: Mutex<HashMap<String, i64>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

    fn touch(&self, key: &str) {
        let mut lru = self.lru.lock().unwrap();
        lru.insert(key.to_string(), now_ms());
        // capacity 초과 → 가장 오래된 것 evict
        if lru.len() > LRU_CAPACITY {
            if let Some((oldest_key, _)) = lru.iter().min_by_key(|(_, t)| **t) {
                let oldest = oldest_key.clone();
                lru.remove(&oldest);
                drop(lru);
                let _ = self.drop_key(&oldest);
            }
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

        // 키 합성 — sysmod + action + params hash (옛 TS 패턴 simplify)
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

        self.touch(&key);
        Ok(key)
    }

    fn read_records(&self, key: &str) -> InfraResult<Vec<serde_json::Value>> {
        if !self.is_valid(key) {
            return Err(format!("cache key={key} 만료됨 또는 미존재"));
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
        self.touch(key);
        Ok(out)
    }

    fn is_valid(&self, key: &str) -> bool {
        let meta_path = self.meta_path(key);
        if !meta_path.exists() {
            return false;
        }
        let raw = match std::fs::read_to_string(&meta_path) {
            Ok(s) => s,
            Err(_) => return false,
        };
        let meta: CacheMeta = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(_) => return false,
        };
        meta.expires_at > now_ms()
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
        Ok(serde_json::json!({
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
            _ => return Err(format!("aggregate op 미지원: {op} (지원: count/sum/avg/min/max)")),
        };
        Ok(serde_json::json!({
            "field": field,
            "op": op,
            "value": result,
            "samples": nums.len(),
        }))
    }

    pub fn drop_key(&self, key: &str) -> InfraResult<()> {
        let _ = std::fs::remove_file(self.jsonl_path(key));
        let _ = std::fs::remove_file(self.meta_path(key));
        let mut lru = self.lru.lock().unwrap();
        lru.remove(key);
        Ok(())
    }
}

fn num_cmp(a: &serde_json::Value, b: &serde_json::Value) -> Option<i32> {
    let to_num = |v: &serde_json::Value| -> Option<f64> {
        match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse().ok(),
            _ => None,
        }
    };
    let na = to_num(a)?;
    let nb = to_num(b)?;
    Some(if na > nb { 1 } else if na < nb { -1 } else { 0 })
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
    fn expired_cache_returns_error() {
        let (c, _dir) = cache();
        let key = c
            .data(
                "test",
                "list",
                serde_json::json!({}),
                vec![serde_json::json!({"x": 1})],
                Some(-1), // 즉시 만료
            )
            .unwrap();
        let result = c.read(&key, 0, 10);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("만료"));
    }
}

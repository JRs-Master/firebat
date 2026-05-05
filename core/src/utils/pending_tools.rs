//! Pending Tools — 승인 필요 도구의 대기 저장소.
//!
//! 옛 TS `lib/pending-tools.ts` 1:1 port (Phase B-19 / AiManager A8 step 3).
//!
//! AI 가 write_file(덮어쓰기) / save_page(덮어쓰기) / delete_file / delete_page / schedule_task
//! 호출 시 즉시 실행하지 않고 여기 저장. 사용자 승인 시 `consume_pending` 으로 실제 실행.
//!
//! **파일 영속화** (`data/pending-tools.json`) — PM2 재시작·서버 리빌드 후에도 planId 유효.
//! - in-memory `RwLock<HashMap>` 1차 캐시 + 파일 영속.
//! - `get_pending` 도 파일 폴백 (멀티 isolate 안전망).
//! - 60초마다 expire 도 파일 영속까지 같이 정리 (불러올 때마다 expired 자동 drop).
//!
//! 옛 TS 와 차이: TypeScript 의 `setInterval` 기반 cleanup → Rust 는 매 호출 시 inline expire 처리
//! (별도 background task 없음). 타이머 race / 종료 hang 위험 0.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const PENDING_EXPIRE: Duration = Duration::from_secs(10 * 60); // 10분
const MAX_SIZE: usize = 100;

/// 승인 대기 도구 1건. JSON 영속 + 메모리 캐시 동일 schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingTool {
    #[serde(rename = "planId")]
    pub plan_id: String,
    /// 도구 이름 (write_file / delete_file / schedule_task / save_page / delete_page).
    pub name: String,
    /// 도구 인자 (LLM 이 박은 그대로).
    #[serde(default)]
    pub args: serde_json::Value,
    /// UI 표시용 한 줄 요약.
    #[serde(default)]
    pub summary: String,
    /// epoch ms — 영속 시 JS 의 `Date.now()` 와 동일 단위.
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn store_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("pending-tools.json")
}

fn store_lock() -> &'static Mutex<HashMap<String, PendingTool>> {
    static STORE: OnceLock<Mutex<HashMap<String, PendingTool>>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut map = HashMap::new();
        // 부팅 시 파일에서 복원 (PM2 재시작 후에도 pending 유지)
        if let Ok(raw) = std::fs::read_to_string(store_file_path()) {
            if let Ok(arr) = serde_json::from_str::<Vec<PendingTool>>(&raw) {
                let now = now_ms();
                for p in arr {
                    if !p.plan_id.is_empty() && now.saturating_sub(p.created_at) <= PENDING_EXPIRE.as_millis() as u64
                    {
                        map.insert(p.plan_id.clone(), p);
                    }
                }
            }
        }
        Mutex::new(map)
    })
}

fn flush(map: &HashMap<String, PendingTool>) {
    let path = store_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let arr: Vec<&PendingTool> = map.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&arr) {
        let _ = std::fs::write(&path, json);
    }
}

fn cleanup_expired(map: &mut HashMap<String, PendingTool>) -> bool {
    let now = now_ms();
    let mut changed = false;
    let expired_ms = PENDING_EXPIRE.as_millis() as u64;
    let to_remove: Vec<String> = map
        .iter()
        .filter(|(_, p)| now.saturating_sub(p.created_at) > expired_ms)
        .map(|(k, _)| k.clone())
        .collect();
    for k in to_remove {
        map.remove(&k);
        changed = true;
    }
    changed
}

/// 4-character random hex (옛 TS `Math.random().toString(36).slice(2, 6)` 등가).
fn rand4() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 2];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// 옛 TS `createPending` 1:1 — `plan-<base36(now)>-<rand4>` planId 발급.
pub fn create_pending(name: &str, args: serde_json::Value, summary: &str) -> String {
    let mut map = match store_lock().lock() {
        Ok(g) => g,
        Err(_) => return String::new(),
    };
    cleanup_expired(&mut map);

    // MAX_SIZE 도달 시 가장 오래된 entry 제거 (LRU 근사)
    if map.len() >= MAX_SIZE {
        let oldest = map
            .iter()
            .min_by_key(|(_, p)| p.created_at)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            map.remove(&k);
        }
    }

    let now = now_ms();
    // base36(now) 흉내 — Rust std 에 base36 없어 `format!("{:x}", now)` (16진) 사용.
    // planId 자체는 unique 만 되면 되므로 base36 vs base16 차이 무관 (옛 TS planId 와 호환 X 는 의도적).
    let plan_id = format!("plan-{:x}-{}", now, rand4());
    map.insert(
        plan_id.clone(),
        PendingTool {
            plan_id: plan_id.clone(),
            name: name.to_string(),
            args,
            summary: summary.to_string(),
            created_at: now,
        },
    );
    flush(&map);
    plan_id
}

/// 옛 TS `getPending` 1:1 — 메모리 → 파일 폴백.
pub fn get_pending(plan_id: &str) -> Option<PendingTool> {
    let mut map = store_lock().lock().ok()?;
    cleanup_expired(&mut map);
    if let Some(p) = map.get(plan_id) {
        return Some(p.clone());
    }
    // 파일 폴백 — 멀티 isolate 안전망
    drop(map);
    let raw = std::fs::read_to_string(store_file_path()).ok()?;
    let arr: Vec<PendingTool> = serde_json::from_str(&raw).ok()?;
    let now = now_ms();
    let expired_ms = PENDING_EXPIRE.as_millis() as u64;
    let mut found = None;
    let mut map = store_lock().lock().ok()?;
    for p in arr {
        if p.plan_id.is_empty() || now.saturating_sub(p.created_at) > expired_ms {
            continue;
        }
        let is_target = p.plan_id == plan_id;
        let cloned = p.clone();
        map.insert(p.plan_id.clone(), p);
        if is_target {
            found = Some(cloned);
        }
    }
    found
}

/// 옛 TS `consumePending` 1:1 — 사용자 ✓승인 시 호출. 메모리 + 파일 정리.
pub fn consume_pending(plan_id: &str) -> Option<PendingTool> {
    // 파일 폴백 거치는 get_pending 통해 메모리에 복원시킨 뒤 삭제
    let p = get_pending(plan_id)?;
    let mut map = store_lock().lock().ok()?;
    map.remove(plan_id);
    flush(&map);
    Some(p)
}

/// 옛 TS `rejectPending` 1:1 — 사용자 ✕거부 시 호출.
pub fn reject_pending(plan_id: &str) -> bool {
    let had = get_pending(plan_id).is_some();
    let Ok(mut map) = store_lock().lock() else {
        return false;
    };
    map.remove(plan_id);
    if had {
        flush(&map);
    }
    had
}

/// 디버깅·테스트용 — 강제 비우기 (메모리만).
pub fn clear_pending_in_memory() {
    if let Ok(mut map) = store_lock().lock() {
        map.clear();
    }
}

/// 디버깅·테스트용 — 메모리 store 크기.
pub fn pending_count() -> usize {
    store_lock().lock().map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 본 모듈은 process-level static + env var 의존이라 테스트 간 격리 안 됨.
    /// `utils::shared_test_lock` 으로 cross-module 직렬화 (plan_store 와 같은 lock 공유).
    fn fresh_state(temp_dir: &std::path::Path) {
        // SAFETY: shared_test_lock 으로 직렬화되어 있어 다른 thread 가 env var 읽고 있을 일 없음.
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", temp_dir);
        }
        clear_pending_in_memory();
        let _ = std::fs::remove_file(temp_dir.join("pending-tools.json"));
    }

    #[test]
    fn create_returns_unique_plan_id() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id1 = create_pending("write_file", serde_json::json!({"path": "a.txt"}), "write a.txt");
        let id2 = create_pending("write_file", serde_json::json!({"path": "b.txt"}), "write b.txt");
        assert!(id1.starts_with("plan-"));
        assert!(id2.starts_with("plan-"));
        assert_ne!(id1, id2);
    }

    #[test]
    fn get_returns_created_pending() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending(
            "delete_file",
            serde_json::json!({"path": "x.txt"}),
            "delete x.txt",
        );
        let p = get_pending(&id).unwrap();
        assert_eq!(p.name, "delete_file");
        assert_eq!(p.summary, "delete x.txt");
    }

    #[test]
    fn consume_removes_pending() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending("save_page", serde_json::json!({"slug": "test"}), "save");
        let p = consume_pending(&id);
        assert!(p.is_some());
        // 두 번째 consume 은 None
        assert!(consume_pending(&id).is_none());
    }

    #[test]
    fn reject_removes_pending() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending("delete_page", serde_json::json!({}), "delete");
        assert!(reject_pending(&id));
        // 두 번째 reject 은 false
        assert!(!reject_pending(&id));
    }

    #[test]
    fn nonexistent_id_returns_none() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        assert!(get_pending("plan-nonexistent").is_none());
        assert!(consume_pending("plan-nonexistent").is_none());
        assert!(!reject_pending("plan-nonexistent"));
    }

    #[test]
    fn file_persistence_survives_memory_clear() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending("write_file", serde_json::json!({"x": 1}), "test");
        // 파일이 박혔는지 확인
        assert!(dir.path().join("pending-tools.json").exists());

        // 메모리 store 강제 비우기 → 파일 폴백으로 복원되어야
        clear_pending_in_memory();
        let p = get_pending(&id);
        assert!(p.is_some());
        assert_eq!(p.unwrap().name, "write_file");
    }
}

//! Pending Tools — 승인 필요 도구의 대기 저장소.
//!
//! 옛 TS `lib/pending-tools.ts` 1:1 port (Phase B-19 / AiManager A8 step 3).
//!
//! AI 가 write_file(덮어쓰기) / save_page(덮어쓰기) / delete_file / delete_page / schedule_task
//! 호출 시 즉시 실행하지 않고 여기 저장. 사용자 승인 시 `consume_pending` 으로 실제 실행.
//!
//! **파일 영속화** (`data/pending-tools.json`) — systemd 재시작·서버 리빌드 후에도 planId 유효.
//! - in-memory `RwLock<HashMap>` 1차 캐시 + 파일 영속.
//! - `get_pending` 도 파일 폴백 (멀티 isolate 안전망).
//! - 60초마다 expire 도 파일 영속까지 같이 정리 (불러올 때마다 expired 자동 drop).
//!
//! 옛 TS 와 차이: TypeScript 의 `setInterval` 기반 cleanup → Rust 는 매 호출 시 inline expire 처리
//! (별도 background task 없음). 타이머 race / 종료 hang 위험 0.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::managers::task::PipelineStep;
use crate::ports::{CronNotify, CronRetry, CronRunWhen};

const PENDING_EXPIRE: Duration = Duration::from_secs(30 * 24 * 60 * 60); // 30일 (만들어두고 한참 뒤 승인하는 패턴 — 검토 중·자리 비움 후 만료 방지. plan_store 와 통일)
const MAX_SIZE: usize = 100;

// ── PendingActionArgs — 6 destructive 도구의 typed oneof ─────────────
// 2026-05-14 A1-full Step 2a: 옛 serde_json::Value args 의 typed 대체.
// name discriminator (write_file / save_page / delete_file / delete_page /
// schedule_task / cancel_cron_job) 로 variant 분기. 호출 site 마이그는 Step 2b.

/// write_file 도구 인자 — 파일 절대 경로 + 내용.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileArgs {
    pub path: String,
    pub content: String,
}

/// save_page 도구 인자 — slug + PageSpec + 덮어쓰기 허용.
/// spec 은 동적 PageSpec schema (24+ block 종류) — serde_json::Value 유지.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePageArgs {
    pub slug: String,
    pub spec: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_overwrite: Option<bool>,
}

/// delete_file 도구 인자.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileArgs {
    pub path: String,
}

/// delete_page 도구 인자.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePageArgs {
    pub slug: String,
}

/// schedule_task 도구 인자 — `CronScheduleOptions` 와 동일 schema + targetPath.
/// pipeline / runWhen / retry / notify 모두 typed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTaskArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay_sec: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<Vec<PipelineStep>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub one_shot: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_when: Option<CronRunWhen>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<CronRetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<CronNotify>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_prompt: Option<String>,
}

/// cancel_cron_job 도구 인자 — jobId 한 개.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTaskArgs {
    pub job_id: String,
}

/// 6 destructive 도구의 typed 인자 oneof — name discriminator.
/// Step 2b 에서 `PendingTool.args` 가 `serde_json::Value` → 이 enum 으로 교체.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case")]
pub enum PendingActionArgs {
    WriteFile(WriteFileArgs),
    SavePage(SavePageArgs),
    DeleteFile(DeleteFileArgs),
    DeletePage(DeletePageArgs),
    ScheduleTask(ScheduleTaskArgs),
    CancelCronJob(CancelTaskArgs),
    /// Approval-gated module action (config `requiresApproval` — real-money orders etc).
    /// Commit runs `ModuleManager.run(module, input)` verbatim.
    RunModule(RunModuleArgs),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunModuleArgs {
    pub module: String,
    /// The full module input as the model sent it (action + params) — replayed on commit.
    pub input: serde_json::Value,
}

/// schedule_task 의 runAt ISO 시각이 이미 과거인지 판정 (옛 TS `Date.parse(runAt) <= Date.now()` 1:1).
/// 파싱 실패 시 false (보수적 — 안전한 쪽이 안 설정). FC(ai.rs)·MCP(pending_or_passthrough) 공용 —
/// 과거 runAt 이면 pending 에 `status:"past-runat"` 를 실어 프론트가 승인 대신 즉시보내기/시간변경
/// 버튼을 띄운다.
pub fn is_past_iso(run_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(run_at)
        .map(|t| t.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
        .unwrap_or(false)
}

/// config `requiresApproval` declaration check — `true` gates every action, an array gates
/// the listed action values. Anything else = no gate.
pub fn requires_approval_value(decl: &serde_json::Value, action: &str) -> bool {
    match decl {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str())
            .any(|s| s == action),
        _ => false,
    }
}

impl PendingActionArgs {
    /// 도구 이름 (write_file / save_page / 등) 반환 — frontend / 로그 / 영속화 용.
    pub fn name(&self) -> &'static str {
        match self {
            PendingActionArgs::WriteFile(_) => "write_file",
            PendingActionArgs::SavePage(_) => "save_page",
            PendingActionArgs::DeleteFile(_) => "delete_file",
            PendingActionArgs::DeletePage(_) => "delete_page",
            PendingActionArgs::ScheduleTask(_) => "schedule_task",
            PendingActionArgs::CancelCronJob(_) => "cancel_cron_job",
            PendingActionArgs::RunModule(_) => "run_module",
        }
    }

    /// LLM 이 보낸 raw `name` + `arguments` 를 typed 으로 parse.
    /// 실패 시 caller 가 LLM 한테 schema 에러 반환 + retry 유도.
    pub fn from_call(name: &str, args: &serde_json::Value) -> Result<Self, String> {
        let mut merged = match args {
            serde_json::Value::Object(_) => args.clone(),
            serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
            _ => {
                return Err(format!(
                    "PendingActionArgs: 인자가 객체여야 합니다 (도구={}, 받음={})",
                    name,
                    args
                ));
            }
        };
        if let serde_json::Value::Object(map) = &mut merged {
            map.insert(
                "name".to_string(),
                serde_json::Value::String(name.to_string()),
            );
            // Pipeline dialect absorber — {tool, args} steps without `type`(플랜 스텝 어휘)
            // would fail the typed parse below. Mirrors the FC-path normalization in ai.rs
            // so the MCP/CLI entry accepts the same dialect (20차 실측 클래스).
            if name == "schedule_task" || name == "run_task" {
                crate::managers::task::normalize_pipeline_dialect(map);
            }
        }
        match serde_json::from_value(merged.clone()) {
            Ok(v) => Ok(v),
            Err(first_err) => {
                // Tolerant rung — CLI 모델이 중첩 객체 필드를 JSON *문자열*로 보내는 방언
                // (2026-07-18 실측: retry="{\"count\":3,\"delayMs\":30000}" → CronRetry 파스 실패
                // → 모델 2회 재시도 낭비). 객체 타입 필드 allowlist 만 unstringify 후 1회 재파스 —
                // write_file.content 같은 정당한 문자열 필드는 건드리지 않는다(repair_tool_args 계보).
                const OBJECT_FIELDS: &[&str] =
                    &["retry", "notify", "runWhen", "inputData", "pipeline", "spec", "input", "args"];
                let mut fixed = false;
                if let serde_json::Value::Object(map) = &mut merged {
                    for k in OBJECT_FIELDS {
                        let parsed = match map.get(*k) {
                            Some(serde_json::Value::String(s)) => serde_json::from_str::<serde_json::Value>(s)
                                .ok()
                                .filter(|p| p.is_object() || p.is_array()),
                            _ => None,
                        };
                        if let Some(p) = parsed {
                            map.insert((*k).to_string(), p);
                            fixed = true;
                        }
                    }
                    if fixed && (name == "schedule_task" || name == "run_task") {
                        crate::managers::task::normalize_pipeline_dialect(map);
                    }
                }
                if fixed {
                    serde_json::from_value(merged).map_err(|e| {
                        format!("PendingActionArgs parse 실패 (도구={}): {}", name, e)
                    })
                } else {
                    Err(format!(
                        "PendingActionArgs parse 실패 (도구={}): {}",
                        name, first_err
                    ))
                }
            }
        }
    }
}

/// 승인 대기 도구 1건. JSON 영속 + 메모리 캐시 동일 schema.
/// 2026-05-14 A1-full Step 2b: 옛 `name + args(Value)` → typed `PendingActionArgs` (tagged enum).
/// args 가 `{ "name": "write_file", "path": "...", ... }` 형태로 serialize — frontend 가 `args.name` 으로 분기.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTool {
    #[serde(rename = "planId")]
    pub plan_id: String,
    /// 도구 인자 (typed). 6 destructive 도구의 oneof.
    pub args: PendingActionArgs,
    /// UI 표시용 한 줄 요약.
    #[serde(default)]
    pub summary: String,
    /// epoch ms — 영속 시 JS 의 `Date.now()` 와 동일 단위.
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    /// Hub visitor scope (`inst:sid`) when this pending was created inside a hub context, else None
    /// (admin). At hub approval time this is used to (1) verify the approving visitor owns this
    /// pending (cross-tenant guard) and (2) re-establish the owner scope for execution.
    #[serde(rename = "hubScope", default, skip_serializing_if = "Option::is_none")]
    pub hub_scope: Option<String>,
}

impl PendingTool {
    /// 도구 이름 — args.name() 의 wrapper. 로그 / 영속화 용 편의.
    pub fn name(&self) -> &'static str {
        self.args.name()
    }
}

fn now_ms() -> u64 {
    crate::utils::time::now_ms_u64()
}

fn store_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("pending-tools.json")
}

fn store_lock() -> &'static Mutex<HashMap<String, PendingTool>> {
    static STORE: OnceLock<Mutex<HashMap<String, PendingTool>>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut map = HashMap::new();
        // 부팅 시 파일에서 복원 (systemd 재시작 후에도 pending 유지)
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
/// 2026-05-14 A1-full Step 2b: args 가 typed `PendingActionArgs`. 호출 site 는 raw LLM 인자 →
/// `PendingActionArgs::from_call(name, value)` 로 먼저 parse 후 이 함수 호출.
pub fn create_pending(args: PendingActionArgs, summary: &str) -> String {
    create_pending_scoped(args, summary, None)
}

/// Like `create_pending` but records the hub visitor `hub_scope` (`inst:sid`) so the hub approval
/// path can cross-tenant-guard + re-establish the owner scope at execution. `None` = admin
/// (no scope check at approval). Hub pending path (mcp_server `pending_or_passthrough`) passes Some.
pub fn create_pending_scoped(args: PendingActionArgs, summary: &str, hub_scope: Option<String>) -> String {
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
            args,
            summary: summary.to_string(),
            created_at: now,
            hub_scope,
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

    fn write_args(path: &str) -> PendingActionArgs {
        PendingActionArgs::WriteFile(WriteFileArgs {
            path: path.to_string(),
            content: String::new(),
        })
    }

    #[test]
    fn create_returns_unique_plan_id() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id1 = create_pending(write_args("a.txt"), "write a.txt");
        let id2 = create_pending(write_args("b.txt"), "write b.txt");
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
            PendingActionArgs::DeleteFile(DeleteFileArgs {
                path: "x.txt".to_string(),
            }),
            "delete x.txt",
        );
        let p = get_pending(&id).unwrap();
        assert_eq!(p.name(), "delete_file");
        assert_eq!(p.summary, "delete x.txt");
    }

    #[test]
    fn consume_removes_pending() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending(
            PendingActionArgs::SavePage(SavePageArgs {
                slug: "test".to_string(),
                spec: serde_json::json!({}),
                allow_overwrite: None,
            }),
            "save",
        );
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

        let id = create_pending(
            PendingActionArgs::DeletePage(DeletePageArgs {
                slug: "page-a".to_string(),
            }),
            "delete",
        );
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

        let id = create_pending(write_args("a.txt"), "test");
        // 파일이 설정되었는지 확인
        assert!(dir.path().join("pending-tools.json").exists());

        // 메모리 store 강제 비우기 → 파일 폴백으로 복원되어야
        clear_pending_in_memory();
        let p = get_pending(&id);
        assert!(p.is_some());
        assert_eq!(p.unwrap().name(), "write_file");
    }

    #[test]
    fn from_call_parses_write_file() {
        let args = serde_json::json!({"path": "a.txt", "content": "hello"});
        let parsed = PendingActionArgs::from_call("write_file", &args).unwrap();
        match parsed {
            PendingActionArgs::WriteFile(w) => {
                assert_eq!(w.path, "a.txt");
                assert_eq!(w.content, "hello");
            }
            _ => panic!("variant 불일치"),
        }
    }

    #[test]
    fn from_call_rejects_unknown_tool() {
        let args = serde_json::json!({"x": 1});
        let err = PendingActionArgs::from_call("unknown_tool", &args).unwrap_err();
        assert!(err.contains("unknown_tool"));
    }

    #[test]
    fn from_call_rejects_missing_field() {
        // write_file 은 path + content 필수 — content 누락 시 fail.
        let args = serde_json::json!({"path": "a.txt"});
        let err = PendingActionArgs::from_call("write_file", &args).unwrap_err();
        assert!(err.contains("write_file"));
    }
}

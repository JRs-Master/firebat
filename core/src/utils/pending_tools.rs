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

tokio::task_local! {
    /// True while serving a request authenticated as a model turn (the internal LLM token or a
    /// hub turn token). The MCP handler sets it; card creation reads it — which is how a card can
    /// know at birth that a conversation will come for it, in a handler that cannot know which.
    pub static BORN_OF_TURN: bool;

    /// True while serving a request a person initiated from the admin screen and confirmed in a
    /// warning dialog. It is the authorisation itself — the dialog names the strategy, the
    /// quantity and whether the order is real, which is more than an approval card can show. Set
    /// by the admin route handler only; a model turn can never enter this scope.
    pub static UI_CONFIRMED: bool;
}

/// Whether this task is a screen action a person already confirmed.
pub fn ui_confirmed() -> bool {
    UI_CONFIRMED.try_with(|b| *b).unwrap_or(false)
}

/// Whether the current task is a model turn's tool call. False outside any scope — an external
/// client, the stdio path, a script.
pub fn born_of_turn() -> bool {
    BORN_OF_TURN.try_with(|b| *b).unwrap_or(false)
}

use serde::{Deserialize, Serialize};

use crate::managers::task::PipelineStep;
use crate::ports::{CronNotify, CronRetry, CronRunWhen};

const PENDING_EXPIRE: Duration = Duration::from_secs(30 * 24 * 60 * 60); // 30일 (만들어두고 한참 뒤 승인하는 패턴 — 검토 중·자리 비움 후 만료 방지. plan_store 와 통일)

/// Approval-gated module actions (orders) expire in minutes, not days.
///
/// The 30-day window above exists so a file or page edit can wait while someone is away — the same
/// edit applied three days later does the same thing. An order does not: it was composed against a
/// price that has since moved, so approving it later executes something nobody actually decided.
/// The danger is not a malicious click but an absent-minded one on a card that has been sitting
/// around, which is exactly what a long window invites.
///
/// Short is affordable here because the card is only for orders a person is watching right now —
/// scheduled trading runs under the cron context, which bypasses cards entirely. If it lapses, the
/// cost is asking again.
const MODULE_ACTION_EXPIRE: Duration = Duration::from_secs(5 * 60);
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

/// save_page arguments — slug + PageSpec + overwrite permission + the four page-metadata fields.
/// `spec` is the dynamic PageSpec schema (24+ block kinds), so it stays a `serde_json::Value`.
///
/// The four metadata fields are here because this struct is the card's memory of the call. The
/// direct save path reads them straight off the model's arguments, but an approval card round-trips
/// through here: whatever this struct does not name, serde drops without a word, and the page is
/// saved as an ungrouped public page no matter what was asked for. Measured 2026-08-29 — a page
/// published with `project` set landed with none, and the loss was invisible from every side
/// (the tool schema declares them, the handler accepts them, `page.save` stores them).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePageArgs {
    pub slug: String,
    pub spec: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_overwrite: Option<bool>,
    /// "published" | "draft" — the save path defaults it when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Project group. The hub commit path ignores this and forces the visitor's own scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// "public" | "password" | "private".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
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

/// config `uiOnly` declaration check — same shape as `requiresApproval` (`true`, or an array of
/// action ids).
///
/// An approval card asks "shall I?" and a model that wants to act will keep asking; some actions
/// should not be reachable by asking at all. Liquidating a book, writing off a phantom quantity or
/// reassigning a position are decisions a person makes in the screen that shows the numbers — the
/// click there IS the authorisation, and it carries the context an approval card cannot (which
/// strategy holds what, at what average). Declared here, refused identically on every surface a
/// model can reach: chat function-calling, MCP, and pipeline steps.
pub fn is_ui_only_value(decl: &serde_json::Value, action: &str) -> bool {
    requires_approval_value(decl, action)
}

/// Dual-home approval verdict (v2 transition): the action's own catalog row (`"approval": true`)
/// ∨ the legacy top-level `requiresApproval` list. OR on purpose — a migration commit must never
/// loosen a gate on a live trading system; the legacy half leaves only after every module's data
/// has moved and the audit says so.
pub fn approval_gated(
    config: &serde_json::Value,
    gates: &crate::utils::action_decl::ActionGates,
    action: &str,
) -> bool {
    gates.approval.contains(action)
        || requires_approval_value(
            config.get("requiresApproval").unwrap_or(&serde_json::Value::Null),
            action,
        )
}

/// Dual-home uiOnly verdict — same transition rule as `approval_gated`.
pub fn ui_only_gated(
    config: &serde_json::Value,
    gates: &crate::utils::action_decl::ActionGates,
    action: &str,
) -> bool {
    gates.ui_only.contains(action)
        || is_ui_only_value(
            config.get("uiOnly").unwrap_or(&serde_json::Value::Null),
            action,
        )
}

/// The refusal a model gets, naming where the action actually lives. i18n-free on purpose: this
/// text is read by a model, not shown in the UI (the UI never hits this path).
pub fn ui_only_refusal(module: &str, action: &str) -> String {
    format!(
        "'{module}.{action}' is not callable by a model — it is a screen action. Tell the user to \
         run it from the module's settings screen, where the numbers it acts on are visible and \
         the confirmation carries them. Read-only actions (status/report/ledger) are available \
         here; use those to explain the situation instead."
    )
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

    /// How long this kind of approval may wait — see `MODULE_ACTION_EXPIRE`.
    pub fn expire_ms(&self) -> u64 {
        match self {
            PendingActionArgs::RunModule(_) => MODULE_ACTION_EXPIRE.as_millis() as u64,
            _ => PENDING_EXPIRE.as_millis() as u64,
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
    /// epoch ms — when this card stops being approvable. Carried on the record rather than derived
    /// at read time so a card can state its own deadline (a five-minute order card that says so is
    /// a different thing to click than one that looks permanent), and so entries written before
    /// per-kind expiry keep the window they were created under.
    #[serde(rename = "expiresAt", default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// Hub visitor scope (`inst:sid`) when this pending was created inside a hub context, else None
    /// (admin). At hub approval time this is used to (1) verify the approving visitor owns this
    /// pending (cross-tenant guard) and (2) re-establish the owner scope for execution.
    #[serde(rename = "hubScope", default, skip_serializing_if = "Option::is_none")]
    pub hub_scope: Option<String>,
    /// The conversation this card was born in, when it was born in one. A card made inside a chat
    /// turn is delivered in that turn's message and lives there; one made from an editor's MCP
    /// client, the CLI or a script has no message to live in.
    ///
    /// Recorded because only the moment of creation knows it. A screen can see whether a card is
    /// on it right now, which is a different question and answers it wrongly the moment you are
    /// looking at another conversation: the card has a home, just not this one. Provenance belongs
    /// on the record next to `hub_scope`, which is here for the same reason.
    #[serde(rename = "conversationId", default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Where the card was born: `Some("turn")` = a model turn made it (a conversation will claim
    /// it, or the grace net catches a crashed turn); `None` = an external client — the external
    /// list's actual audience, shown immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

impl PendingTool {
    /// 도구 이름 — args.name() 의 wrapper. 로그 / 영속화 용 편의.
    pub fn name(&self) -> &'static str {
        self.args.name()
    }

    /// The deadline this card is judged against. Records written before per-kind expiry carry no
    /// deadline; they get the one their kind would have now, so an order card left over from the
    /// old thirty-day window does not keep it.
    pub fn deadline_ms(&self) -> u64 {
        self.expires_at
            .unwrap_or_else(|| self.created_at.saturating_add(self.args.expire_ms()))
    }

    pub fn is_expired(&self, now: u64) -> bool {
        now > self.deadline_ms()
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
                    if !p.plan_id.is_empty() && !p.is_expired(now) {
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
    let to_remove: Vec<String> = map
        .iter()
        .filter(|(_, p)| p.is_expired(now))
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

/// The event bus, registered once at boot so a card can announce itself.
///
/// Every card is born in `create_pending_in`, so the announcement belongs there rather than at
/// each caller — a new creation site would otherwise be silent until someone remembered. Held as
/// a process-wide handle for the same reason the store itself is: this module has no owner to be
/// constructed by, and the callers reach it as a free function.
///
/// Unset in tests and in any binary that never wires it — `announce_pending` is then a no-op, and
/// the panel's poll still finds the card.
static EVENT_SINK: OnceLock<std::sync::Arc<crate::managers::event::EventManager>> = OnceLock::new();

/// Wire the bus. Called once from the binary's startup; later calls are ignored.
pub fn set_event_sink(events: std::sync::Arc<crate::managers::event::EventManager>) {
    let _ = EVENT_SINK.set(events);
}

/// Tell the screen a card is waiting.
///
/// A card created during a chat turn rides that turn's own stream to the user. A card created
/// outside one — an editor's MCP client, the CLI, a script — has no stream to ride, and until now
/// the only thing that found it was a twenty-second poll. This is the push half; the poll stays as
/// the backstop for a client whose SSE has dropped.
fn announce_pending(plan_id: &str, summary: &str) {
    let Some(events) = EVENT_SINK.get() else { return };
    events.emit(crate::managers::event::FirebatEvent {
        event_type: "plan:pending".to_string(),
        data: serde_json::json!({ "planId": plan_id, "summary": summary }),
    });
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
    create_pending_in(args, summary, hub_scope, None)
}

/// The full form: also records **which conversation the card was born in**, when it was born in
/// one. A chat turn delivers its own card in its own message; a card from an editor's MCP client,
/// the CLI or a script has no message to be delivered in and needs somewhere else to be found.
///
/// Only creation knows this. The screen can tell whether a card is currently rendered on it, which
/// is a different question with a different answer as soon as you open another conversation — the
/// card has a home, you are simply not standing in it. So it goes on the record, beside
/// `hub_scope`, which is here for the same reason.
pub fn create_pending_in(
    args: PendingActionArgs,
    summary: &str,
    hub_scope: Option<String>,
    conversation_id: Option<String>,
) -> String {
    let args_name = args.name();
    let hub_dbg = hub_scope.clone();
    let conv_dbg = conversation_id.clone();
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

    // Born of a turn when the caller could say so (the FC path passes the conversation), or when
    // the task itself is a model turn (the MCP path, which cannot pass one).
    let origin = if conversation_id.is_some() || born_of_turn() {
        Some("turn".to_string())
    } else {
        None
    };
    let now = now_ms();
    // base36(now) 흉내 — Rust std 에 base36 없어 `format!("{:x}", now)` (16진) 사용.
    // planId 자체는 unique 만 되면 되므로 base36 vs base16 차이 무관 (옛 TS planId 와 호환 X 는 의도적).
    let plan_id = format!("plan-{:x}-{}", now, rand4());
    let expires_at = now.saturating_add(args.expire_ms());
    map.insert(
        plan_id.clone(),
        PendingTool {
            plan_id: plan_id.clone(),
            args,
            summary: summary.to_string(),
            created_at: now,
            expires_at: Some(expires_at),
            hub_scope,
            conversation_id,
            origin,
        },
    );
    flush(&map);
    // Which bucket this card landed in, said at the moment it is decided. The classification is
    // invisible afterwards: an approved card is consumed, so by the time anyone asks why it showed
    // up in the external list the record is gone — 2026-08-06, a card made in a chat appeared there
    // and reading the route, the gRPC handler and the serde naming all said it should not have.
    // Guessing twice is worse than one line of evidence.
    tracing::info!(
        target: "pending",
        plan_id = %plan_id,
        tool = args_name,
        conversation = conv_dbg.as_deref().unwrap_or("(none — listed as external)"),
        hub = hub_dbg.as_deref().unwrap_or("admin"),
        "pending card created"
    );
    // Release the store before the bus fans out. `emit` calls listeners synchronously, and a
    // listener that reaches back into pending_tools would deadlock against the guard this function
    // otherwise holds to its last line. EventManager takes the same care with its own lock.
    drop(map);
    announce_pending(&plan_id, summary);
    plan_id
}

/// Record after the fact which conversation a card belongs to.
///
/// `create_pending_in` only works for cards the chat turn itself creates. A turn driven by a CLI
/// model creates them somewhere else entirely — the model calls our MCP server, and that handler
/// (`pending_or_passthrough`, `SysmodHandler`) has no idea a conversation exists. Measured
/// 2026-08-06: a card made by asking in a chat was listed as external, because the only path taught
/// about conversations was the one the user does not use.
///
/// The turn does know, though: the CLI adapters lift `{pending, planId}` out of the MCP result into
/// `pending_actions`, so the id arrives back where the conversation id is in scope. So the party
/// that knows writes it, rather than four creation sites each growing an argument they cannot fill.
///
/// Does not overwrite: a card already claimed by a conversation keeps it, and a card that never
/// surfaces in a chat turn (an editor's MCP client, a script) is never claimed at all — which is
/// exactly the cards the external list is for.
pub fn attach_conversation(plan_id: &str, conversation_id: &str) -> bool {
    if plan_id.is_empty() || conversation_id.is_empty() {
        return false;
    }
    let mut map = match store_lock().lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    match map.get_mut(plan_id) {
        Some(p) if p.conversation_id.is_none() => {
            p.conversation_id = Some(conversation_id.to_string());
            flush(&map);
            true
        }
        _ => false,
    }
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
    let mut found = None;
    let mut map = store_lock().lock().ok()?;
    for p in arr {
        if p.plan_id.is_empty() || p.is_expired(now) {
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

/// Every card still waiting, newest first.
///
/// Until this existed a card could only be acted on by someone who already held its `planId`, and
/// the only place a `planId` ever appeared was the chat message that produced it. A card created
/// from anywhere else — an editor's MCP client, the CLI, a script — was written to the store
/// correctly and then had no surface: nothing listed it, so nothing could approve it. Measured
/// 2026-08-05: three `save_page` cards sat in `data/pending-tools.json` for an hour while the
/// caller was told the call had succeeded and the admin screen showed nothing.
///
/// `hub_scope` filters the same way approval does — a visitor sees their own cards, admin sees the
/// ones with no scope. Passing `None` for `scope` means admin and returns only unscoped cards, so
/// this cannot become a way to read across tenants.
///
/// **Cards born in a conversation are left out.** They are delivered in that conversation's own
/// message and are reachable there whenever it is open, so listing them here puts the same
/// approval on screen twice and calls the near one external. What remains is exactly what has no
/// message to live in — and because that no longer depends on which conversation is open, those
/// cards stay visible in every one of them until they are approved or rejected.
pub fn list_pending(scope: Option<&str>) -> Vec<PendingTool> {
    list_pending_at(scope, now_ms())
}

/// The crash net for turn-born cards. A card born of a model turn never belongs in the external
/// list — its conversation claims it at the end of the turn (observed flashing there for exactly
/// that window, 2026-08-06, a write_off card). But a turn that dies between creating the card and
/// claiming it would leave the card invisible everywhere, so an unclaimed turn-born card older
/// than this surfaces after all. External-born cards are listed immediately; this touches only
/// the turn-born.
const CLAIM_GRACE_MS: u64 = 60_000;

fn list_pending_at(scope: Option<&str>, now: u64) -> Vec<PendingTool> {
    // Through `get_pending` semantics: the file is the durable copy, memory is a cache. Load it so
    // a process that never created a card still sees the ones another process left.
    let mut map = match store_lock().lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    cleanup_expired(&mut map);
    if let Ok(raw) = std::fs::read_to_string(store_file_path()) {
        if let Ok(arr) = serde_json::from_str::<Vec<PendingTool>>(&raw) {
            for p in arr {
                if p.plan_id.is_empty() || p.is_expired(now) {
                    continue;
                }
                map.entry(p.plan_id.clone()).or_insert(p);
            }
        }
    }
    let mut out: Vec<PendingTool> = map
        .values()
        .filter(|p| {
            p.hub_scope.as_deref() == scope
                && p.conversation_id.is_none()
                && (p.origin.as_deref() != Some("turn")
                    || now.saturating_sub(p.created_at) >= CLAIM_GRACE_MS)
        })
        .cloned()
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
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
                status: None,
                project: None,
                visibility: None,
                password: None,
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

    fn run_module_args() -> PendingActionArgs {
        PendingActionArgs::RunModule(RunModuleArgs {
            module: "kiwoom".to_string(),
            input: serde_json::json!({"action": "place_order", "side": "buy"}),
        })
    }

    #[test]
    fn an_order_card_expires_in_minutes_not_days() {
        let order = run_module_args().expire_ms();
        let file = write_args("a.txt").expire_ms();
        assert_eq!(order, 5 * 60 * 1000);
        assert!(order < file / 100, "order {order} should be far shorter than file {file}");
    }

    #[test]
    fn a_lapsed_order_card_cannot_be_approved() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending(run_module_args(), "buy 1");
        assert!(get_pending(&id).is_some());

        // Age it past its own deadline — the file is the store, so rewriting it is how time passes.
        {
            let mut map = store_lock().lock().unwrap();
            let p = map.get_mut(&id).unwrap();
            p.created_at -= 6 * 60 * 1000;
            p.expires_at = Some(p.created_at + p.args.expire_ms());
            flush(&map);
        }
        clear_pending_in_memory();
        assert!(get_pending(&id).is_none(), "an order card past its window must not be approvable");
        assert!(consume_pending(&id).is_none());
    }

    #[test]
    fn a_file_card_of_the_same_age_is_still_approvable() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending(write_args("a.txt"), "write");
        {
            let mut map = store_lock().lock().unwrap();
            let p = map.get_mut(&id).unwrap();
            p.created_at -= 6 * 60 * 1000;
            p.expires_at = Some(p.created_at + p.args.expire_ms());
            flush(&map);
        }
        clear_pending_in_memory();
        assert!(get_pending(&id).is_some(), "six minutes is nothing for a file edit");
    }

    #[test]
    fn an_order_written_before_per_kind_expiry_loses_the_old_window() {
        // Entries persisted under the single thirty-day constant carry no deadline. Reading one
        // back must not grant an order card the window it was written with.
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let legacy = PendingTool {
            plan_id: "plan-legacy".to_string(),
            args: run_module_args(),
            summary: "old order".to_string(),
            created_at: now_ms() - 24 * 60 * 60 * 1000, // yesterday
            expires_at: None,
            hub_scope: None,
            conversation_id: None,
            origin: None,
        };
        std::fs::write(dir.path().join("pending-tools.json"),
                       serde_json::to_string(&vec![&legacy]).unwrap()).unwrap();
        clear_pending_in_memory();
        assert!(get_pending("plan-legacy").is_none());
    }

    #[test]
    fn a_card_states_its_own_deadline() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let id = create_pending(run_module_args(), "buy 1");
        let p = get_pending(&id).unwrap();
        let left = p.deadline_ms() - p.created_at;
        assert_eq!(left, 5 * 60 * 1000);
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("expiresAt"), "the deadline must reach whoever renders the card");
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

    /// A card is the only thing that survives between the model's call and the save, so anything
    /// the typed args do not name is gone by commit time — silently, because serde ignores unknown
    /// keys. The four here were dropped that way until 2026-08-29: pages published through the
    /// approval card came out ungrouped and public however they were asked for.
    #[test]
    fn a_save_page_card_carries_the_page_metadata() {
        let args = serde_json::json!({
            "slug": "carom",
            "spec": {"body": []},
            "status": "draft",
            "project": "games",
            "visibility": "password",
            "password": "hunter2",
        });
        let parsed = PendingActionArgs::from_call("save_page", &args).unwrap();
        let PendingActionArgs::SavePage(p) = parsed else { panic!("variant 불일치") };
        assert_eq!(p.status.as_deref(), Some("draft"));
        assert_eq!(p.project.as_deref(), Some("games"));
        assert_eq!(p.visibility.as_deref(), Some("password"));
        assert_eq!(p.password.as_deref(), Some("hunter2"));

        // The commit route reads the card back out of JSON, so the round trip is the real contract.
        let round: PendingActionArgs =
            serde_json::from_value(serde_json::to_value(&p).map(|mut v| {
                v["name"] = serde_json::Value::String("save_page".to_string());
                v
            }).unwrap()).unwrap();
        let PendingActionArgs::SavePage(r) = round else { panic!("variant 불일치") };
        assert_eq!(r.project.as_deref(), Some("games"));
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

    #[test]
    fn list_pending_leaves_out_cards_a_conversation_already_shows() {
        // A card born in a chat turn is delivered in that turn's message. Listing it here too put
        // the same approval on screen twice and labelled the near one external (2026-08-05). What
        // is left has no message to live in — and being independent of which conversation is open,
        // it stays listed in every one of them until it is approved or rejected.
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        let outside = create_pending_in(run_module_args(), "from an editor", None, None);
        let inside = create_pending_in(
            run_module_args(), "from a chat", None, Some("conv-1".to_string()));

        // Past the claim grace: the steady state, not the flash window.
        let listed: Vec<String> = list_pending_at(None, now_ms() + CLAIM_GRACE_MS)
            .into_iter().map(|p| p.plan_id).collect();
        assert!(listed.contains(&outside), "a card with nowhere else to appear must be listed");
        assert!(!listed.contains(&inside), "a card the conversation shows must not be listed");

        // Both remain approvable by id — hiding one from the list is not hiding it from the store.
        assert!(get_pending(&inside).is_some());
        assert_eq!(
            get_pending(&inside).and_then(|p| p.conversation_id),
            Some("conv-1".to_string()));
    }

    #[test]
    fn a_card_a_cli_turn_made_is_claimed_by_that_conversation() {
        // The path a CLI model takes cannot pass a conversation: it calls our MCP server, and that
        // handler only sees a tool call. So the card is born homeless and the chat that asked for it
        // saw it in the "created outside a chat" list (2026-08-06). The turn claims it afterwards,
        // which is the first moment planId and conversation are in the same place.
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        // create_pending_scoped under BORN_OF_TURN = what mcp_server.rs does for a model turn's
        // tool call. Born turn-origin: never in the external list while fresh (no flash), caught
        // by the grace net if the turn dies before claiming, gone from it once claimed.
        let id = BORN_OF_TURN.sync_scope(true, || {
            create_pending_scoped(run_module_args(), "실행 승인: autotrade · resume", None)
        });
        assert!(!list_pending(None).iter().any(|p| p.plan_id == id),
                "a turn-born card must not flash as external while its turn is still running");
        assert!(list_pending_at(None, now_ms() + CLAIM_GRACE_MS).iter().any(|p| p.plan_id == id),
                "a crashed turn's card surfaces after the grace net");

        assert!(attach_conversation(&id, "conv-1"));
        assert!(!list_pending_at(None, now_ms() + CLAIM_GRACE_MS).iter().any(|p| p.plan_id == id),
                "claimed — the chat shows it");

        // Claiming is once: a second turn cannot move a card into its own conversation.
        assert!(!attach_conversation(&id, "conv-2"));
        assert_eq!(get_pending(&id).and_then(|p| p.conversation_id), Some("conv-1".to_string()));

        // An unknown id and an empty conversation change nothing rather than erasing a home.
        assert!(!attach_conversation("plan-nope", "conv-1"));
        let outside = create_pending_scoped(run_module_args(), "from an editor", None);
        assert!(!attach_conversation(&outside, ""));
        // External-born (no turn scope): the list's actual audience, shown immediately.
        assert!(list_pending(None).iter().any(|p| p.plan_id == outside),
                "an external card must be listed at once — no one else will ever show it");
    }
}

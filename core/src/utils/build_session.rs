//! Build Session — Project Builder 의 app-build 표준 플로우 상태 보관소.
//!
//! plan_store 패턴(in-memory `Mutex<HashMap>` + 파일 영속) 차용. TTL 30일 =
//! pending_tools/plan_store 와 통일 (승인/대기 카드 단일 TTL, CLAUDE.md #1-9).
//!
//! Project Builder = 첫 **강제 flow 엔진** — app-build 단계(S1 요구 → S2 설계 → S3 구현 → S4 반복)를
//! 엔진이 순서 강제. plan_mode(유연 프롬프트 prefix) 옆 **별도 레이어** — plan_mode 대체 아님
//! (절차 강제는 도메인에 표준 순서 있을 때만 = SDLC. 임의 작업 plan 은 유연 유지).
//!
//! 본 모듈 = **P1**(엔진 데이터 + 단계 state machine + 영속). AI 통합(P2)·UI(P3)·tier 경로 분기(P4)·
//! cron(P5)은 후속. 단계 전환 게이트만 엔진이 강제하고, 단계 내용은 AI 가 생성(P2).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 30일 — pending_tools/plan_store 와 동일(승인/대기 카드 단일 TTL, #1-9).
const SESSION_EXPIRE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const MAX_SIZE: usize = 50;

/// app-build 표준 단계 — 엔진이 순서 강제. tier 별 skip(예: T1 은 Design 생략)은 P4 advance 분기.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildStep {
    Requirements, // S1 — 요구사항 + tier 분류
    Design,       // S2 — 설계 (컴포넌트 vs html, 모듈 선택/생성)
    Implement,    // S3 — 생성·저장·프리뷰
    Iterate,      // S4 — 반복·수정
    Done,         // 완료
}

impl BuildStep {
    /// 선형 다음 단계. tier 별 분기는 P4 advance 에서 처리.
    pub fn next(self) -> BuildStep {
        match self {
            BuildStep::Requirements => BuildStep::Design,
            BuildStep::Design => BuildStep::Implement,
            BuildStep::Implement => BuildStep::Iterate,
            BuildStep::Iterate | BuildStep::Done => BuildStep::Done,
        }
    }
    /// tier 별 다음 단계 — T1(단순 페이지)은 설계(Design)를 건너뜀 (요구 → 구현). 그 외 tier 는 선형.
    pub fn next_for_tier(self, tier: Option<BuildTier>) -> BuildStep {
        if matches!(tier, Some(BuildTier::T1)) && self == BuildStep::Requirements {
            return BuildStep::Implement;
        }
        self.next()
    }
    /// step_outputs key — 단계 산출물 저장 + 전환 게이트 체크용.
    pub fn key(self) -> &'static str {
        match self {
            BuildStep::Requirements => "requirements",
            BuildStep::Design => "design",
            BuildStep::Implement => "implement",
            BuildStep::Iterate => "iterate",
            BuildStep::Done => "done",
        }
    }
}

/// 복잡도 tier — S1 에서 AI 분류. 경로 분기(P4) 기준. (변형명 T1/T2/T3 그대로 직렬화)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BuildTier {
    T1, // 단순 page (render/html, 모듈 0)
    T2, // 기존 모듈·서비스 호출 page
    T3, // 새 유저모듈 필요 (코드젠)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildStatus {
    Active,
    Completed,
    Abandoned,
}

/// 진행 중인 app-build 1건.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSession {
    pub id: String,
    /// 소속 대화 id — cross-turn 에 ai.rs 가 active_session_for_conv 로 조회 (P2b).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conv_id: Option<String>,
    /// 원 사용자 요청.
    pub request: String,
    /// S1 에서 설정 (분류 전 None).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<BuildTier>,
    pub step: BuildStep,
    pub status: BuildStatus,
    /// 단계별 산출물 (key = BuildStep::key — requirements/design/implement/iterate).
    #[serde(default)]
    pub step_outputs: HashMap<String, serde_json::Value>,
    /// 인터랙티브 게이트 — true 면 advance 거부(사용자 선택 대기). start_build/advance 가 set,
    /// 매 user 턴 시작 시 ai.rs 가 reset_awaiting_for_conv 로 false → advance 는 턴당 1회.
    #[serde(default)]
    pub awaiting_user_input: bool,
    /// "전부 알아서"(한큐) 모드 — true 면 awaiting 게이트 우회(AI 가 끝까지 자동). 사용자가 카드에서 선택.
    #[serde(default)]
    pub auto_advance: bool,
    /// epoch ms.
    pub created_at: u64,
    pub updated_at: u64,
}

fn now_ms() -> u64 {
    crate::utils::time::now_ms_u64()
}

fn store_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("build-sessions.json")
}

fn store_lock() -> &'static Mutex<HashMap<String, BuildSession>> {
    static STORE: OnceLock<Mutex<HashMap<String, BuildSession>>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut map = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(store_file_path()) {
            if let Ok(arr) = serde_json::from_str::<Vec<BuildSession>>(&raw) {
                let now = now_ms();
                let expired_ms = SESSION_EXPIRE.as_millis() as u64;
                for s in arr {
                    if !s.id.is_empty() && now.saturating_sub(s.created_at) <= expired_ms {
                        map.insert(s.id.clone(), s);
                    }
                }
            }
        }
        Mutex::new(map)
    })
}

fn flush(map: &HashMap<String, BuildSession>) {
    let path = store_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let arr: Vec<&BuildSession> = map.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&arr) {
        let _ = std::fs::write(&path, json);
    }
}

fn cleanup_expired(map: &mut HashMap<String, BuildSession>) {
    let now = now_ms();
    let expired_ms = SESSION_EXPIRE.as_millis() as u64;
    let to_remove: Vec<String> = map
        .iter()
        .filter(|(_, s)| now.saturating_sub(s.created_at) > expired_ms)
        .map(|(k, _)| k.clone())
        .collect();
    for k in to_remove {
        map.remove(&k);
    }
}

/// 새 빌드 세션 생성 — status Active, step Requirements(S1). id 반환.
/// conv_id = 소속 대화(cross-turn 조회용, ai.rs 가 주입). None 이면 단일 턴 빌드.
pub fn create_session(conv_id: Option<&str>, request: &str) -> String {
    let id = format!("build_{}", uuid::Uuid::new_v4().simple());
    let Ok(mut map) = store_lock().lock() else {
        return id;
    };
    cleanup_expired(&mut map);
    if map.len() >= MAX_SIZE {
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, s)| s.created_at)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest);
        }
    }
    let now = now_ms();
    map.insert(
        id.clone(),
        BuildSession {
            id: id.clone(),
            conv_id: conv_id.map(String::from),
            request: request.to_string(),
            tier: None,
            step: BuildStep::Requirements,
            status: BuildStatus::Active,
            step_outputs: HashMap::new(),
            awaiting_user_input: true, // start_build 직후 = 기능 선택지 제시하고 사용자 응답 대기 (같은 턴 advance 차단).
            auto_advance: false,
            created_at: now,
            updated_at: now,
        },
    );
    flush(&map);
    id
}

/// 해당 대화의 진행 중(Active) 빌드 세션 — cross-turn 단계 주입용 (가장 최근 1건). ai.rs 가 매 턴 조회.
pub fn active_session_for_conv(conv_id: &str) -> Option<BuildSession> {
    let mut map = store_lock().lock().ok()?;
    cleanup_expired(&mut map);
    map.values()
        .filter(|s| s.status == BuildStatus::Active && s.conv_id.as_deref() == Some(conv_id))
        .max_by_key(|s| s.updated_at)
        .cloned()
}

/// 세션 조회 (메모리 → 파일 폴백).
pub fn get_session(id: &str) -> Option<BuildSession> {
    {
        let mut map = store_lock().lock().ok()?;
        cleanup_expired(&mut map);
        if let Some(s) = map.get(id) {
            return Some(s.clone());
        }
    }
    let raw = std::fs::read_to_string(store_file_path()).ok()?;
    let arr: Vec<BuildSession> = serde_json::from_str(&raw).ok()?;
    let now = now_ms();
    let expired_ms = SESSION_EXPIRE.as_millis() as u64;
    let mut found = None;
    let mut map = store_lock().lock().ok()?;
    for s in arr {
        if s.id.is_empty() || now.saturating_sub(s.created_at) > expired_ms {
            continue;
        }
        let is_target = s.id == id;
        let cloned = s.clone();
        map.insert(s.id.clone(), s);
        if is_target {
            found = Some(cloned);
        }
    }
    found
}

/// 세션 변경 (mutator) — updated_at 자동 갱신 + flush.
pub fn update_session(id: &str, f: impl FnOnce(&mut BuildSession)) -> Option<BuildSession> {
    let mut map = store_lock().lock().ok()?;
    let s = map.get_mut(id)?;
    f(s);
    s.updated_at = now_ms();
    let updated = s.clone();
    flush(&map);
    Some(updated)
}

/// S1 tier 분류 결과 저장.
pub fn set_tier(id: &str, tier: BuildTier) -> Option<BuildSession> {
    update_session(id, |s| s.tier = Some(tier))
}

/// 현재 단계 산출물 저장 (전환 게이트 통과 근거).
pub fn set_step_output(id: &str, output: serde_json::Value) -> Option<BuildSession> {
    update_session(id, |s| {
        let key = s.step.key().to_string();
        s.step_outputs.insert(key, output);
    })
}

/// "전부 알아서"(한큐) 모드 토글 — true 면 advance 가 awaiting 게이트 우회(끝까지 자동). 사용자가 카드에서 선택.
pub fn set_auto_advance(id: &str, auto: bool) -> Option<BuildSession> {
    update_session(id, |s| s.auto_advance = auto)
}

/// 매 user 턴 시작 시 ai.rs 가 호출 — 활성 세션(가장 최근)의 awaiting 해제 → 이번 턴 advance 1회 허용.
/// (인터랙티브 단계 강제: start/advance 가 awaiting=true 로 잠그고, 다음 user 턴에 여기서 푼다.)
pub fn reset_awaiting_for_conv(conv_id: &str) {
    let Ok(mut map) = store_lock().lock() else {
        return;
    };
    let target_id = map
        .values()
        .filter(|s| s.status == BuildStatus::Active && s.conv_id.as_deref() == Some(conv_id))
        .max_by_key(|s| s.updated_at)
        .map(|s| s.id.clone());
    if let Some(id) = target_id {
        let changed = match map.get_mut(&id) {
            Some(s) if s.awaiting_user_input => {
                s.awaiting_user_input = false;
                true
            }
            _ => false,
        };
        if changed {
            flush(&map);
        }
    }
}

/// 다음 단계로 전환 — 게이트: 현재 단계 산출물이 있어야 advance. tier 별 skip 은 P4.
pub fn advance_step(id: &str) -> Result<BuildStep, String> {
    let mut map = store_lock().lock().map_err(|_| "lock 실패".to_string())?;
    let s = map.get_mut(id).ok_or_else(|| format!("빌드 세션 '{id}' 없음"))?;
    if s.status != BuildStatus::Active {
        return Err("이미 종료된 빌드 세션입니다.".to_string());
    }
    // 인터랙티브 게이트 — 이번 턴에 이미 진행했으면(awaiting) 거부 = 한 턴에 한 단계만(사용자 선택 대기).
    // "전부 알아서"(auto_advance) 모드면 우회 = 끝까지 자동(한큐).
    if s.awaiting_user_input && !s.auto_advance {
        return Err("사용자 선택 대기 중입니다 — 단계 선택지를 suggest 로 제시하고 사용자 응답을 받은 뒤 진행하세요. 한 턴에 한 단계만 진행됩니다.".to_string());
    }
    if !s.step_outputs.contains_key(s.step.key()) {
        return Err(format!(
            "현재 단계({})의 산출물이 없어 다음 단계로 진행할 수 없습니다.",
            s.step.key()
        ));
    }
    let next = s.step.next_for_tier(s.tier);
    s.step = next;
    if next == BuildStep::Done {
        s.status = BuildStatus::Completed;
    } else if !s.auto_advance {
        // 다음 단계 선택지 제시 후 사용자 응답 대기 (다음 user 턴에 ai.rs 가 reset). auto 모드면 계속 자동.
        s.awaiting_user_input = true;
    }
    s.updated_at = now_ms();
    flush(&map);
    Ok(next)
}

/// 세션 종료 (완료/포기).
pub fn finish_session(id: &str, completed: bool) -> Option<BuildSession> {
    update_session(id, |s| {
        s.status = if completed {
            BuildStatus::Completed
        } else {
            BuildStatus::Abandoned
        };
    })
}

/// 단계별 AI 지시 — 도구 결과로 반환돼 AI 를 그 단계에 집중시킴 (엔진이 흐름 강제).
/// tier 별 힌트 분기(P4 의 시작 — 본격 경로 skip 은 추후).
pub fn step_prompt(step: BuildStep, tier: Option<BuildTier>) -> String {
    match step {
        BuildStep::Requirements => "S1 기능 선택: 사용자 요청을 바탕으로 이 앱/페이지에 넣을 \
**기능 옵션들을 suggest 칩으로 제시**하고 사용자가 고르게 하세요('추천대로 진행' / '전부 알아서' 옵션도 함께). \
동시에 복잡도 tier 분류 — T1=단순 페이지(render/html, 외부 모듈 0) / T2=기존 모듈·서비스 호출 / T3=새 유저 모듈(코드 생성). \
**사용자가 선택하기 전엔 advance_build 호출 금지** — 칩 제시 후 응답을 기다리세요(엔진이 한 턴 1단계만 허용). \
사용자가 고르면 advance_build(tier, output=선택된 기능, auto=사용자가 '전부 알아서' 고른 경우 true)."
            .to_string(),
        BuildStep::Design => {
            let tier_hint = match tier {
                Some(BuildTier::T1) => "T1: 컴포넌트(render_*) vs HTML iframe + 색/테마/레이아웃 옵션. 외부 모듈 불요.",
                Some(BuildTier::T2) => "T2: 데이터 출처 모듈(sysmod 등) + 디자인 옵션.",
                Some(BuildTier::T3) => "T3: 새 유저 모듈 입출력·로직 + 디자인 옵션.",
                None => "tier 미정 — S1 에서 먼저 분류.",
            };
            format!("S2 디자인 선택: 디자인/테마 옵션을 **suggest 칩으로 제시**하고 사용자가 고르게 하세요('추천대로 진행' 포함). {tier_hint} \
**선택 전 advance_build 금지** — 칩 제시 후 응답 대기. 사용자가 고르면 advance_build(output=디자인 선택).")
        }
        BuildStep::Implement => "S3 구현: 선택된 기능·디자인대로 실제로 만드세요. \
T1/T2 = save_page 로 페이지 생성·발행(승인 카드가 곧 멈춤 지점). T3 = 모듈 코드 생성 후 페이지. \
발행(승인)되면 advance_build(output=slug/url)."
            .to_string(),
        BuildStep::Iterate => "S4 추가 요청: '더 바꿀 게 있나요? / 완료' 를 **suggest 칩으로 묻고** \
**선택 전 advance_build 금지**. 데이터가 주기적으로 바뀌는 빌드(시세·날씨·뉴스 등)면 정기 갱신 cron(schedule_task)을 제안하세요. \
사용자가 '완료'면 advance_build 로 빌드를 끝내세요."
            .to_string(),
        BuildStep::Done => "빌드가 완료되었습니다.".to_string(),
    }
}

/// 디버깅·테스트용.
pub fn clear_sessions_in_memory() {
    if let Ok(mut map) = store_lock().lock() {
        map.clear();
    }
}

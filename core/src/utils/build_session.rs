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
pub fn create_session(request: &str) -> String {
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
            request: request.to_string(),
            tier: None,
            step: BuildStep::Requirements,
            status: BuildStatus::Active,
            step_outputs: HashMap::new(),
            created_at: now,
            updated_at: now,
        },
    );
    flush(&map);
    id
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

/// 다음 단계로 전환 — 게이트: 현재 단계 산출물이 있어야 advance. tier 별 skip 은 P4.
pub fn advance_step(id: &str) -> Result<BuildStep, String> {
    let mut map = store_lock().lock().map_err(|_| "lock 실패".to_string())?;
    let s = map.get_mut(id).ok_or_else(|| format!("빌드 세션 '{id}' 없음"))?;
    if s.status != BuildStatus::Active {
        return Err("이미 종료된 빌드 세션입니다.".to_string());
    }
    if !s.step_outputs.contains_key(s.step.key()) {
        return Err(format!(
            "현재 단계({})의 산출물이 없어 다음 단계로 진행할 수 없습니다.",
            s.step.key()
        ));
    }
    let next = s.step.next();
    s.step = next;
    if next == BuildStep::Done {
        s.status = BuildStatus::Completed;
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
        BuildStep::Requirements => "S1 요구사항: 사용자 요청을 명확히 정리하고 복잡도 tier 를 분류하세요. \
T1=단순 페이지(render/html, 외부 모듈 0) / T2=기존 모듈·서비스 호출 / T3=새 유저 모듈 필요(코드 생성). \
애매하면 사용자에게 먼저 질문. 정리되면 advance_build 에 tier 와 요구사항 요약(output)을 넘기세요."
            .to_string(),
        BuildStep::Design => {
            let tier_hint = match tier {
                Some(BuildTier::T1) => "T1: 컴포넌트(render_*) vs HTML iframe 중 택. 외부 모듈 불요.",
                Some(BuildTier::T2) => "T2: 필요한 기존 모듈/서비스(sysmod 등)와 호출 방식 명시.",
                Some(BuildTier::T3) => "T3: 새 유저 모듈의 입출력·로직 설계 (다음 단계서 코드 생성).",
                None => "tier 미정 — S1 에서 먼저 분류 필요.",
            };
            format!("S2 설계: 산출물 구조를 설계하세요. {tier_hint} 설계가 정리되면 advance_build 에 설계 요약(output)을 넘기세요.")
        }
        BuildStep::Implement => "S3 구현: 설계대로 실제로 만드세요. \
T1/T2 = save_page 로 페이지 생성·발행(승인 카드). T3 = 모듈 코드 생성 후 페이지. \
만들고 프리뷰 확인되면 advance_build 에 결과(slug/url 등, output)를 넘기세요."
            .to_string(),
        BuildStep::Iterate => "S4 반복: 사용자 피드백을 받아 수정하세요. 추가 수정이 없으면 빌드를 완료하세요."
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

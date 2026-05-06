//! ToolDispatcher — 도구 호출 사전 검증 + 승인 게이트.
//!
//! 옛 TS `core/managers/ai/tool-dispatcher.ts` 1:1 port.
//!
//! 책임:
//!   1. `resolve_call_target(identifier)` — AI 가 호출한 변형 (snake/kebab/sysmod_) → 실제 dispatch target.
//!      MCP 서버명·system/user 모듈 경로 매칭. 60초 캐시 (listMcpServers / list_dir 호출 비용 절감).
//!   2. `check_needs_approval(tool_call)` — write_file / save_page / delete_* / schedule_task /
//!      cancel_task 6 케이스. 되돌리기 어려운 작업만 user confirmation.
//!   3. `pre_validate_pending_args(tool_call)` — schedule_task / write_file / save_page 사전 검증.
//!      잘못된 인자로 pending 만드는 헛발질 차단.
//!
//! 분리 이유: dispatch 결정이 멀티턴 루프 본체와 독립.
//! 일반 로직: 도구별 enumerate 가 아닌 패턴 매칭 + 자동 정규화.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::managers::mcp::McpManager;
use crate::managers::page::PageManager;
use crate::managers::schedule::ScheduleManager;
use crate::ports::{IStoragePort, ToolCall};

const CALL_TARGET_TTL: Duration = Duration::from_secs(60);

/// 도구 dispatch 의 실제 대상 — MCP 서버 또는 sandbox execute path.
#[derive(Debug, Clone)]
pub enum CallTarget {
    /// 외부 MCP 서버 — `mcp_<server>_<tool>` 패턴으로 호출.
    Mcp { server: String },
    /// system/user 모듈 — sandbox.execute(path) 으로 호출.
    Execute { path: String },
}

/// 사전 승인 필요 도구의 사용자 표시 요약.
#[derive(Debug, Clone)]
pub struct ApprovalSummary {
    pub summary: String,
}

struct CachedTargets {
    map: HashMap<String, CallTarget>,
    cached_at: Instant,
}

pub struct ToolDispatcher {
    storage: Arc<dyn IStoragePort>,
    /// 옵션 — 박혀있으면 cancel_task / save_page / 외부 MCP 검증 활성. 미박음 시 검증 skip.
    page: Option<Arc<PageManager>>,
    schedule: Option<Arc<ScheduleManager>>,
    mcp: Option<Arc<McpManager>>,
    /// 60초 캐시 — listMcpServers / list_dir 비용 절감.
    cache: Mutex<Option<CachedTargets>>,
}

impl ToolDispatcher {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self {
            storage,
            page: None,
            schedule: None,
            mcp: None,
            cache: Mutex::new(None),
        }
    }

    pub fn with_page(mut self, page: Arc<PageManager>) -> Self {
        self.page = Some(page);
        self
    }

    pub fn with_schedule(mut self, schedule: Arc<ScheduleManager>) -> Self {
        self.schedule = Some(schedule);
        self
    }

    pub fn with_mcp(mut self, mcp: Arc<McpManager>) -> Self {
        self.mcp = Some(mcp);
        self
    }

    /// 변형 매칭 헬퍼 — `id` / `id.replace(_, -)` / `id.replace(-, _)` 셋 다 시도.
    fn lookup_variants(map: &HashMap<String, CallTarget>, id: &str) -> Option<CallTarget> {
        if let Some(t) = map.get(id) {
            return Some(t.clone());
        }
        let snake = id.replace('-', "_");
        if let Some(t) = map.get(&snake) {
            return Some(t.clone());
        }
        let kebab = id.replace('_', "-");
        if let Some(t) = map.get(&kebab) {
            return Some(t.clone());
        }
        None
    }

    /// `resolve_call_target` — AI 가 다양한 변형으로 호출해도 자동 매칭.
    /// 매칭 우선순위: 정확한 이름 → snake/kebab 변형 → sysmod_ 접두사 / full path → None.
    /// 60초 캐시 — listMcpServers / list_dir 호출 비용 절감.
    pub async fn resolve_call_target(&self, identifier: &str) -> Option<CallTarget> {
        if identifier.is_empty() {
            return None;
        }

        // 캐시 hit 검사
        {
            let cache = self.cache.lock().ok()?;
            if let Some(cached) = cache.as_ref() {
                if cached.cached_at.elapsed() < CALL_TARGET_TTL {
                    if let Some(t) = Self::lookup_variants(&cached.map, identifier) {
                        return Some(t);
                    }
                    // cache 안에 미존재 — 새로 빌드 시도 (cache 만료 체크는 위에서)
                    return None;
                }
            }
        }

        // 새 캐시 빌드
        let mut map: HashMap<String, CallTarget> = HashMap::new();

        // 1) 외부 MCP 서버
        if let Some(mcp) = &self.mcp {
            for server in mcp.list_servers() {
                let name = server.name.clone();
                if name.is_empty() {
                    continue;
                }
                let target = CallTarget::Mcp {
                    server: name.clone(),
                };
                map.insert(name.clone(), target.clone());
                map.insert(name.replace('-', "_"), target.clone());
                map.insert(name.replace('_', "-"), target);
            }
        }

        // 2) system + user modules — listDir 폴백 (실패 시 silent)
        for dir in &["system/modules", "user/modules"] {
            if let Ok(entries) = self.storage.list_dir(dir).await {
                for entry in entries.iter().filter(|e| e.is_directory) {
                    let path = format!("{}/{}/index.mjs", dir, entry.name);
                    let target = CallTarget::Execute { path: path.clone() };
                    map.insert(entry.name.clone(), target.clone());
                    map.insert(entry.name.replace('-', "_"), target.clone());
                    map.insert(entry.name.replace('_', "-"), target.clone());
                    map.insert(format!("sysmod_{}", entry.name), target.clone());
                    map.insert(
                        format!("sysmod_{}", entry.name.replace('-', "_")),
                        target.clone(),
                    );
                    map.insert(path, target);
                }
            }
        }

        let result = Self::lookup_variants(&map, identifier);
        if let Ok(mut cache) = self.cache.lock() {
            *cache = Some(CachedTargets {
                map,
                cached_at: Instant::now(),
            });
        }
        result
    }

    /// 사전 승인 필요 여부 판정 — 되돌리기 어려운 작업만 user confirmation.
    /// `None` = 즉시 실행 OK. `Some(summary)` = pending action 으로 UI 표시.
    /// 옛 TS `checkNeedsApproval` 1:1.
    pub async fn check_needs_approval(&self, tc: &ToolCall) -> Option<ApprovalSummary> {
        let args = tc.arguments.as_object()?;
        match tc.name.as_str() {
            "write_file" => {
                let path = args.get("path").and_then(|v| v.as_str())?;
                // 새 파일은 즉시 작성 — 옛 TS 와 동등 (파일 존재 검사 후 수정 시만 승인)
                let exists = self.storage.read(path).await.is_ok();
                if exists {
                    Some(ApprovalSummary {
                        summary: format!("파일 수정: {}", path),
                    })
                } else {
                    None
                }
            }
            "save_page" => {
                let slug = args.get("slug").and_then(|v| v.as_str())?;
                // page builder 박혀있을 때만 검사 — 미박음 시 conservative 박지 않고 즉시 (옛 TS 동등)
                let exists = match &self.page {
                    Some(page) => page.get(slug).is_some(),
                    None => false,
                };
                if exists {
                    Some(ApprovalSummary {
                        summary: format!("페이지 수정: /{}", slug),
                    })
                } else {
                    None
                }
            }
            "delete_file" => {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unknown)");
                Some(ApprovalSummary {
                    summary: format!("파일 삭제: {}", path),
                })
            }
            "delete_page" => {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unknown)");
                Some(ApprovalSummary {
                    summary: format!("페이지 삭제: /{}", slug),
                })
            }
            "schedule_task" => {
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(제목 없음)");
                let when = args
                    .get("cronTime")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| {
                        args.get("runAt")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    })
                    .or_else(|| {
                        args.get("delaySec")
                            .and_then(|v| v.as_i64())
                            .map(|s| format!("{}초 후", s))
                    })
                    .unwrap_or_default();
                Some(ApprovalSummary {
                    summary: format!("예약 등록: {} ({})", title, when),
                })
            }
            "cancel_task" => {
                let job_id = args
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(unknown)");
                // jobId 로 title lookup — UI 가독성 ↑ (schedule manager 박혀있을 때만)
                let label = if let Some(schedule) = &self.schedule {
                    let jobs = schedule.list();
                    let job = jobs.iter().find(|j| j.job_id == job_id);
                    match job.and_then(|j| j.options.title.as_deref()) {
                        Some(t) => format!("{} ({})", t, job_id),
                        None => job_id.to_string(),
                    }
                } else {
                    job_id.to_string()
                };
                Some(ApprovalSummary {
                    summary: format!("예약 해제: {}", label),
                })
            }
            _ => None,
        }
    }

    /// 승인 대기 도구 인자 사전 검증 — 실패 시 에러 메시지 반환 (pending 생성 전 거부).
    /// 옛 TS `preValidatePendingArgs` 1:1. 일반 로직 — pipeline step type 별 필수 필드 검증.
    pub fn pre_validate_pending_args(&self, tc: &ToolCall) -> Option<String> {
        let args = tc.arguments.as_object()?;
        match tc.name.as_str() {
            "schedule_task" => Self::validate_schedule_task(args),
            "write_file" => {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .unwrap_or("");
                if path.is_empty() {
                    return Some("write_file 인자 누락: path 필수.".to_string());
                }
                if args.get("content").is_none() {
                    return Some("write_file 인자 누락: content 필수.".to_string());
                }
                None
            }
            "save_page" => {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .unwrap_or("");
                if slug.is_empty() {
                    return Some("save_page 인자 누락: slug 필수.".to_string());
                }
                if !args.get("spec").is_some_and(|v| v.is_object()) {
                    return Some("save_page 인자 누락: spec 필수.".to_string());
                }
                None
            }
            _ => None,
        }
    }

    fn validate_schedule_task(args: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
        let is_agent = args
            .get("executionMode")
            .and_then(|v| v.as_str())
            .map(|s| s == "agent")
            .unwrap_or(false);
        let has_target = args
            .get("targetPath")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let pipeline = args.get("pipeline").and_then(|v| v.as_array());
        let has_pipeline = pipeline.map(|p| !p.is_empty()).unwrap_or(false);
        let has_agent_prompt = args
            .get("agentPrompt")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        if is_agent {
            if !has_agent_prompt {
                return Some(
                    "schedule_task 인자 누락: agent 모드는 agentPrompt 필수입니다. \
                     트리거 시 AI 에 전달할 자연어 instruction \
                     (잡 목적·필요 데이터·출력 형식·알림) 작성하세요."
                        .to_string(),
                );
            }
        } else if !has_target && !has_pipeline {
            return Some(
                "schedule_task 인자 누락: targetPath 또는 pipeline 중 하나는 반드시 지정해야 합니다. \
                 (agent 모드면 executionMode:\"agent\" + agentPrompt)"
                    .to_string(),
            );
        }

        let has_when = args.get("cronTime").is_some()
            || args.get("runAt").is_some()
            || args.get("delaySec").is_some();
        if !has_when {
            return Some(
                "schedule_task 인자 누락: cronTime / runAt / delaySec 중 하나는 반드시 지정해야 합니다."
                    .to_string(),
            );
        }

        // pipeline step 별 필수 필드 검증 (일반 로직 — type 별 분기)
        if let Some(pipeline) = pipeline {
            for (i, step) in pipeline.iter().enumerate() {
                let step_num = i + 1;
                let step_obj = match step.as_object() {
                    Some(o) => o,
                    None => return Some(format!("[Step {}] step이 객체가 아닙니다.", step_num)),
                };
                let step_type = step_obj.get("type").and_then(|v| v.as_str());
                let t = match step_type {
                    Some(t) if !t.is_empty() => t,
                    _ => return Some(format!(
                        "[Step {}] type 누락 — EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION 중 하나를 지정하세요.",
                        step_num
                    )),
                };
                if !matches!(
                    t,
                    "EXECUTE" | "MCP_CALL" | "NETWORK_REQUEST" | "LLM_TRANSFORM" | "CONDITION"
                ) {
                    return Some(format!("[Step {}] 알 수 없는 type: {}", step_num, t));
                }
                if let Some(err) = Self::validate_step_fields(step_num, t, step_obj) {
                    return Some(err);
                }
            }
        }
        None
    }

    /// step type 별 필수 필드 검증 — 일반 로직 (옛 TS preValidatePendingArgs 1:1).
    fn validate_step_fields(
        step_num: usize,
        step_type: &str,
        step: &serde_json::Map<String, serde_json::Value>,
    ) -> Option<String> {
        match step_type {
            "EXECUTE" => {
                if !step.get("path").is_some_and(|v: &serde_json::Value| v.is_string()) {
                    return Some(format!(
                        "[Step {}] EXECUTE에 path 필수 (예: system/modules/kakao-talk/index.mjs).",
                        step_num
                    ));
                }
                let input_data = step.get("inputData").and_then(|v| v.as_object());
                if input_data.is_none() || input_data.unwrap().is_empty() {
                    return Some(format!(
                        "[Step {}] EXECUTE 인자 오류: 모듈 실행 파라미터는 step 평면이 아니라 \
                         inputData 객체에 넣어야 합니다. \
                         잘못: {{type:\"EXECUTE\",path:\"...\",action:\"price\",symbol:\"...\"}} · \
                         올바름: {{type:\"EXECUTE\",path:\"...\",inputData:{{action:\"price\",symbol:\"...\"}}}}",
                        step_num
                    ));
                }
                None
            }
            "MCP_CALL" => {
                if !step.get("server").is_some_and(|v: &serde_json::Value| v.is_string())
                    || !step.get("tool").is_some_and(|v: &serde_json::Value| v.is_string())
                {
                    Some(format!("[Step {}] MCP_CALL에 server, tool 필수.", step_num))
                } else {
                    None
                }
            }
            "NETWORK_REQUEST" => {
                if !step.get("url").is_some_and(|v: &serde_json::Value| v.is_string()) {
                    Some(format!("[Step {}] NETWORK_REQUEST에 url 필수.", step_num))
                } else {
                    None
                }
            }
            "LLM_TRANSFORM" => {
                if !step.get("instruction").is_some_and(|v: &serde_json::Value| v.is_string()) {
                    Some(format!(
                        "[Step {}] LLM_TRANSFORM에 instruction 필수.",
                        step_num
                    ))
                } else {
                    None
                }
            }
            "CONDITION" => {
                if !step.get("field").is_some_and(|v: &serde_json::Value| v.is_string())
                    || !step.get("op").is_some_and(|v: &serde_json::Value| v.is_string())
                {
                    Some(format!("[Step {}] CONDITION에 field, op 필수.", step_num))
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

// Tests 이관 — `infra/tests/ai_tool_dispatcher_test.rs` (integration test).

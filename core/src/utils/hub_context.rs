//! Hub context 식별 — 턴별 토큰 키 맵 + MCP 요청당 task-local 스코프.
//!
//! CLI 모델의 자체 MCP loop 안에서 sysmod_* / destructive 호출이 어느 hub visitor 쪽인지 식별해
//! owner 격리 + allowed_sysmods 검사 + 미허용 reject. admin chat = hub_context 미설정 = 무제한 허용.
//!
//! 동시 visitor race fix (옛 단일 ActiveHubContext static): hub CLI 는 공유 HTTP MCP(:50052)에 붙어
//! 동시 visitor 가 같은 전역 1개를 덮어쓰면 A 의 도구 호출이 B 의 owner/context 를 읽어 답이 꼬이고
//! 자료가 새던 버그가 있었다. 닫는 방식:
//! - ai.rs 가 턴마다 고유 토큰 발급 → HUB_CONTEXTS 맵에 (토큰→컨텍스트) 등록 + 그 토큰을 mcp_token 으로 주입.
//! - CLI 가 그 토큰으로 MCP 호출 → handle_rpc 가 토큰으로 컨텍스트를 찾아 요청 단위 task-local(CURRENT_HUB)에 set.
//! - active_* 는 CURRENT_HUB(task-local)만 읽음 → 동시 요청이 서로 격리.
//!
//! ai.rs FC 경로(effective_tools 필터)는 permits_tool 에 allowed_sysmods 를 직접 넘겨 별도 격리(전역 무관).

use std::collections::BTreeMap;
use std::sync::RwLock;

#[derive(Clone, Debug)]
pub struct ActiveHubContext {
    pub allowed_sysmods: Vec<String>,
    /// owner 주입용 — hosted/MCP 경로(CLI)는 ai.rs FC owner 주입을 우회하므로, MCP dispatch 가
    /// 이 값으로 owner/hubOwner/project 를 args 에 주입해야 hub 자료가 올바른 owner 로 저장된다.
    pub instance_id: String,
    pub session_id: String,
    /// admin 이 이 hub 에 공유한 Library Reference ID 들 — MCP search_library 가 본인(owner) 자료에
    /// 더해 이 공유분도 검색하게 한다 (위젯 챗봇이 admin 지식베이스로 답하도록). 빈 배열 = 공유 0.
    pub allowed_references: Vec<String>,
}

/// 턴별 토큰 → 컨텍스트. ai.rs HubContextGuard::enter 가 등록, guard drop 시 제거.
/// MCP verify_token 이 등록 여부로 인증, handle_rpc 가 lookup 해서 요청 단위 CURRENT_HUB 에 주입.
/// (BTreeMap::new() 는 const-fn 이라 Lazy/once_cell 의존 없이 static 초기화 가능.)
static HUB_CONTEXTS: RwLock<BTreeMap<String, ActiveHubContext>> = RwLock::new(BTreeMap::new());

tokio::task_local! {
    /// MCP 요청 1건 동안의 hub 컨텍스트 — handle_rpc 가 토큰으로 lookup 해 scope 로 set.
    /// None = admin. 스코프 밖(stdio/test/내부 호출) = 미설정 → active_* 가 None(admin) 취급.
    pub static CURRENT_HUB: Option<ActiveHubContext>;
}

/// RAII guard — enter(...) 가 턴별 고유 토큰 발급 + 맵 등록, drop 시 등록 해제.
pub struct HubContextGuard {
    token: String,
}

impl HubContextGuard {
    /// 턴별 고유 토큰 발급 + (토큰→컨텍스트) 맵 등록. `(guard, token)` 반환 — token 을 mcp_token 으로
    /// 주입하면 그 턴의 CLI MCP 호출이 이 컨텍스트로만 격리된다(동시 visitor race 차단). drop 시 제거.
    pub fn enter(
        allowed_sysmods: Vec<String>,
        instance_id: String,
        session_id: String,
        allowed_references: Vec<String>,
    ) -> (Self, String) {
        let token = new_turn_token(&instance_id, &session_id);
        if let Ok(mut map) = HUB_CONTEXTS.write() {
            map.insert(
                token.clone(),
                ActiveHubContext {
                    allowed_sysmods,
                    instance_id,
                    session_id,
                    allowed_references,
                },
            );
        }
        (Self { token: token.clone() }, token)
    }
}

impl Drop for HubContextGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = HUB_CONTEXTS.write() {
            map.remove(&self.token);
        }
    }
}

/// 턴별 고유 MCP 토큰 — instance/session + 단조 카운터 + 시각. localhost 내부 상관용(외부 노출 0).
fn new_turn_token(instance_id: &str, session_id: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "hubturn-{}-{}-{}-{}",
        instance_id,
        session_id,
        crate::utils::time::now_ms(),
        n
    )
}

/// 토큰이 등록된 hub 턴 토큰인지 — MCP verify_token 인증용.
pub fn is_registered_token(token: &str) -> bool {
    HUB_CONTEXTS
        .read()
        .map(|m| m.contains_key(token))
        .unwrap_or(false)
}

/// 토큰으로 컨텍스트 조회 — MCP handle_rpc 가 CURRENT_HUB 스코프에 주입.
pub fn lookup(token: &str) -> Option<ActiveHubContext> {
    HUB_CONTEXTS.read().ok().and_then(|m| m.get(token).cloned())
}

/// 현재 요청의 hub context 의 (instance_id, session_id) — MCP 경로 owner 주입용. None = admin.
pub fn active_hub_owner() -> Option<(String, String)> {
    CURRENT_HUB
        .try_with(|c| {
            c.as_ref()
                .map(|x| (x.instance_id.clone(), x.session_id.clone()))
        })
        .ok()
        .flatten()
}

/// 현재 요청의 admin 공유 reference id 들 — MCP search_library 가 본인 자료에 합쳐 검색.
/// None = admin 영역(hub 아님), Some(빈) = hub 인데 공유 0.
pub fn active_allowed_references() -> Option<Vec<String>> {
    CURRENT_HUB
        .try_with(|c| c.as_ref().map(|x| x.allowed_references.clone()))
        .ok()
        .flatten()
}

/// 현재 hub visitor 요청 중인지 — MCP handler 가 destructive / sysmod_* 처리 시 분기.
pub fn is_hub_context_active() -> bool {
    CURRENT_HUB.try_with(|c| c.is_some()).unwrap_or(false)
}

/// 현재 요청의 allowed_sysmods 복제 반환. None = admin 영역.
pub fn active_allowed_sysmods() -> Option<Vec<String>> {
    CURRENT_HUB
        .try_with(|c| c.as_ref().map(|x| x.allowed_sysmods.clone()))
        .ok()
        .flatten()
}

/// hub 핵심 사이드바 sysmod — admin 의 per-hub allowed_sysmods 와 무관하게 항상 허용.
/// hub 가 admin 사이드바 경험(메모·캘린더)을 가지려면 필수이고, 데이터는 owner-scope 라 격리됨.
/// 외부 데이터 도구(law-search/yfinance/kakao 등)는 per-hub allowed_sysmods 로 제어.
pub const CORE_SYSMODS: &[&str] = &["notes", "calendar"];

/// MCP server 의 sysmod handler 에서 호출 — hub context 가 활성이고 sysmod 가 미허용이면 true.
/// admin 호출 (Guard 미설정) = false (정공 허용). 핵심 sysmod(notes/calendar)는 항상 허용.
pub fn is_sysmod_blocked_for_hub(sysmod_name: &str) -> bool {
    match active_allowed_sysmods() {
        None => false,
        Some(allowed) => {
            !CORE_SYSMODS.contains(&sysmod_name) && !allowed.iter().any(|s| s == sysmod_name)
        }
    }
}

/// hub principal 이 도구 `name` 을 호출할 수 있는지 — **단일 권한 게이트**.
/// FC 경로(ai.rs effective_tools 필터)와 hosted 경로(mcp_server)가 모두 이걸 통해 판정 → 규칙 drift 0.
///
/// 허용: 핵심 sysmod(notes/calendar) + per-hub allowed_sysmods 의 sysmod + read-only(list/get/search/cache)
///       + render(_*) + suggest + propose_plan + save_page + ① 필수-on owner-scoped 쓰기(is_hub_writable_builtin).
/// 거부(기본 deny): request_secret/network_request(③deny Vault·SSRF) / run_module·execute(sysmod allow 우회) /
///       schedule_task·run_task·run_cron_job(배경 실행·남용) / *_module·mcp_*·log(admin). 명시 허용에 없으면 차단 = fail-safe.
pub fn permits_tool(name: &str, allowed_sysmods: &[String]) -> bool {
    if let Some(sysmod) = name.strip_prefix("sysmod_") {
        // MCP 도구명은 모듈명의 dash 를 underscore 로 바꿔 등록한다(kma-weather → sysmod_kma_weather).
        // 비교 전 underscore → dash 복원 — 안 하면 다단어 sysmod(kma-weather/naver-search/law-search 등)가
        // allowed_sysmods(대시 보유)와 영영 안 맞아 허용돼도 무조건 차단된다. (is_tool_visible 의 dash join 과 일관.)
        let module = sysmod.replace('_', "-");
        return CORE_SYSMODS.contains(&module.as_str())
            || allowed_sysmods.iter().any(|s| s == &module);
    }
    // ③deny / admin / 배경실행 — list_/get_ 접두어라 is_hub_readonly_tool 에 잡히는 admin 조회까지 우선 차단.
    if is_hub_denied_tool(name) {
        return false;
    }
    is_hub_readonly_tool(name)
        || is_hub_writable_builtin(name)
        || name.starts_with("render_")
        || name == "save_page"
}

/// hub 에서 **명시 차단**할 도구 — readonly 접두어(list_/get_)에 잡히는 admin 조회까지 포함해 우선 차단.
/// (a) ③deny: request_secret/network_request(Vault·SSRF) (b) 임의 실행/우회: run_module/execute
/// (c) 배경 실행(남용 — QueueManager 전까지 보류): schedule_task/run_task/run_cron_job
/// (d) admin/시스템/모듈/mcp/로그 관리: list_system_modules/get_module_config/list_mcp_servers/query_logs 등.
fn is_hub_denied_tool(name: &str) -> bool {
    matches!(
        name,
        "request_secret"
            | "network_request"
            | "run_module"
            | "execute"
            | "schedule_task"
            | "run_task"
            | "run_cron_job"
            | "list_system_modules"
            | "list_user_modules"
            | "get_module_config"
            | "get_module_schema"
            | "install_packages"
            | "get_package_status"
            | "list_mcp_servers"
            | "list_mcp_tools"
            | "call_mcp_tool"
            | "mcp_call"
            | "set_log_filter"
            | "query_logs"
            | "get_memory_stats"
    )
}

/// hub visitor 가 **자기 owner-scope 자료**를 생성/수정/삭제하는 내장 도구 — ① 필수-on 의 write.
/// owner 자동 주입으로 visitor 간 격리되므로 허용해도 안전. **배경 실행·전역·민감 도구는 제외**(default-deny):
/// schedule_task/run_task/run_cron_job(배경 실행·남용), run_module/execute(sysmod allow-list 우회),
/// request_secret/network_request(③deny Vault·SSRF), *_module/mcp_*/log(admin) 은 여기에 없어 차단된다.
/// 새 owner-scoped 쓰기 도구 추가 시 여기 등록 (없으면 hub 에서만 안 됨 = 보안상 안전한 누락).
fn is_hub_writable_builtin(name: &str) -> bool {
    matches!(
        name,
        "save_entity"
            | "save_fact"
            | "consolidate_conversation"
            | "delete_page"
            | "delete_project"
            | "write_file"
            | "delete_file"
            | "regenerate_image"
            | "save_template"
            | "delete_template"
    )
}

/// hub visitor 에게 허용할 read-only/안전 도구 판정 — **단일 소스**.
/// FC 경로(ai.rs hub tool filter)와 hosted 경로(mcp_server ToolManagerProxyHandler)가 모두 호출 →
/// 두 곳에 중복 박혀 drift 나던 allow 규칙 통일. 정보 조회·시각화·제안만 허용(destructive·admin 제외).
/// sysmod_* 는 allowed_sysmods 별도 검사, save_page(hub-scoped)·render_* 레거시는 호출처가 추가 허용.
pub fn is_hub_readonly_tool(name: &str) -> bool {
    name.starts_with("list_")
        || name.starts_with("get_")
        || name.starts_with("search_")
        || name.starts_with("cache_")
        || name == "render"
        || name == "suggest"
        || name == "propose_plan"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_scope_means_admin_context() {
        // CURRENT_HUB 스코프 밖 = admin (task-local 미설정).
        assert!(!is_hub_context_active());
        assert!(active_allowed_sysmods().is_none());
        assert!(!is_sysmod_blocked_for_hub("telegram"));
    }

    #[test]
    fn scope_activates_and_filters_sysmods() {
        let ctx = ActiveHubContext {
            allowed_sysmods: vec!["notes".to_string(), "calendar".to_string()],
            instance_id: "inst".to_string(),
            session_id: "sess".to_string(),
            allowed_references: vec![],
        };
        CURRENT_HUB.sync_scope(Some(ctx), || {
            assert!(is_hub_context_active());
            assert!(!is_sysmod_blocked_for_hub("notes"));
            assert!(!is_sysmod_blocked_for_hub("calendar"));
            assert!(is_sysmod_blocked_for_hub("telegram"));
            assert!(is_sysmod_blocked_for_hub("kiwoom"));
        });
        // 스코프를 벗어나면 다시 admin.
        assert!(!is_hub_context_active());
    }

    #[test]
    fn guard_registers_token_and_drop_unregisters() {
        let (guard, token) = HubContextGuard::enter(
            vec!["notes".to_string()],
            "inst".to_string(),
            "sess".to_string(),
            vec![],
        );
        // 등록 — verify_token 인증 + handle_rpc lookup 가능.
        assert!(is_registered_token(&token));
        assert!(lookup(&token).is_some());
        drop(guard);
        // drop = 등록 해제.
        assert!(!is_registered_token(&token));
        assert!(lookup(&token).is_none());
    }

    #[test]
    fn core_sysmods_allowed_without_explicit_grant() {
        // notes/calendar 는 allowed_sysmods 에 없어도 허용 (핵심 사이드바).
        assert!(!is_sysmod_blocked_for_hub_with(&[], "notes"));
        assert!(!is_sysmod_blocked_for_hub_with(&[], "calendar"));
        // 외부 도구는 allowed 에 있어야만.
        assert!(is_sysmod_blocked_for_hub_with(&[], "telegram"));
        assert!(!is_sysmod_blocked_for_hub_with(&["telegram".to_string()], "telegram"));
    }

    // is_sysmod_blocked_for_hub 의 static 의존 없이 로직만 검증하는 헬퍼.
    fn is_sysmod_blocked_for_hub_with(allowed: &[String], name: &str) -> bool {
        !CORE_SYSMODS.contains(&name) && !allowed.iter().any(|s| s == name)
    }

    #[test]
    fn permits_tool_hub_policy_allow() {
        let allowed = vec!["law-search".to_string()];
        // 핵심 sysmod (allowed 없이도)
        assert!(permits_tool("sysmod_notes", &allowed));
        assert!(permits_tool("sysmod_calendar", &allowed));
        // per-hub 허용 sysmod (dash 모듈명)
        assert!(permits_tool("sysmod_law-search", &allowed));
        // MCP 도구명은 underscore (sysmod_law_search) — dash 모듈명(law-search)과 매칭돼야 함
        assert!(permits_tool("sysmod_law_search", &allowed));
        // read-only / 시각화 / 제안 / hub-scoped write
        assert!(permits_tool("search_library", &allowed));
        assert!(permits_tool("get_page", &allowed));
        assert!(permits_tool("list_pages", &allowed));
        assert!(permits_tool("cache_read", &allowed));
        assert!(permits_tool("render", &allowed));
        assert!(permits_tool("render_image", &allowed));
        assert!(permits_tool("suggest", &allowed));
        assert!(permits_tool("propose_plan", &allowed));
        assert!(permits_tool("save_page", &allowed));
        // ① 필수-on owner-scoped 쓰기 (owner 주입으로 visitor 간 격리 → 허용)
        assert!(permits_tool("save_entity", &allowed));
        assert!(permits_tool("save_fact", &allowed));
        assert!(permits_tool("delete_page", &allowed));
        assert!(permits_tool("write_file", &allowed));
        assert!(permits_tool("delete_file", &allowed));
        assert!(permits_tool("save_template", &allowed));
        assert!(permits_tool("regenerate_image", &allowed));
    }

    #[test]
    fn permits_tool_hub_policy_deny() {
        let allowed = vec!["law-search".to_string()];
        // 미허용 sysmod (allowed 에도 core 에도 없음)
        assert!(!permits_tool("sysmod_telegram", &allowed));
        assert!(!permits_tool("sysmod_kiwoom", &allowed));
        // ③deny: Vault/시크릿 / 임의 네트워크
        assert!(!permits_tool("request_secret", &allowed));
        assert!(!permits_tool("network_request", &allowed));
        // 임의 실행 / sysmod allow-list 우회
        assert!(!permits_tool("run_module", &allowed));
        assert!(!permits_tool("execute", &allowed));
        // 배경 실행 (남용 방지 — QueueManager 전까지 보류)
        assert!(!permits_tool("schedule_task", &allowed));
        assert!(!permits_tool("run_task", &allowed));
        assert!(!permits_tool("run_cron_job", &allowed));
        assert!(!permits_tool("cancel_cron_job", &allowed)); // writable·readonly 아님 → default-deny
        // admin/시스템/모듈 조회 — list_/get_ 접두어지만 우선 차단 (readonly 누수 차단)
        assert!(!permits_tool("list_system_modules", &allowed));
        assert!(!permits_tool("list_user_modules", &allowed));
        assert!(!permits_tool("get_module_config", &allowed));
        assert!(!permits_tool("get_memory_stats", &allowed));
        // mcp 관리 / 시크릿 변형
        assert!(!permits_tool("mcp_call", &allowed));
        assert!(!permits_tool("vault_get_secret", &allowed));
    }
}

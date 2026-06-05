//! Hub context 식별 — process-wide static + RAII Guard.
//!
//! 옛 cron_context.rs 와 같은 패턴 (commit 191b765). CLI 모델의 자체 MCP loop 안에서
//! sysmod_* 호출이 hub visitor 쪽 호출인지 admin 쪽 호출인지 식별.
//!
//! 용도:
//! - admin chat = HubContextGuard 미설정 = mcp handler 쪽 무제한 도구 허용
//! - hub visitor = HubContextGuard 설정 + allowed_sysmods 지정 = mcp handler 쪽에서 sysmod_* /
//!   destructive 도구 호출 시 allowed_sysmods 검사 + 미허용 시 reject
//!
//! ai.rs:669-694 쪽의 hub_context filter 는 `tools.is_empty()` 분기 (API 모델) 에만 적용
//! CLI 모델 (supports_mcp=true) 사용 시 = auto_tools 빈 배열 + CLI 자체 MCP loop 으로 Firebat
//! MCP server 호출. 이 경로에서 hub filter 를 적용하지 못해 hub visitor 가 admin 도구 (telegram /
//! kiwoom / 등) 사용 가능 = 보안 위반. HubContextGuard + MCP server handler wiring 으로 차단.
//!
//! 동시 hub 방문자 race 가능성 인정 = 단일 ActiveHubContext 사용 (옛 cron_context 와 동일 방식).
//! Hub 시스템 운영 초기에 visitor 동시 접속 1 명 이하 가정 — 향후 QueueManager 도입 시점
//! 별도 처리 (옛 트래커 #1 항목).

use std::sync::RwLock;

#[derive(Clone, Debug)]
pub struct ActiveHubContext {
    pub allowed_sysmods: Vec<String>,
    /// owner 주입용 — hosted/MCP 경로(CLI)는 ai.rs FC owner 주입을 우회하므로, MCP dispatch 가
    /// 이 값으로 owner/hubOwner/project 를 args 에 주입해야 hub 자료가 올바른 owner 로 저장된다.
    pub instance_id: String,
    pub session_id: String,
}

static ACTIVE_HUB_CONTEXT: RwLock<Option<ActiveHubContext>> = RwLock::new(None);

/// RAII guard — enter(...) 호출 시 active 설정, drop 시 unset.
pub struct HubContextGuard;

impl HubContextGuard {
    pub fn enter(allowed_sysmods: Vec<String>, instance_id: String, session_id: String) -> Self {
        if let Ok(mut guard) = ACTIVE_HUB_CONTEXT.write() {
            *guard = Some(ActiveHubContext {
                allowed_sysmods,
                instance_id,
                session_id,
            });
        }
        Self
    }
}

/// 현재 활성 hub context 의 (instance_id, session_id) — MCP 경로 owner 주입용. None = admin.
pub fn active_hub_owner() -> Option<(String, String)> {
    ACTIVE_HUB_CONTEXT
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|c| (c.instance_id.clone(), c.session_id.clone())))
}

impl Drop for HubContextGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = ACTIVE_HUB_CONTEXT.write() {
            *guard = None;
        }
    }
}

/// 현재 hub visitor 호출 중인지 — MCP handler 가 destructive / sysmod_* 도구 처리 시 분기.
pub fn is_hub_context_active() -> bool {
    ACTIVE_HUB_CONTEXT
        .read()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// 현재 활성 hub_context 의 allowed_sysmods 복제 반환. None = admin 영역 호출.
pub fn active_allowed_sysmods() -> Option<Vec<String>> {
    ACTIVE_HUB_CONTEXT
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|c| c.allowed_sysmods.clone()))
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
///       + render(_*) + suggest + propose_plan + save_page(hub-scoped write).
/// 거부(기본 deny): write_*/delete_*/schedule_task/run_task/run_module/mcp_*/request_secret/vault_* 등
///       destructive·admin 도구. 명시 허용에 없으면 전부 차단 = fail-safe.
pub fn permits_tool(name: &str, allowed_sysmods: &[String]) -> bool {
    if let Some(sysmod) = name.strip_prefix("sysmod_") {
        return CORE_SYSMODS.contains(&sysmod) || allowed_sysmods.iter().any(|s| s == sysmod);
    }
    is_hub_readonly_tool(name) || name.starts_with("render_") || name == "save_page"
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
    fn no_guard_means_admin_context() {
        assert!(!is_hub_context_active());
        assert!(active_allowed_sysmods().is_none());
        assert!(!is_sysmod_blocked_for_hub("telegram"));
    }

    #[test]
    fn guard_activates_and_filters_sysmods() {
        let _g = HubContextGuard::enter(
            vec!["notes".to_string(), "calendar".to_string()],
            "inst".to_string(),
            "sess".to_string(),
        );
        assert!(is_hub_context_active());
        assert!(!is_sysmod_blocked_for_hub("notes"));
        assert!(!is_sysmod_blocked_for_hub("calendar"));
        assert!(is_sysmod_blocked_for_hub("telegram"));
        assert!(is_sysmod_blocked_for_hub("kiwoom"));
    }

    #[test]
    fn guard_drop_clears_context() {
        {
            let _g = HubContextGuard::enter(vec!["notes".to_string()], "inst".to_string(), "sess".to_string());
            assert!(is_hub_context_active());
        }
        assert!(!is_hub_context_active());
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
        // per-hub 허용 sysmod
        assert!(permits_tool("sysmod_law-search", &allowed));
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
    }

    #[test]
    fn permits_tool_hub_policy_deny() {
        let allowed = vec!["law-search".to_string()];
        // 미허용 sysmod (allowed 에도 core 에도 없음)
        assert!(!permits_tool("sysmod_telegram", &allowed));
        assert!(!permits_tool("sysmod_kiwoom", &allowed));
        // destructive / admin / 시크릿 — 전부 차단 (fail-safe)
        assert!(!permits_tool("delete_page", &allowed));
        assert!(!permits_tool("delete_file", &allowed));
        assert!(!permits_tool("write_file", &allowed));
        assert!(!permits_tool("schedule_task", &allowed));
        assert!(!permits_tool("cancel_cron_job", &allowed));
        assert!(!permits_tool("run_task", &allowed));
        assert!(!permits_tool("run_module", &allowed));
        assert!(!permits_tool("request_secret", &allowed));
        assert!(!permits_tool("mcp_call", &allowed));
        assert!(!permits_tool("vault_get_secret", &allowed));
    }
}

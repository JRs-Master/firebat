//! Hub context 식별 — process-wide static + RAII Guard.
//!
//! 옛 cron_context.rs 와 같은 패턴 (commit 191b765). CLI 모델의 자체 MCP loop 안에서
//! sysmod_* 호출이 hub visitor 영역 박힌 호출인지 admin 영역 박힌 호출인지 식별.
//!
//! 용도:
//! - admin chat = HubContextGuard 박지 않음 = mcp handler 영역 무제한 도구 허용
//! - hub visitor = HubContextGuard 박음 + allowed_sysmods 박음 = mcp handler 영역에서 sysmod_* /
//!   destructive 도구 호출 시 allowed_sysmods 검사 + 미허용 영역 reject
//!
//! ai.rs:669-694 영역의 hub_context filter 는 `tools.is_empty()` 분기 (API 모델) 에만 적용
//! CLI 모델 (supports_mcp=true) 사용 시 = auto_tools 빈 배열 + CLI 자체 MCP loop 으로 Firebat
//! MCP server 호출. 본 영역에서 hub filter 박지 못해 hub visitor 가 admin 도구 (telegram /
//! kiwoom / 등) 사용 가능 = 보안 영역 위반. HubContextGuard + MCP server handler wiring 으로 차단.
//!
//! 동시 hub 방문자 race 영역 인정 = 단일 ActiveHubContext 박음 (옛 cron_context 와 동일 영역).
//! Hub 시스템 운영 초기 영역 visitor 동시 접속 1 명 이하 가정 — 향후 QueueManager 도입 시점
//! 별 영역 박힘 (옛 트래커 #1 영역).

use std::sync::RwLock;

#[derive(Clone, Debug)]
pub struct ActiveHubContext {
    pub allowed_sysmods: Vec<String>,
}

static ACTIVE_HUB_CONTEXT: RwLock<Option<ActiveHubContext>> = RwLock::new(None);

/// RAII guard — enter(allowed_sysmods) 호출 시 active 박힘, drop 시 unset.
pub struct HubContextGuard;

impl HubContextGuard {
    pub fn enter(allowed_sysmods: Vec<String>) -> Self {
        if let Ok(mut guard) = ACTIVE_HUB_CONTEXT.write() {
            *guard = Some(ActiveHubContext { allowed_sysmods });
        }
        Self
    }
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

/// MCP server 의 sysmod handler 영역에서 호출 — hub 영역 박혀있고 sysmod 가 미허용이면 true.
/// admin 영역 (Guard 박지 않음) = false (정공 허용).
pub fn is_sysmod_blocked_for_hub(sysmod_name: &str) -> bool {
    match active_allowed_sysmods() {
        None => false,
        Some(allowed) => !allowed.iter().any(|s| s == sysmod_name),
    }
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
        let _g = HubContextGuard::enter(vec!["notes".to_string(), "calendar".to_string()]);
        assert!(is_hub_context_active());
        assert!(!is_sysmod_blocked_for_hub("notes"));
        assert!(!is_sysmod_blocked_for_hub("calendar"));
        assert!(is_sysmod_blocked_for_hub("telegram"));
        assert!(is_sysmod_blocked_for_hub("kiwoom"));
    }

    #[test]
    fn guard_drop_clears_context() {
        {
            let _g = HubContextGuard::enter(vec!["notes".to_string()]);
            assert!(is_hub_context_active());
        }
        assert!(!is_hub_context_active());
    }
}

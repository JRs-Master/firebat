//! ToolRouter — AI Assistant 도구 선별 + 피드백 학습 루프.
//!
//! 옛 TS `core/managers/ai/tool-router.ts` (181 LOC) backbone 박음.
//!
//! 책임:
//!   1. `select_tools` — 사용자 발화에 맞는 도구 좁히기 (Gemini API 만 적용. needs_previous_context
//!      판정은 모든 모델 공통).
//!   2. AI Assistant ON/OFF 라우팅 분기 (Vault `system:ai-router:enabled` 토글).
//!   3. 피드백 학습 — 직전 라우팅이 negative/positive 면 cache 점수 갱신 (LLM router 박힌 후).
//!   4. turn 종료 시 성공 기록 (`record_turn_success`).
//!
//! Phase B-18 backbone — IToolRouterPort + ToolSearchIndex 박힌 후 LLM router 활성.
//! 현재는:
//!   - `is_enabled()` Vault 토글 검사 (옛 TS 1:1)
//!   - `select_tools` 의 fallback path — 모든 도구 그대로 반환 + needs_previous_context=None
//!   - 90초 session 캐시 struct + `record_turn_success` skeleton
//!
//! LLM router 활성 시 (별도 batch):
//!   - `IToolRouterPort` Rust port 추가
//!   - `route_tools` 메서드 (LLM 으로 도구 좁힘)
//!   - `record_success` / `record_failure` (cacheId 갱신)

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::ports::{IVaultPort, ToolDefinition};

/// 90초 — 이 안에서만 직전 라우팅 피드백 참조.
const FEEDBACK_WINDOW_SECS: u64 = 90;

const VK_AI_ROUTER_ENABLED: &str = "system:ai-router:enabled";
const VK_AI_ROUTER_MODEL: &str = "system:ai-router:model";

/// `select_tools` 결과 — 좁힌 도구 + needs_previous_context 판정.
#[derive(Debug, Clone)]
pub struct ToolRouteResult {
    pub tools: Vec<ToolDefinition>,
    /// `Some(true)` — 라우터가 "현재 query 가 이전 턴 참조 필요" 판정 → AiManager 가 자동 history 주입.
    /// `None` — 라우터 비활성 (default fallback) 또는 모호.
    pub needs_previous_context: Option<bool>,
}

/// 직전 라우팅 — 90초 TTL. AI Assistant ON 시 LLM router 의 피드백 컨텍스트로 사용.
#[derive(Debug, Clone)]
#[allow(dead_code)] // Phase B-18 LLM router 박힌 후 활성
struct LastRouting {
    pub query: String,
    pub tool_names: Vec<String>,
    pub cache_id: i64,
    pub recorded_at: Instant,
}

/// 현재 turn 의 cacheId — `record_turn_success` 시점에 success/failure 갱신.
#[derive(Debug, Default, Clone)]
#[allow(dead_code)] // Phase B-18 LLM router 박힌 후 활성
struct CacheIds {
    tools: Option<i64>,
    components: Vec<i64>,
}

pub struct ToolRouter {
    vault: Arc<dyn IVaultPort>,
    /// 대화별 직전 라우팅 (90초 TTL).
    session_last_routing: Mutex<HashMap<String, LastRouting>>,
    /// 현재 turn 의 cacheIds — turn 끝나면 reset.
    last_route_cache_ids: Mutex<CacheIds>,
}

impl ToolRouter {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            vault,
            session_last_routing: Mutex::new(HashMap::new()),
            last_route_cache_ids: Mutex::new(CacheIds::default()),
        }
    }

    /// AI Assistant ON/OFF — Vault `system:ai-router:enabled` 토글.
    /// 옛 TS `isEnabled()` 1:1 — `'true'` 또는 `'1'` 만 ON.
    pub fn is_enabled(&self) -> bool {
        match self.vault.get_secret(VK_AI_ROUTER_ENABLED) {
            Some(v) => v == "true" || v == "1",
            None => false,
        }
    }

    /// AI Assistant 모델 ID — Vault `system:ai-router:model` 또는 default `gpt-5-nano`.
    /// 메인 채팅 모델과 분리 — 빠르고 싼 모델로 router 호출.
    pub fn get_assistant_model(&self) -> String {
        self.vault
            .get_secret(VK_AI_ROUTER_MODEL)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gpt-5-nano".to_string())
    }

    /// 현재 model 이 Gemini API 인지 — 도구 필터링 적용 여부.
    /// 옛 TS `modelId.startsWith('gemini-')` 1:1 — Gemini API 만 도구 좁힘 (CLI 자체 처리).
    fn is_gemini_api(model_id: &str) -> bool {
        model_id.starts_with("gemini-")
    }

    /// turn 시작 시 호출 — 도구 선별 + needs_previous_context 판정.
    ///
    /// **현재 backbone 상태**:
    /// - LLM router (IToolRouterPort) 미박음 → fallback path
    /// - 모든 도구 그대로 반환 + needs_previous_context=None
    ///
    /// **LLM router 박힌 후 (별도 batch)**:
    /// - Vault toggle ON → router.route_tools 호출 → Gemini API 만 도구 좁힘
    /// - 직전 라우팅 90초 TTL 피드백 → recordSuccess / recordFailure
    /// - GPT/Claude/CLI: 도구 그대로 + needs_previous_context 만 활용
    pub async fn select_tools(
        &self,
        all_tools: Vec<ToolDefinition>,
        user_query: &str,
        model_id: &str,
        _session_used_tool_names: &HashSet<String>,
        _conversation_id: Option<&str>,
    ) -> ToolRouteResult {
        let _ = model_id; // LLM router 박힌 후 분기에 사용
        let _ = Self::is_gemini_api;
        let _ = self.get_assistant_model();
        if user_query.trim().is_empty() {
            return ToolRouteResult {
                tools: all_tools,
                needs_previous_context: None,
            };
        }

        // Phase B-18 backbone — 모든 도구 그대로. AI Assistant 토글 ON 이어도 LLM router 미박음 시 동일.
        // 별도 batch 에서 IToolRouterPort + ToolSearchIndex 박힌 후 활성.
        ToolRouteResult {
            tools: all_tools,
            needs_previous_context: None,
        }
    }

    /// search_components handler 가 호출 — 컴포넌트 라우팅 결과 cacheId 누적.
    /// turn 끝나면 `record_turn_success` 가 reset.
    pub fn record_components_cache_id(&self, cache_id: i64) {
        if cache_id < 0 {
            return;
        }
        if let Ok(mut state) = self.last_route_cache_ids.lock() {
            state.components.push(cache_id);
        }
    }

    /// turn 종료 시 호출 — 보수적 감점 정책 (AI 가 실제 사용한 카테고리만 success).
    /// 옛 TS `recordTurnSuccess` 1:1.
    ///
    /// - `tools_used`: AI 가 라우팅된 도구 중 1개라도 호출했으면 true → tools cache success.
    /// - `render_used`: AI 가 render / render_* 1개라도 호출했으면 true → components cache success.
    ///
    /// **현재 backbone**: cache_ids reset 만. LLM router 박힌 후 recordSuccess 호출 활성.
    pub async fn record_turn_success(&self, _tools_used: bool, _render_used: bool) {
        // LLM router 박힌 후 활성 — 현재는 cache_ids reset 만
        if let Ok(mut state) = self.last_route_cache_ids.lock() {
            *state = CacheIds::default();
        }
    }

    /// 90초 TTL session 마지막 라우팅 garbage collect — 새 라우팅 박을 때 호출.
    /// 옛 TS 동등 (90초 지난 항목 자동 무효화).
    pub fn cleanup_stale_routings(&self) {
        let now = Instant::now();
        if let Ok(mut state) = self.session_last_routing.lock() {
            state.retain(|_, r| now.duration_since(r.recorded_at).as_secs() < FEEDBACK_WINDOW_SECS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    fn make_router() -> (ToolRouter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        (ToolRouter::new(vault), dir)
    }

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            input_schema: None,
        }
    }

    #[test]
    fn is_enabled_default_false() {
        let (r, _dir) = make_router();
        assert!(!r.is_enabled());
    }

    #[test]
    fn is_enabled_true_when_vault_set() {
        let (r, _dir) = make_router();
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "true");
        assert!(r.is_enabled());
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "1");
        assert!(r.is_enabled());
    }

    #[test]
    fn is_enabled_false_for_other_values() {
        let (r, _dir) = make_router();
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "false");
        assert!(!r.is_enabled());
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "0");
        assert!(!r.is_enabled());
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "yes"); // 옛 TS 와 같이 true/1 만 ON
        assert!(!r.is_enabled());
    }

    #[test]
    fn assistant_model_default_gpt_nano() {
        let (r, _dir) = make_router();
        assert_eq!(r.get_assistant_model(), "gpt-5-nano");
    }

    #[test]
    fn assistant_model_override_via_vault() {
        let (r, _dir) = make_router();
        r.vault.set_secret(VK_AI_ROUTER_MODEL, "gemini-3-flash-preview");
        assert_eq!(r.get_assistant_model(), "gemini-3-flash-preview");
    }

    #[test]
    fn is_gemini_api_recognizes_prefix() {
        assert!(ToolRouter::is_gemini_api("gemini-3-pro"));
        assert!(ToolRouter::is_gemini_api("gemini-3.1-flash-preview"));
        assert!(!ToolRouter::is_gemini_api("gpt-5"));
        assert!(!ToolRouter::is_gemini_api("claude-4-sonnet"));
        assert!(!ToolRouter::is_gemini_api("cli-codex"));
    }

    #[tokio::test]
    async fn select_tools_returns_all_in_backbone_mode() {
        let (r, _dir) = make_router();
        let tools = vec![tool("save_page"), tool("image_gen"), tool("render_table")];
        let result = r
            .select_tools(
                tools.clone(),
                "삼성전자 시세 알려줘",
                "gemini-3-pro",
                &HashSet::new(),
                None,
            )
            .await;
        // backbone — 모든 도구 그대로
        assert_eq!(result.tools.len(), 3);
        assert!(result.needs_previous_context.is_none());
    }

    #[tokio::test]
    async fn select_tools_empty_query_returns_all() {
        let (r, _dir) = make_router();
        let tools = vec![tool("save_page")];
        let result = r
            .select_tools(tools, "", "gpt-5", &HashSet::new(), None)
            .await;
        assert_eq!(result.tools.len(), 1);
    }

    #[tokio::test]
    async fn record_turn_success_resets_cache_ids() {
        let (r, _dir) = make_router();
        r.record_components_cache_id(42);
        r.record_components_cache_id(43);
        // backbone — record_turn_success 가 reset (LLM router 박힌 후 success 호출 활성)
        r.record_turn_success(true, true).await;
        let state = r.last_route_cache_ids.lock().unwrap();
        assert!(state.components.is_empty());
        assert!(state.tools.is_none());
    }

    #[test]
    fn record_components_cache_id_ignores_negative() {
        let (r, _dir) = make_router();
        r.record_components_cache_id(-1);
        let state = r.last_route_cache_ids.lock().unwrap();
        assert!(state.components.is_empty());
    }

    #[test]
    fn cleanup_stale_routings_works() {
        let (r, _dir) = make_router();
        // 직전 라우팅 박음 (직접 — 일반 호출 경로는 LLM router 박힌 후)
        if let Ok(mut state) = r.session_last_routing.lock() {
            state.insert(
                "c1".to_string(),
                LastRouting {
                    query: "test".to_string(),
                    tool_names: vec![],
                    cache_id: 1,
                    recorded_at: Instant::now(),
                },
            );
        }
        // cleanup — 90초 안이라 그대로
        r.cleanup_stale_routings();
        assert!(r.session_last_routing.lock().unwrap().contains_key("c1"));
        // (90초 지난 검증은 unit test 한도 — 실 시간 의존이라 skip. 실 운영에선 자연 expire.)
    }
}

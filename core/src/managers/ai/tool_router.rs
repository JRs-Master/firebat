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

use crate::managers::ai::tool_search_index::{ToolSearchIndex, ToolSearchOpts, ALWAYS_INCLUDE};
use crate::ports::{IEmbedderPort, IVaultPort, ToolDefinition};

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
    /// ToolSearchIndex (옵션) — 박혀있으면 Gemini API 도구 선별 활성. 미박힘 시 fallback (모든 도구).
    /// AI Assistant 토글 ON 이어도 search_index 미박음 → backbone fallback 동일.
    search_index: Option<Arc<ToolSearchIndex>>,
}

impl ToolRouter {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            vault,
            session_last_routing: Mutex::new(HashMap::new()),
            last_route_cache_ids: Mutex::new(CacheIds::default()),
            search_index: None,
        }
    }

    /// ToolSearchIndex 박은 채로 부팅 — Gemini API 도구 선별 (2-stage 벡터 검색) 활성.
    /// IEmbedderPort 직접 받아 내부 ToolSearchIndex 빌드.
    pub fn with_embedder(mut self, embedder: Arc<dyn IEmbedderPort>) -> Self {
        self.search_index = Some(Arc::new(ToolSearchIndex::new(embedder)));
        self
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
    /// **활성 조건** (셋 다 true 일 때만 도구 좁힘):
    /// 1. AI Assistant 토글 ON (Vault `system:ai-router:enabled`)
    /// 2. 현재 모델이 Gemini API (hosted MCP 없는 프로바이더 — GPT/Claude 는 hosted MCP 있어 노이즈 적음)
    /// 3. ToolSearchIndex 박혀있음 (`with_embedder` 호출 후)
    ///
    /// **활성 시 흐름** (옛 TS 1:1):
    /// 1. ToolSearchIndex.query → Stage 1+2 카테고리·도구 cosine 검색
    /// 2. selected_tool_names (stage 2 통과) ∪ ALWAYS_INCLUDE ∪ session_used (이전 호출 도구)
    /// 3. all_tools 에서 선별된 이름만 필터 → 좁혀진 도구 반환
    ///
    /// **비활성 시 fallback**: 모든 도구 그대로 (옛 TS 와 동일).
    pub async fn select_tools(
        &self,
        all_tools: Vec<ToolDefinition>,
        user_query: &str,
        model_id: &str,
        session_used_tool_names: &HashSet<String>,
        _conversation_id: Option<&str>,
    ) -> ToolRouteResult {
        if user_query.trim().is_empty() {
            return ToolRouteResult {
                tools: all_tools,
                needs_previous_context: None,
            };
        }

        // 활성 조건 검사 — 셋 중 하나라도 false 면 fallback
        let enabled = self.is_enabled();
        let is_gemini = Self::is_gemini_api(model_id);
        let Some(search_index) = self.search_index.as_ref() else {
            // ToolSearchIndex 미박음 → fallback (옛 TS 의 backbone 동일)
            return ToolRouteResult {
                tools: all_tools,
                needs_previous_context: None,
            };
        };
        if !enabled || !is_gemini {
            // GPT/Claude/CLI 또는 토글 OFF → fallback (모든 도구 그대로)
            return ToolRouteResult {
                tools: all_tools,
                needs_previous_context: None,
            };
        }

        // ToolSearchIndex 호출 — 카테고리·도구 cosine 검색 (옛 TS 1:1)
        let no_capability = |_: &str| -> Option<String> { None };
        let search_result = match search_index
            .query(user_query, &all_tools, ToolSearchOpts::default(), &no_capability)
            .await
        {
            Ok(r) => r,
            Err(_) => {
                // 임베딩 실패 → fallback (옛 TS 와 동일 — 안전한 쪽)
                return ToolRouteResult {
                    tools: all_tools,
                    needs_previous_context: None,
                };
            }
        };

        // 선별된 도구 이름 = stage 2 통과 ∪ ALWAYS_INCLUDE ∪ session_used
        let mut allowed: HashSet<String> = search_result.selected_tool_names.clone();
        for n in ALWAYS_INCLUDE {
            allowed.insert(n.to_string());
        }
        for n in session_used_tool_names {
            allowed.insert(n.clone());
        }

        // all_tools 에서 선별된 이름만 필터
        let filtered: Vec<ToolDefinition> = all_tools
            .into_iter()
            .filter(|t| allowed.contains(&t.name))
            .collect();

        ToolRouteResult {
            tools: filtered,
            needs_previous_context: None, // LLM router 박힌 후 활성
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

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::vault::SqliteVaultAdapter;
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

    #[tokio::test]
    async fn select_tools_falls_back_when_search_index_missing() {
        // ToolSearchIndex 미박음 + 토글 ON + Gemini → fallback (모든 도구 그대로)
        let (r, _dir) = make_router();
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "true");
        let tools = vec![tool("save_page"), tool("image_gen")];
        let result = r
            .select_tools(
                tools.clone(),
                "주식 차트 그려줘",
                "gemini-3-pro",
                &HashSet::new(),
                None,
            )
            .await;
        assert_eq!(result.tools.len(), 2);
    }

    #[tokio::test]
    async fn select_tools_falls_back_when_toggle_off() {
        // search_index 박혀있어도 토글 OFF → fallback
        use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", dir.path());
        }
        let (r, _vault_dir) = make_router();
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let r = r.with_embedder(embedder);
        // 토글 미설정 → fallback (모든 도구)
        let tools = vec![tool("sysmod_kiwoom"), tool("save_page"), tool("image_gen")];
        let result = r
            .select_tools(
                tools.clone(),
                "주식 차트",
                "gemini-3-pro",
                &HashSet::new(),
                None,
            )
            .await;
        assert_eq!(result.tools.len(), 3);
    }

    #[tokio::test]
    async fn select_tools_falls_back_for_non_gemini() {
        // 토글 ON + search_index 박힘 + GPT 모델 → fallback (Gemini API 만 활성)
        use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", dir.path());
        }
        let (r, _vault_dir) = make_router();
        r.vault.set_secret(VK_AI_ROUTER_ENABLED, "true");
        let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
        let r = r.with_embedder(embedder);
        let tools = vec![tool("save_page"), tool("image_gen")];
        let result = r
            .select_tools(
                tools.clone(),
                "이미지 만들어줘",
                "gpt-5",
                &HashSet::new(),
                None,
            )
            .await;
        // GPT — fallback (옛 TS hosted MCP 만 도구 좁히지 않음)
        assert_eq!(result.tools.len(), 2);
    }
}

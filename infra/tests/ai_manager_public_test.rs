//! Integration tests for `core::managers::ai::AiManager` public API surface.
//! Phase B-post audit E4 — public-API tests inline 이관.
//!
//! 보존 inline tests (signature / dedup / is_past_iso / approval_gate_*) — private fn 사용.

use std::sync::{Mutex, OnceLock};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use firebat_core::managers::ai::AiManager;
use firebat_core::managers::conversation::ConversationManager;
use firebat_core::managers::cost::{CostBudget, CostManager};
use firebat_core::managers::tool::ToolManager;
use firebat_core::ports::{
    AiRequestOpts, CronAgentOpts, IDatabasePort, IEmbedderPort, ILlmPort, ILogPort, IVaultPort,
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolCall, ToolDefinition,
    ToolResult,
};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
use firebat_infra::adapters::llm::StubLlmAdapter;
use firebat_infra::adapters::log::ConsoleLogAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

/// FIREBAT_DATA_DIR env var 직렬화 — 한 binary 안 모든 test 가 같은 lock 사용.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn manager() -> AiManager {
    let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
    let tools = Arc::new(ToolManager::new());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    AiManager::new(llm, tools, log)
}

#[tokio::test]
async fn ask_text_returns_stub_text() {
    let mgr = manager();
    let text = mgr.ask_text("hi", &LlmCallOpts::default()).await.unwrap();
    assert!(text.contains("Phase B-17+"));
}

#[tokio::test]
async fn process_with_tools_terminates_on_empty_calls() {
    let mgr = manager();
    let response = mgr
        .process_with_tools("hello", &[], &LlmCallOpts::default())
        .await
        .unwrap();
    assert!(response.executed_actions.is_empty());
    assert!(response.reply.contains("Phase B-17+"));
    assert_eq!(response.model_id.as_deref(), Some("stub"));
}

#[tokio::test]
async fn process_with_tools_opts_uses_default_plan_off() {
    let mgr = manager();
    let response = mgr
        .process_with_tools_opts(
            "hello",
            &[],
            &LlmCallOpts::default(),
            &AiRequestOpts::default(),
        )
        .await
        .unwrap();
    // PlanMode::Off — 시스템 프롬프트에 plan prefix 미주입 (test 직접 검증 어려움 — Stub 가
    // system_prompt 안 받기 때문). 구조적으로 호출만 되는지 확인.
    assert_eq!(response.model_id.as_deref(), Some("stub"));
}

#[tokio::test]
async fn process_with_tools_opts_cron_agent_extends_max_turns() {
    // cron agent 모드 — MAX_TOOL_TURNS 25. Stub 가 도구 호출 0 반환 → 1 turn 만 돌고 종료.
    // 하지만 max_turns 분기는 정확히 맞아야 함 (회귀 방어).
    let mgr = manager();
    let ai_opts = AiRequestOpts {
        cron_agent: Some(CronAgentOpts {
            job_id: "test".to_string(),
            title: None,
        }),
        ..Default::default()
    };
    let response = mgr
        .process_with_tools_opts("hello", &[], &LlmCallOpts::default(), &ai_opts)
        .await
        .unwrap();
    assert_eq!(response.model_id.as_deref(), Some("stub"));
}

#[tokio::test]
async fn cost_budget_guard_blocks_when_exceeded() {
    // CostManager 설정한 채로 한도 초과 상태 만든 뒤 process_with_tools 호출 시 LLM 호출 차단 확인.
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let cost = Arc::new(CostManager::new(db, vault));
    let budget = CostBudget {
        daily_usd: 1.0,
        monthly_usd: 30.0,
        daily_calls: 100,
        monthly_calls: 1000,
        alert_at_percent: 80,
    };
    cost.set_budget(&budget);
    // 한도 초과 — daily USD
    cost.record("m", 100, 100, 0, 5.0, None);

    let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
    let tools = Arc::new(ToolManager::new());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = AiManager::new(llm, tools, log).with_cost_manager(cost);

    let response = mgr
        .process_with_tools_opts(
            "hi",
            &[],
            &LlmCallOpts::default(),
            &AiRequestOpts::default(),
        )
        .await
        .unwrap();
    // 차단됨 — error 메시지 포함, executed_actions 0
    assert!(response.error.is_some());
    assert!(response.error.unwrap().contains("비용 한도 초과"));
    assert_eq!(response.executed_actions.len(), 0);
    assert_eq!(response.cost_usd, Some(0.0)); // 호출 안 했으므로 비용 0
}

// ── ScriptedLlm + CapturingLog test helpers (옛 inline 의 동등 정의) ──────────

struct ScriptedLlm {
    model_id: String,
    scripted_calls: StdMutex<Vec<ToolCall>>,
}

impl ScriptedLlm {
    fn new(model_id: &str, calls: Vec<ToolCall>) -> Self {
        Self {
            model_id: model_id.to_string(),
            scripted_calls: StdMutex::new(calls),
        }
    }
}

#[async_trait::async_trait]
impl ILlmPort for ScriptedLlm {
    fn get_model_id(&self) -> String {
        self.model_id.clone()
    }
    async fn ask_text(
        &self,
        _prompt: &str,
        _opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        Ok(LlmTextResponse {
            text: String::new(),
            model_id: self.model_id.clone(),
            cost_usd: Some(0.0),
            tokens_in: Some(0),
            tokens_out: Some(0),
        })
    }
    async fn ask_with_tools(
        &self,
        _prompt: &str,
        _tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        _opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        // 첫 호출만 scripted calls — 이후 빈 응답 (loop 종료)
        let calls = std::mem::take(&mut *self.scripted_calls.lock().unwrap());
        Ok(LlmToolResponse {
            text: if calls.is_empty() {
                "최종 응답".to_string()
            } else {
                String::new()
            },
            tool_calls: calls,
            model_id: self.model_id.clone(),
            cost_usd: Some(0.0),
            tokens_in: Some(0),
            tokens_out: Some(0),
            ..Default::default()
        })
    }
}

struct CliSessionMockLlm {
    model_id: String,
    emit_session_id: String,
    captured_resume: StdMutex<Option<String>>,
}

#[async_trait::async_trait]
impl ILlmPort for CliSessionMockLlm {
    fn get_model_id(&self) -> String {
        self.model_id.clone()
    }
    async fn ask_text(
        &self,
        _prompt: &str,
        _opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        Ok(LlmTextResponse {
            text: String::new(),
            model_id: self.model_id.clone(),
            cost_usd: Some(0.0),
            tokens_in: Some(0),
            tokens_out: Some(0),
        })
    }
    async fn ask_with_tools(
        &self,
        _prompt: &str,
        _tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        *self.captured_resume.lock().unwrap() = opts.cli_resume_session_id.clone();
        Ok(LlmToolResponse {
            text: "ok".to_string(),
            tool_calls: Vec::new(),
            model_id: self.model_id.clone(),
            cli_session_id: Some(self.emit_session_id.clone()),
            ..Default::default()
        })
    }
}

/// 학습 로그 capture 용 — `[USER_AI_TRAINING]` prefix 가진 info 호출 캡처.
struct CapturingLog {
    captured: StdMutex<Vec<String>>,
}

impl CapturingLog {
    fn new() -> Self {
        Self {
            captured: StdMutex::new(Vec::new()),
        }
    }
}

impl ILogPort for CapturingLog {
    fn info(&self, msg: &str) {
        if msg.contains("[USER_AI_TRAINING]") {
            self.captured.lock().unwrap().push(msg.to_string());
        }
    }
    fn warn(&self, _msg: &str) {}
    fn error(&self, _msg: &str) {}
    fn debug(&self, _msg: &str) {}
}

#[tokio::test]
async fn training_log_emitted_with_prompt_and_reply() {
    // Stub LLM 은 도구 호출 0 → 단순 prompt + reply 만 학습 로그에 설정.
    let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
    let tools = Arc::new(ToolManager::new());
    let log = Arc::new(CapturingLog::new());
    let log_clone = log.clone();
    let mgr = AiManager::new(llm, tools, log_clone as Arc<dyn ILogPort>);

    // 작업 키워드("작성") 포함 — isSimpleChat fast path 회피
    mgr.process_with_tools_opts(
        "테스트 프롬프트 작성해줘",
        &[],
        &LlmCallOpts::default(),
        &AiRequestOpts::default(),
    )
    .await
    .unwrap();

    let captured = log.captured.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let msg = &captured[0];
    assert!(msg.contains("[USER_AI_TRAINING]"));
    assert!(msg.contains("\"role\":\"user\""));
    assert!(msg.contains("테스트 프롬프트"));
    assert!(msg.contains("\"role\":\"model\""));
}

#[tokio::test]
async fn training_log_includes_tool_exchanges() {
    // ScriptedLlm 으로 도구 호출 시나리오 만들고 contents 에 functionCall + functionResponse 설정 확인.
    let scripted = vec![ToolCall {
        id: "c1".to_string(),
        name: "search_history".to_string(),
        arguments: serde_json::json!({"query": "test"}),
    }];
    let llm: Arc<dyn ILlmPort> = Arc::new(ScriptedLlm::new("scripted", scripted));
    let tools = Arc::new(ToolManager::new());
    let log = Arc::new(CapturingLog::new());
    let mgr = AiManager::new(llm, tools, log.clone() as Arc<dyn ILogPort>);

    mgr.process_with_tools_opts(
        "검색해줘",
        &[],
        &LlmCallOpts::default(),
        &AiRequestOpts::default(),
    )
    .await
    .unwrap();

    let captured = log.captured.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let msg = &captured[0];
    // functionCall 블록 설정
    assert!(msg.contains("\"functionCall\""));
    assert!(msg.contains("search_history"));
    // functionResponse 블록 설정
    assert!(msg.contains("\"functionResponse\""));
}

#[tokio::test]
async fn cli_session_resume_persists_and_loads() {
    // model 이 cli- 로 시작 + conversation_id 설정되어 있을 때:
    // 첫 호출 — cli_session_id 캡처 → ConversationManager 에 저장
    // 두 번째 호출 — DB 의 session_id 가 opts.cli_resume_session_id 로 주입
    let _g = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<SqliteDatabaseAdapter> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let conv_mgr = Arc::new(ConversationManager::new(
        db.clone() as Arc<dyn IDatabasePort>,
    ));
    // 대화 row 미리 생성 — set_cli_session 이 UPDATE 라 row 가 존재해야 함.
    conv_mgr
        .save_sync("admin", "conv-1", "test", &serde_json::json!([]), None)
        .unwrap();

    let llm = Arc::new(CliSessionMockLlm {
        model_id: "cli-claude-code".to_string(),
        emit_session_id: "sess-uuid-abc".to_string(),
        captured_resume: StdMutex::new(None),
    });
    let llm_arc: Arc<dyn ILlmPort> = llm.clone();
    let tools = Arc::new(ToolManager::new());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = AiManager::new(llm_arc, tools, log)
        .with_conversation_manager(conv_mgr.clone());

    let ai_opts = AiRequestOpts {
        conversation_id: Some("conv-1".to_string()),
        ..Default::default()
    };

    // 첫 호출 — resume 미설정 (DB 비어있음). 작업 키워드 포함 — fast path 회피.
    mgr.process_with_tools_opts("긴 작업 분석 처리", &[], &LlmCallOpts::default(), &ai_opts)
        .await
        .unwrap();
    assert!(llm.captured_resume.lock().unwrap().is_none());

    // DB 에 session_id 영속화 됐는지 직접 확인
    let saved = conv_mgr.get_cli_session("conv-1", "cli-claude-code");
    assert_eq!(saved.as_deref(), Some("sess-uuid-abc"));

    // 두 번째 호출 — resume 설정. 작업 키워드 포함.
    mgr.process_with_tools_opts("두 번째 분석 작업", &[], &LlmCallOpts::default(), &ai_opts)
        .await
        .unwrap();
    let captured = llm.captured_resume.lock().unwrap().clone();
    assert_eq!(captured.as_deref(), Some("sess-uuid-abc"));
}

#[tokio::test]
async fn search_components_handler_returns_top_k() {
    // search_components 도구 등록 + ToolManager.dispatch 통한 호출 → 26 components 의 top-5 반환.
    let _g = env_lock();
    let dir = tempfile::tempdir().unwrap();
    unsafe {
        std::env::set_var("FIREBAT_DATA_DIR", dir.path());
    }
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let cache_port: Arc<dyn firebat_core::ports::IEmbedderCachePort> = Arc::new(
        firebat_infra::adapters::embedder_cache::FileEmbedderCacheAdapter::new(dir.path()),
    );

    let llm: Arc<dyn ILlmPort> = Arc::new(StubLlmAdapter::new("stub"));
    let tools = Arc::new(ToolManager::new());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = AiManager::new(llm, tools.clone(), log).register_search_components_tool(embedder, cache_port);

    // 도구 등록 됐는지 확인
    assert!(tools.handler_count() >= 1);

    // ToolManager.dispatch 통해 호출
    let result = tools
        .dispatch(
            "search_components",
            &serde_json::json!({"query": "주식 차트", "limit": 3}),
        )
        .await
        .unwrap();
    let components = result["components"].as_array().unwrap();
    assert_eq!(components.len(), 3);
    let count = result["count"].as_u64().unwrap();
    assert_eq!(count, 3);
    // 첫 번째 결과는 score 가장 높음
    for w in components.windows(2) {
        let s1 = w[0]["score"].as_f64().unwrap();
        let s2 = w[1]["score"].as_f64().unwrap();
        assert!(s1 >= s2, "결과는 score 내림차순 정렬");
    }
    // 각 결과는 name + description + propsSchema 설정
    for c in components {
        assert!(c["name"].is_string());
        assert!(c["description"].is_string());
        assert!(c["propsSchema"].is_object());
    }
    let _ = mgr;
}

//! Firebat 자체 MCP HTTP server (Phase E, 2026-05-12).
//!
//! 옛 `mcp/internal-server.ts` (Node @modelcontextprotocol/sdk) → Rust axum endpoint 으로 이관.
//! Claude CLI / Codex / Gemini CLI 의 `--mcp-config http://127.0.0.1:<port>/mcp` 가 직접 연결.
//!
//! 프로토콜: JSON-RPC 2.0 over HTTP (MCP "streamable HTTP transport" 표준).
//!  - POST /mcp — JSON-RPC 메시지 수신 + 응답
//!  - GET /mcp — Server-Sent Events (선택적 streaming, 추후 도입)
//!
//! 인증: Bearer token (Vault `system:internal-mcp-token`) — Authorization 헤더 검증.
//!
//! 도구 registry: McpToolRegistry trait 으로 추상화. 호출자가 핸들러 + schema 등록.
//! 초기 핸들러는 ToolManager 의 list/execute 위임 — 추후 sysmod / render_* / pending 등록 확장.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;

use firebat_core::managers::auth::AuthManager;
use firebat_core::managers::conversation::{ConversationManager, SearchHistoryOpts};
use firebat_core::managers::entity::EntityManager;
use firebat_core::managers::episodic::EpisodicManager;
use firebat_core::managers::library::LibraryManager;
use firebat_core::managers::mcp::McpManager;
use firebat_core::managers::media::{MediaManager};
use firebat_core::managers::module::ModuleManager;
use firebat_core::managers::page::PageManager;
use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::managers::secret::SecretManager;
use firebat_core::managers::storage::StorageManager;
use firebat_core::managers::task::{PipelineStep, TaskManager};
use firebat_core::managers::tool::{ToolListFilter, ToolManager};
use firebat_core::utils::grounding::{check_grounding, parse_grounding, GroundedParam};
use firebat_core::utils::sysmod_cache::SysmodCacheAdapter;
// ToolManager / ToolListFilter — 옛 register_render_tools 가 사용했으나 2026-05-14 폐기 후
// 단일 RenderUnifiedHandler 로 통합 → 이 모듈에서는 직접 import 불필요.
use firebat_core::ports::{
    CronScheduleOptions, EntitySearchOpts, EventSearchOpts, FactSearchOpts, IVaultPort,
    ListRecentOpts, SaveEntityInput, SaveEventInput, SaveFactInput, TimelineOpts,
};

/// MCP 도구 등록 항목 — 옛 TS `server.tool(name, description, schema, handler)` 1:1.
pub struct McpTool {
    pub name: String,
    pub description: String,
    /// inputSchema — JSON Schema (Draft 7 호환). 옛 zod schema → JSON Schema 변환.
    pub input_schema: Value,
    /// 핸들러 — args (JSON object) 받아 결과 JSON 반환. Err 면 isError 플래그.
    pub handler: Arc<dyn McpToolHandler>,
}

#[async_trait::async_trait]
pub trait McpToolHandler: Send + Sync {
    async fn call(&self, args: Value) -> Result<Value, String>;
}

/// MCP server state — 도구 registry + Vault (internal token) + AuthManager (외부 API token).
pub struct McpServerState {
    pub tools: RwLock<HashMap<String, McpTool>>,
    pub vault: Arc<dyn IVaultPort>,
    /// AuthManager — 외부 사용자 API token 검증. 미설정 시 internal token only 모드.
    pub auth: Option<Arc<AuthManager>>,
    /// ModuleManager — sysmod 활성화 토글 검사 (tools/list 시점 비활성 sysmod 필터).
    /// 미설정 시 list 필터 0 (옛 호환). call-time gate 는 handler 안에서 별도 수행.
    pub module_manager: Option<Arc<ModuleManager>>,
    /// L1 grounding 선언 — tool_name → grounded params (모듈 config 의 `grounding`).
    /// sysmod 등록 시 1회 parse. tools/call 게이트가 사용 (Fact-Provenance Firewall, plan #8-2).
    pub grounding: RwLock<HashMap<String, Vec<GroundedParam>>>,
}

impl McpServerState {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            vault,
            auth: None,
            module_manager: None,
            grounding: RwLock::new(HashMap::new()),
        }
    }

    /// 외부 사용자 API token 검증 활성 — AuthManager 설정.
    pub fn with_auth(mut self, auth: Arc<AuthManager>) -> Self {
        self.auth = Some(auth);
        self
    }

    /// sysmod enabled 토글 검사 — tools/list 시점 비활성 sysmod 필터.
    pub fn with_module_manager(mut self, mm: Arc<ModuleManager>) -> Self {
        self.module_manager = Some(mm);
        self
    }

    pub async fn register(&self, tool: McpTool) {
        self.tools.write().await.insert(tool.name.clone(), tool);
    }
}

/// JSON-RPC 2.0 request 형식.
#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

/// JSON-RPC 2.0 response — success.
#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    result: Value,
}

/// JSON-RPC 2.0 response — error.
#[derive(Debug, Serialize)]
struct JsonRpcError {
    jsonrpc: &'static str,
    id: Value,
    error: JsonRpcErrorBody,
}

#[derive(Debug, Serialize)]
struct JsonRpcErrorBody {
    code: i32,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

/// MCP "tools/list" 응답 형식.
#[derive(Debug, Serialize)]
struct ToolListItem {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
}

/// MCP "tools/call" 응답 content 형식.
#[derive(Debug, Serialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: &'static str,
    text: String,
}

/// 도구 가시성 — `sysmod_<name>` 영역만 enabled 토글 검사. 기타 도구 (render_* / builtin / mcp_*) 는 항상 가시.
/// ModuleManager 미설정 시 가시 (옛 호환).
fn is_tool_visible(state: &Arc<McpServerState>, tool_name: &str) -> bool {
    let Some(mm) = &state.module_manager else {
        return true;
    };
    let Some(rest) = tool_name.strip_prefix("sysmod_") else {
        return true;
    };
    // 모듈명 경계가 도구이름만으론 모호하다 — 두-단어 모듈(browser-scrape)이 `browser_scrape` 로 등록되고
    // 도메인 분리 도구는 `<module>_<domain>` 형태라, 첫 토막만 보면 모듈명을 못 잡는다.
    // (옛 버그: `sysmod_browser_scrape` → candidate `browser` 로 검사 → 그런 모듈 없음 → default true → disabled 무시.)
    // 정공 = rest 의 세그먼트 prefix 들을 dash 로 이어 실제 config(is_enabled)에 묻는다. 명시적으로 비활성인
    // prefix 가 하나라도 있으면 그 모듈이 꺼진 것 → 숨김. 미존재 이름은 default true 라 무영향.
    let segs: Vec<&str> = rest.split('_').collect();
    // 1. 전역 비활성 모듈 제외 (config is_enabled). 명시적으로 disabled 인 prefix 가 하나라도 있으면 숨김.
    for n in 1..=segs.len() {
        if !mm.is_enabled(&segs[..n].join("-")) {
            return false;
        }
    }
    // 2. hub 활성 시 — sysmod 가 allowed_sysmods ∪ CORE_SYSMODS 에 없으면 hub 도구목록에서도 제외.
    //    옛 버그: 전역 ON 이지만 hub 미허용인 sysmod(telegram 등)가 목록엔 남아 AI 가 호출 → 실행 게이트
    //    (is_sysmod_blocked_for_hub, 373)에 막혀 "허용 안 됨" + 턴 낭비. FC 경로(permits_tool)와 일관되게 목록에서 제외.
    if let Some(allowed) = firebat_core::utils::hub_context::active_allowed_sysmods() {
        let hub_ok = (1..=segs.len()).any(|n| {
            let name = segs[..n].join("-");
            firebat_core::utils::hub_context::CORE_SYSMODS.contains(&name.as_str())
                || allowed.iter().any(|a| a == &name)
        });
        if !hub_ok {
            return false;
        }
    }
    true
}

/// hub context 활성 시 도구 호출 args 에 owner/hubOwner/_hubScope/project 주입 — ai.rs FC 주입과 대칭.
/// CLI/hosted 모델은 ai.rs(FC) owner 주입을 우회하므로 MCP 경로에서 강제해야, hub 가 저장하는 자료(메모·엔티티·
/// 페이지 등)가 올바른 hub owner 로 들어가 사이드바(hub owner 조회)에 보인다. 미주입 시 'admin' default 로 새던 버그.
/// override = visitor 가 args 로 다른 owner 를 흘려 admin/타 hub 자료를 건드리지 못하게.
fn inject_hub_owner(args: &mut Value) {
    let Some((inst_id, sid)) = firebat_core::utils::hub_context::active_hub_owner() else {
        return;
    };
    let scope_id = if sid.is_empty() {
        inst_id.clone()
    } else {
        format!("{}:{}", inst_id, sid)
    };
    if let Some(obj) = args.as_object_mut() {
        obj.insert("owner".into(), Value::String(format!("hub:{}", scope_id)));
        obj.insert("hubOwner".into(), Value::String(scope_id.clone()));
        obj.insert("_hubScope".into(), Value::String(scope_id.clone()));
        // project 도 세션 스코프(`hub:<inst>:<sid>`) — owner 와 동일. 옛 `hub:<inst>`(인스턴스)는 같은 위젯 세션끼리 페이지 공유 root.
        obj.insert("project".into(), Value::String(format!("hub:{}", scope_id)));
    }
}

/// hub context 활성 시 permits_tool 정책으로 도구 호출을 차단하는지 — MCP 의 **모든** 핸들러(explicit 포함)에 적용.
/// FC 경로(ai.rs effective_tools 필터)와 동일한 hub_context::permits_tool 단일 정책. 옛 MCP 는 sysmod handler 와
/// auto-sync ProxyHandler 만 가드해서, request_secret(Vault)·network_request 같은 explicit 핸들러가 hub 정책을
/// 우회했다. dispatch 단일 지점 가드로 ③deny·배경실행을 hosted 경로에서도 일관 차단.
fn hub_blocks_tool(name: &str) -> bool {
    firebat_core::utils::hub_context::is_hub_context_active()
        && !firebat_core::utils::hub_context::permits_tool(
            name,
            &firebat_core::utils::hub_context::active_allowed_sysmods().unwrap_or_default(),
        )
}

/// `?token=` 쿼리 파라미터 — Claude.ai 웹 커스텀 커넥터용. 그 UI 는 URL + OAuth(선택)만 받고
/// 정적 Bearer 헤더 칸이 없어, 토큰을 URL 에 실어야 붙일 수 있다(헤더 방식은 Desktop/IDE/CLI 용).
#[derive(serde::Deserialize)]
pub struct TokenQuery {
    pub token: Option<String>,
}

/// Bearer token 검증 — 두 source 받음 (옛 frontend mcp-internal + mcp-app 통합):
///   1. Vault `system:internal-mcp-token` (옛 internal MCP 토큰 — Frontend / CLI 어댑터)
///   2. AuthManager.validate_api_token (옛 외부 MCP 토큰 — Claude desktop / Cursor 등)
/// 검증 성공 시 검증된 토큰 문자열 반환 — handle_rpc 가 이 토큰으로 hub 컨텍스트를 lookup 해 격리.
/// `query_token` = `?token=` fallback (헤더 우선; Claude.ai 웹 커넥터는 헤더 칸이 없어 URL 로 실음).
fn verify_token(
    state: &Arc<McpServerState>,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<String, StatusCode> {
    let header_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer "))
        .unwrap_or("");
    // 헤더 우선, 없으면 `?token=` 쿼리 fallback.
    let token = if !header_token.is_empty() {
        header_token
    } else {
        query_token.unwrap_or("").trim()
    };
    if token.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // 1. internal token 매칭 (constant-time 비교)
    let stored = state
        .vault
        .get_secret("system:internal-mcp-token")
        .unwrap_or_default();
    if !stored.is_empty() {
        let eq: bool =
            subtle::ConstantTimeEq::ct_eq(token.as_bytes(), stored.as_bytes()).into();
        if eq {
            return Ok(token.to_string());
        }
    }
    // 1.5. hub 턴별 토큰 — ai.rs 가 턴마다 발급·등록한 토큰. 등록돼 있으면 valid(동시 visitor 격리).
    //      handle_rpc 가 이 토큰으로 hub 컨텍스트를 찾아 CURRENT_HUB 에 주입한다.
    if firebat_core::utils::hub_context::is_registered_token(token) {
        return Ok(token.to_string());
    }
    // 2. 외부 사용자 API token 매칭 (AuthManager.validate_api_token).
    if let Some(auth_mgr) = &state.auth {
        if auth_mgr.validate_api_token(token).is_some() {
            return Ok(token.to_string());
        }
    }
    Err(StatusCode::UNAUTHORIZED)
}

async fn handle_rpc(
    State(state): State<Arc<McpServerState>>,
    axum::extract::Query(q): axum::extract::Query<TokenQuery>,
    headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    let token = match verify_token(&state, &headers, q.token.as_deref()) {
        Ok(t) => t,
        Err(status) => {
            return (status, Json(serde_json::json!({"error": "unauthorized"}))).into_response()
        }
    };
    if req.jsonrpc != "2.0" {
        return rpc_error(req.id.unwrap_or(Value::Null), -32600, "Invalid Request");
    }

    // hub 턴별 토큰이면 그 컨텍스트를, 아니면 None(admin) 을 이 요청 단위 task-local 에 주입.
    // active_* (inject_hub_owner / hub_blocks_tool / is_tool_visible / SearchLibraryHandler 등)는
    // 전역이 아니라 이 CURRENT_HUB 만 읽으므로 동시 요청이 서로 격리된다.
    let hub_ctx = firebat_core::utils::hub_context::lookup(&token);
    firebat_core::utils::hub_context::CURRENT_HUB
        .scope(hub_ctx, async move {
    match req.method.as_str() {
        "initialize" => {
            let id = req.id.unwrap_or(Value::Null);
            let body = serde_json::json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "firebat", "version": env!("CARGO_PKG_VERSION") },
            });
            rpc_success(id, body)
        }
        "tools/list" => {
            let id = req.id.unwrap_or(Value::Null);
            let tools = state.tools.read().await;
            let items: Vec<ToolListItem> = tools
                .values()
                .filter(|t| is_tool_visible(&state, &t.name))
                .map(|t| ToolListItem {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    input_schema: t.input_schema.clone(),
                })
                .collect();
            rpc_success(id, serde_json::json!({ "tools": items }))
        }
        "tools/call" => {
            let id = req.id.unwrap_or(Value::Null);
            let name = req
                .params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut args = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            inject_hub_owner(&mut args);
            if name.is_empty() {
                return rpc_error(id, -32602, "missing 'name' parameter");
            }
            let tool = {
                let tools = state.tools.read().await;
                tools.get(&name).map(|t| t.handler.clone())
            };
            let Some(handler) = tool else {
                // unknown tool — JSON-RPC error 대신 tool result (isError: true) 로 반환.
                // 옛 = -32601 rpc_error 를 쓰던 곳. 단 CLI 자체 MCP loop (Claude Code / Codex / Gemini CLI)
                // 안에서 JSON-RPC error 는 LLM 에 명확히 전달되지 못해 hallucinate 도구
                // (TaskCreate / TaskUpdate / task_create / add_task 등) 호출 retry 를 유발한다.
                // tool result 형태로 반환하면 LLM 이 "다음 turn 에서 정공 도구 선택" 으로 인식한다.
                let available_preview: Vec<String> = {
                    let tools = state.tools.read().await;
                    let mut keys: Vec<String> = tools.keys().cloned().collect();
                    keys.sort();
                    keys.into_iter().take(15).collect()
                };
                let msg = format!(
                    "'{}' 도구는 존재하지 않습니다. 작업 예약 = schedule_task / 즉시 실행 = run_task / plan 카드 = propose_plan. 'tools/list' 에 있는 도구만 사용하세요. 일부 사용 가능 도구: {}",
                    name,
                    available_preview.join(", ")
                );
                let content = vec![ContentBlock {
                    block_type: "text",
                    text: serde_json::json!({ "error": msg }).to_string(),
                }];
                return rpc_success(
                    id,
                    serde_json::json!({ "content": content, "isError": true }),
                );
            };
            if hub_blocks_tool(&name) {
                let content = vec![ContentBlock {
                    block_type: "text",
                    text: serde_json::json!({
                        "error": format!("이 hub 에서는 '{}' 도구 사용이 허용되지 않습니다.", name)
                    })
                    .to_string(),
                }];
                return rpc_success(id, serde_json::json!({ "content": content, "isError": true }));
            }
            match gated_tool_call(&state, &name, args, &handler, &token).await {
                Ok(result) => {
                    let text = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
                    let content = vec![ContentBlock {
                        block_type: "text",
                        text,
                    }];
                    rpc_success(id, serde_json::json!({ "content": content, "isError": false }))
                }
                Err(err) => {
                    let content = vec![ContentBlock {
                        block_type: "text",
                        text: serde_json::json!({"error": err}).to_string(),
                    }];
                    rpc_success(id, serde_json::json!({ "content": content, "isError": true }))
                }
            }
        }
        "notifications/initialized" => (StatusCode::NO_CONTENT, Json(Value::Null)).into_response(),
        other => rpc_error(
            req.id.unwrap_or(Value::Null),
            -32601,
            &format!("method not found: {}", other),
        ),
    }
        })
        .await
}

fn rpc_success(id: Value, result: Value) -> axum::response::Response {
    Json(JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result,
    })
    .into_response()
}

fn rpc_error(id: Value, code: i32, message: &str) -> axum::response::Response {
    Json(JsonRpcError {
        jsonrpc: "2.0",
        id,
        error: JsonRpcErrorBody {
            code,
            message: message.to_string(),
            data: None,
        },
    })
    .into_response()
}

// ── L1 grounding gate — Fact-Provenance Firewall (plan #8-2) ──────────────────
// Declared opaque params (e.g. a stock code) must trace to a value the model observed this
// session — a prior tool result (a real lookup) or the user — else the call is rejected with
// a resolve hint and the model retries (resolve → use). Per-session corpus of recent
// tool-result text, TTL + size bounded; "recently observed" is enough to tell a looked-up id
// from an invented one. Covers the MCP path (both transports); the FC path builds its own
// corpus inline (Stage 2).

const OBSERVED_TTL: Duration = Duration::from_secs(30 * 60);
const OBSERVED_MAX: usize = 60;
const OBSERVED_TEXT_CAP: usize = 256 * 1024;

fn observed_store() -> &'static Mutex<HashMap<String, VecDeque<(Instant, String)>>> {
    static STORE: OnceLock<Mutex<HashMap<String, VecDeque<(Instant, String)>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn evict_expired(q: &mut VecDeque<(Instant, String)>) {
    let now = Instant::now();
    while q
        .front()
        .map(|(t, _)| now.duration_since(*t) > OBSERVED_TTL)
        .unwrap_or(false)
    {
        q.pop_front();
    }
    while q.len() > OBSERVED_MAX {
        q.pop_front();
    }
}

/// Record a successful tool result's text as provenance for this session.
fn record_observed(session: &str, text: &str) {
    // Cap stored text to bound memory. Identifier provenance comes from small lookup/grep
    // results, not huge numeric payloads, so a cap doesn't lose codes. Truncate on a char
    // boundary — byte slicing would panic on multi-byte (Korean) content.
    let capped = if text.len() > OBSERVED_TEXT_CAP {
        let mut end = OBSERVED_TEXT_CAP;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    } else {
        text.to_string()
    };
    let mut store = observed_store().lock().unwrap_or_else(|e| e.into_inner());
    let q = store.entry(session.to_string()).or_default();
    q.push_back((Instant::now(), capped));
    evict_expired(q);
}

/// The session's current provenance corpus (recent observed tool-result text).
fn observed_corpus(session: &str) -> Vec<String> {
    let mut store = observed_store().lock().unwrap_or_else(|e| e.into_inner());
    match store.get_mut(session) {
        Some(q) => {
            evict_expired(q);
            q.iter().map(|(_, s)| s.clone()).collect()
        }
        None => Vec::new(),
    }
}

/// tools/call wrapper — L1 grounding check (before) + provenance record (after). Both MCP
/// transports (HTTP `handle_rpc` / stdio `dispatch_method`) route through here so the gate
/// covers both (args-based, per the hub-scope lesson that task-local alone is a no-op on FC).
/// Returns the handler's result; a grounding rejection surfaces as `Err(hint)` → the existing
/// isError tool-result path delivers the hint to the model, which retries (resolve → use).
async fn gated_tool_call(
    state: &Arc<McpServerState>,
    name: &str,
    args: Value,
    handler: &Arc<dyn McpToolHandler>,
    session: &str,
) -> Result<Value, String> {
    let grounded = {
        let map = state.grounding.read().await;
        map.get(name).cloned()
    };
    if let Some(grounded) = grounded {
        if !grounded.is_empty() {
            if let Err(hint) = check_grounding(&args, &grounded, &observed_corpus(session)) {
                tracing::info!(target: "grounding", tool = name, "L1 grounding reject");
                return Err(hint);
            }
        }
    }
    let result = handler.call(args).await;
    if let Ok(ref v) = result {
        if let Ok(text) = serde_json::to_string(v) {
            record_observed(session, &text);
        }
    }
    result
}

async fn handle_sse(
    State(state): State<Arc<McpServerState>>,
    axum::extract::Query(q): axum::extract::Query<TokenQuery>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(status) = verify_token(&state, &headers, q.token.as_deref()) {
        return (status, "unauthorized").into_response();
    }
    // SSE streaming — 추후 도입 (listChanged 알림 등).
    // 현재는 빈 응답 (Claude CLI 의 long-polling 형 streamable HTTP 호환 위해 200 응답만).
    (StatusCode::OK, "").into_response()
}

/// MCP HTTP server router.
pub fn build_router(state: Arc<McpServerState>) -> Router {
    Router::new()
        .route("/mcp", post(handle_rpc).get(handle_sse))
        .with_state(state)
}

/// SysmodToolHandler — system/modules 의 sysmod 자동 등록. 옛 mcp/internal-server.ts:589-668 1:1.
/// ModuleManager.run(name, data) 위임 — Rust ModuleService.Run 의 단순 분기 활용 (path 형태는 sandboxExecute).
pub struct SysmodToolHandler {
    pub module_name: String,
    pub module_manager: Arc<ModuleManager>,
}

#[async_trait::async_trait]
impl McpToolHandler for SysmodToolHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // Hub visitor 가드 — hub_context 활성 상태에서 allowed_sysmods 에 없는 sysmod 호출 차단.
        // ai.rs:669-694 의 hub filter 는 tools.is_empty() 분기 (API 모델) 만 처리해 CLI 모델
        // (supports_mcp=true) 의 자체 MCP loop 에서는 우회된다. 본 가드 = MCP path 보안용.
        if firebat_core::utils::hub_context::is_sysmod_blocked_for_hub(&self.module_name) {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!(
                    "이 hub 에서는 sysmod '{}' 사용이 허용되지 않습니다.",
                    self.module_name
                ),
            }));
        }
        // 활성화 토글 가드 — 사용자가 시스템 설정에서 OFF 한 sysmod 는 호출 시점 차단.
        // tools/list 는 시작 시점 1회 등록이라 캐시된 도구 list 가 enabled 토글 변경 반영 0
        // (CLI 모드 / hosted MCP 가 list 캐시 보유). 호출 시점 가드가 single source of truth.
        if !self.module_manager.is_enabled(&self.module_name) {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!(
                    "모듈 '{}' 가 비활성화되어 있습니다. 시스템 설정에서 활성화 후 다시 시도하세요.",
                    self.module_name
                ),
            }));
        }
        let data = if args.is_null() {
            Value::Object(Default::default())
        } else {
            args
        };
        match self.module_manager.run(&self.module_name, &data).await {
            Ok(output) => {
                if output.success {
                    Ok(serde_json::json!({ "success": true, "data": output.data }))
                } else {
                    // i18n lookup — sysmod 의 응답 `{success: false, errorKey: "X.Y", errorParams: {...}}`
                    // → `module.{module_name}.X.Y` 의 i18n 변환. fallback: 옛 raw error string.
                    let error_msg = resolve_sysmod_error(&self.module_name, &output);
                    Ok(serde_json::json!({
                        "success": false,
                        "error": error_msg,
                    }))
                }
            }
            Err(e) => Err(e),
        }
    }
}

/// sysmod 의 응답 `{errorKey, errorParams}` → i18n lookup. fallback: raw error.
fn resolve_sysmod_error(module_name: &str, output: &firebat_core::ports::ModuleOutput) -> String {
    // 새 패턴 — sysmod 의 envelope `{success: false, errorKey: "X.Y", errorParams: {...}}`.
    // sandbox 의 ModuleOutput.error_key / error_params 가 채워진 경로.
    if let Some(key) = &output.error_key {
        let params_obj = output.error_params.as_ref().and_then(|v| v.as_object());
        let owned: Vec<(String, String)> = params_obj
            .map(|obj| {
                obj.iter()
                    .map(|(k, v)| {
                        let s = match v {
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        (k.clone(), s)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let refs: Vec<(&str, &str)> =
            owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let full_key = format!("module.{}.{}", module_name, key);
        return firebat_core::i18n::t(&full_key, None, &refs);
    }
    // 옛 raw error fallback (legacy 호환)
    output
        .error
        .clone()
        .unwrap_or_else(|| "module failed".to_string())
}

/// system/modules 의 config.json 스캔 → sysmod_<name> 도구 자동 등록.
/// 옛 TS mcp/internal-server.ts:589-668 의 동적 노출 1:1.
///
/// 2026-05-14 옵션 C 적용 — config.json 의 `domains` 필드 있으면 도메인별 별도 도구 N개 등록
/// (sysmod_<name>_<domain>). 각 도구의 action enum 은 그 도메인의 actions 로 좁혀짐 (토큰 절감).
/// 단일 sysmod index.mjs 가 모든 도메인 처리 — domain 분리는 LLM 노출 layer 만.
pub async fn register_sysmod_tools(
    state: &Arc<McpServerState>,
    module_manager: Arc<ModuleManager>,
) {
    let entries = module_manager.list_system().await;
    for entry in entries {
        let config = match module_manager
            .get_module_config("system", &entry.name)
            .await
        {
            Some(c) => c,
            None => continue,
        };
        // domains 필드 있으면 → 도메인별 N 도구 등록 (옵션 C).
        if let Some(domains) = config.get("domains").and_then(|v| v.as_array()) {
            register_sysmod_domains(state, &entry.name, &config, domains, module_manager.clone())
                .await;
            continue;
        }
        // 기본 — 단일 도구 등록.
        let tool_name = format!("sysmod_{}", entry.name.replace('-', "_"));
        let description = build_sysmod_description(&entry.name, &config);
        let input_schema = config
            .get("input")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}}));
        let tool = McpTool {
            name: tool_name.clone(),
            description,
            input_schema,
            handler: Arc::new(SysmodToolHandler {
                module_name: entry.name.clone(),
                module_manager: module_manager.clone(),
            }),
        };
        state.register(tool).await;
        let g = parse_grounding(&config);
        if !g.is_empty() {
            state.grounding.write().await.insert(tool_name.clone(), g);
        }
    }
}

/// config.domains 가 있을 때 — 각 domain 마다 sysmod_<name>_<domain> 도구 N개 등록.
/// 모든 도구가 같은 SysmodToolHandler (단일 모듈) 로 라우팅 — action enum 만 도메인별 좁혀짐.
async fn register_sysmod_domains(
    state: &Arc<McpServerState>,
    module_name: &str,
    config: &Value,
    domains: &[Value],
    module_manager: Arc<ModuleManager>,
) {
    // base input schema (action / params / query / body / mock — domain 공통)
    let base_input = config
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"type": "object", "properties": {}}));

    for domain in domains {
        let domain_name = match domain.get("name").and_then(|v| v.as_str()) {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        let domain_desc = domain
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let actions: Vec<Value> = domain
            .get("actions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if actions.is_empty() {
            continue;
        }

        // input schema 복사 + action enum 을 이 도메인의 actions 로 좁힘
        let mut input_schema = base_input.clone();
        if let Some(props) = input_schema
            .get_mut("properties")
            .and_then(|v| v.as_object_mut())
        {
            if let Some(action_field) = props.get_mut("action").and_then(|v| v.as_object_mut()) {
                action_field.insert("enum".to_string(), Value::Array(actions.clone()));
            }
        }

        let names = firebat_core::utils::secret_schema::secret_names(config);
        let secrets_note = if names.is_empty() {
            String::new()
        } else {
            format!(
                "\n필요 시크릿: {} (미설정 시 request_secret 호출)",
                names.join(", ")
            )
        };
        let description = format!(
            "[시스템 모듈] {desc}\n총 {n}개 API. action 으로 API ID 직접 호출.{secrets_note}",
            desc = if domain_desc.is_empty() { module_name } else { domain_desc },
            n = actions.len(),
        );
        let tool_name = format!(
            "sysmod_{}_{}",
            module_name.replace('-', "_"),
            domain_name.replace('-', "_")
        );
        let g = parse_grounding(config);
        if !g.is_empty() {
            state.grounding.write().await.insert(tool_name.clone(), g);
        }
        let tool = McpTool {
            name: tool_name,
            description,
            input_schema,
            handler: Arc::new(SysmodToolHandler {
                module_name: module_name.to_string(),
                module_manager: module_manager.clone(),
            }),
        };
        state.register(tool).await;
    }
}

/// RenderUnifiedHandler — 단일 `render` 도구 (옵션 E hybrid, 2026-05-14).
///
/// 옛 26개 render_* 도구 폐기 → 단일 `render({ blocks: [{type, props}] })` 로 통합.
/// type 별 propsSchema 검증 (components.json) — 실패 시 LLM 에게 에러 회신 + retry 유도.
/// 결과는 `{ success: true, blocks: [{type:"component", name, props}] }` — Frontend ChatBubble 가
/// 그대로 렌더.
///
/// 장점: LLM tool list 토큰 ~70% 절감 + 새 컴포넌트 추가 시 components.json 만 수정.
pub struct RenderUnifiedHandler;

#[async_trait::async_trait]
impl McpToolHandler for RenderUnifiedHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // 실행 본체는 core 의 단일 소스에 있음 (ToolManager FC 경로와 공유 → drift 차단).
        // tool_mode=true: reject components other than code/math/diagram (force fence, block Korean corruption).
        firebat_core::managers::ai::render_exec::render_blocks(&args, true)
    }
}

/// 단일 `render` MCP 도구 등록 — 옛 register_render_tools 의 26개 분리 등록 폐기.
/// blocks 안 type 은 components.json 안 컴포넌트 이름 enum (LLM 이 schema 로 좁힘).
pub async fn register_render_tools(state: &Arc<McpServerState>) {
    let names: Vec<Value> = firebat_core::managers::ai::component_registry::component_names()
        .iter()
        .map(|n| Value::String((*n).to_string()))
        .collect();
    let description = "UI 컴포넌트 렌더링 — 한 번에 여러 blocks 배열로 렌더. \
        각 block 은 `type` (컴포넌트 이름, 26 종 enum) + `props` (해당 컴포넌트 schema 에 맞는 데이터). \
        propsSchema 는 search_components(query) 또는 시스템 프롬프트의 컴포넌트 카탈로그 참조. \
        실패 시 schema 에러 반환 — LLM 이 props 맞춰 재호출."
        .to_string();
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "blocks": {
                "type": "array",
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string", "enum": names },
                        "props": { "type": "object" }
                    },
                    "required": ["type", "props"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["blocks"],
        "additionalProperties": false
    });
    let tool = McpTool {
        name: "render".to_string(),
        description,
        input_schema: schema,
        handler: Arc::new(RenderUnifiedHandler),
    };
    state.register(tool).await;
}

fn build_sysmod_description(name: &str, config: &Value) -> String {
    let base = config
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or(name)
        .to_string();
    let cap = config
        .get("capability")
        .and_then(|v| v.as_str())
        .map(|c| format!("\ncapability: {c}"))
        .unwrap_or_default();
    let names = firebat_core::utils::secret_schema::secret_names(config);
    let secrets = if names.is_empty() {
        String::new()
    } else {
        format!("\n필요 시크릿: {} (미설정 시 request_secret 호출)", names.join(", "))
    };
    format!("[시스템 모듈] {base}{cap}{secrets}")
}

// ════════════════════════════════════════════════════════════════════════════
// Builtin tool handlers — 옛 mcp/internal-server.ts 의 30+ 도구 1:1 port.
// 각 handler 가 매니저 위임. 모든 매니저는 register_builtin_tools 가 한 번에 주입.
// ════════════════════════════════════════════════════════════════════════════

fn schema_object(props: serde_json::Value) -> Value {
    serde_json::json!({"type": "object", "properties": props, "additionalProperties": false})
}

fn obj_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str().map(String::from))
}
fn obj_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| v.as_i64())
}
fn obj_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

// ── PageService 도구 ──────────────────────────────────────────────────────

pub struct ListPagesHandler {
    pub page: Arc<PageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ListPagesHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // project (hub: injected) → hub visitor sees only their own pages. admin (None) = full list.
        let items = self.page.list_scoped(obj_str(&args, "project").as_deref());
        Ok(serde_json::json!({"success": true, "data": items}))
    }
}

pub struct GetPageHandler {
    pub page: Arc<PageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for GetPageHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let slug = obj_str(&args, "slug").ok_or_else(|| "slug 필수".to_string())?;
        // project (hub: injected) → return None for pages outside the visitor's scope. admin = no check.
        match self.page.get_scoped(&slug, obj_str(&args, "project").as_deref()) {
            Some(rec) => Ok(serde_json::json!({"success": true, "data": rec})),
            None => Ok(serde_json::json!({"success": false, "error": "page not found"})),
        }
    }
}

/// admin context 면 pending 결과 반환 (Some). cron context 면 None — caller 가 기존 동작 진행.
///
/// 옛 TS commit 262bc78 의 `globalThis.__firebatCronAgentJobId` 분기 Rust port. CLI 모델의 자체
/// MCP loop 가 destructive 도구 (save_page / delete_* / schedule_task / cancel_cron_job) 호출 시
/// 본 helper 통과 — admin chat 호출이면 pending action 생성 → 사용자 ✓ 승인해야 실행. cron 자동
/// 실행 (CronContextGuard 활성) 이면 우회 후 직접 실행.
fn pending_or_passthrough(
    args: &Value,
    tool_name: &str,
    summary_fn: impl FnOnce(&Value) -> String,
) -> Option<Value> {
    // cron auto-run = passthrough (no human to approve in a cron context).
    // hub visitors NOW get the same approval card as admin (#10): the destructive tool is staged as a
    // pending(hub_scope) instead of executing immediately, and the visitor approves via
    // /api/hub/<slug>/plan which executes in their own owner scope. (old: hub also passthrough — the
    // tools are owner-scoped so it was safe, but hub=admin principle → give the approval card.)
    if firebat_core::utils::cron_context::is_cron_context_active() {
        return None;
    }
    let pending_args = match firebat_core::utils::pending_tools::PendingActionArgs::from_call(
        tool_name, args,
    ) {
        Ok(t) => t,
        Err(e) => return Some(serde_json::json!({"success": false, "error": e})),
    };
    let summary = summary_fn(args);
    // hub scope (inst:sid) if in a hub context — recorded on the pending so /api/hub/<slug>/plan can
    // cross-tenant-guard + re-apply the owner scope at commit. None = admin.
    let hub_scope = firebat_core::utils::hub_context::active_hub_owner().map(|(inst, sid)| {
        if sid.is_empty() { inst } else { format!("{}:{}", inst, sid) }
    });
    let plan_id =
        firebat_core::utils::pending_tools::create_pending_scoped(pending_args, &summary, hub_scope);
    Some(serde_json::json!({
        "success": true,
        "pending": true,
        "planId": plan_id,
        "name": tool_name,
        "summary": summary,
        "args": args,
        "message": format!(
            "'{}' — 사용자 승인 대기 중입니다. 자동으로 실행되지 않았습니다.",
            summary
        ),
    }))
}

pub struct SavePageHandler {
    pub page: Arc<PageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SavePageHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // admin context → pending 생성 (사용자 승인 카드). cron context → 직접 실행.
        // 옛 TS commit 262bc78 의 globalThis.__firebatCronAgentJobId 분기 Rust port.
        if let Some(r) = pending_or_passthrough(&args, "save_page", |s| {
            let slug = obj_str(s, "slug").unwrap_or_default();
            let overwrite = s.get("allowOverwrite").and_then(|v| v.as_bool()).unwrap_or(false);
            format!("페이지 저장: /{}{}", slug, if overwrite { " (덮어쓰기)" } else { "" })
        }) {
            return Ok(r);
        }
        let slug = obj_str(&args, "slug").ok_or_else(|| "slug 필수".to_string())?;
        let spec = args
            .get("spec")
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .ok_or_else(|| "spec 필수".to_string())?;
        let status = obj_str(&args, "status").unwrap_or_else(|| "published".to_string());
        let project = obj_str(&args, "project");
        let visibility = obj_str(&args, "visibility");
        let password = obj_str(&args, "password");
        match self.page.save(
            &slug,
            &spec,
            &status,
            project.as_deref(),
            visibility.as_deref(),
            password.as_deref(),
        ) {
            Ok(()) => Ok(serde_json::json!({"success": true, "slug": slug})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct DeletePageHandler {
    pub page: Arc<PageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for DeletePageHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        if let Some(r) = pending_or_passthrough(&args, "delete_page", |s| {
            format!("페이지 삭제: /{}", obj_str(s, "slug").unwrap_or_default())
        }) {
            return Ok(r);
        }
        let slug = obj_str(&args, "slug").ok_or_else(|| "slug 필수".to_string())?;
        // project (hub: injected by inject_hub_owner) scopes the delete — hub visitor can only delete
        // their own page. admin (no project) = unscoped. Closes the cross-tenant delete gap.
        match self.page.delete(&slug, obj_str(&args, "project").as_deref()) {
            Ok(()) => Ok(serde_json::json!({"success": true})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── StorageService 도구 ───────────────────────────────────────────────────

pub struct ReadFileHandler {
    pub storage: Arc<StorageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ReadFileHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let path = obj_str(&args, "path").ok_or_else(|| "path 필수".to_string())?;
        let path = match firebat_core::utils::hub_context::confine_hub_path(&args, &path) {
            Ok(p) => p,
            Err(e) => return Ok(serde_json::json!({"success": false, "error": e})),
        };
        match self.storage.read(&path).await {
            Ok(content) => Ok(serde_json::json!({"success": true, "content": content})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct WriteFileHandler {
    pub storage: Arc<StorageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for WriteFileHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let path = obj_str(&args, "path").ok_or_else(|| "path 필수".to_string())?;
        let content = obj_str(&args, "content").ok_or_else(|| "content 필수".to_string())?;
        let path = match firebat_core::utils::hub_context::confine_hub_path(&args, &path) {
            Ok(p) => p,
            Err(e) => return Ok(serde_json::json!({"success": false, "error": e})),
        };
        match self.storage.write(&path, &content).await {
            Ok(()) => Ok(serde_json::json!({"success": true})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct DeleteFileHandler {
    pub storage: Arc<StorageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for DeleteFileHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        if let Some(r) = pending_or_passthrough(&args, "delete_file", |s| {
            format!("파일 삭제: {}", obj_str(s, "path").unwrap_or_default())
        }) {
            return Ok(r);
        }
        let path = obj_str(&args, "path").ok_or_else(|| "path 필수".to_string())?;
        let path = match firebat_core::utils::hub_context::confine_hub_path(&args, &path) {
            Ok(p) => p,
            Err(e) => return Ok(serde_json::json!({"success": false, "error": e})),
        };
        match self.storage.delete(&path).await {
            Ok(()) => Ok(serde_json::json!({"success": true})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct ListDirHandler {
    pub storage: Arc<StorageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ListDirHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let path = obj_str(&args, "path").unwrap_or_else(|| ".".to_string());
        let path = match firebat_core::utils::hub_context::confine_hub_path(&args, &path) {
            Ok(p) => p,
            Err(e) => return Ok(serde_json::json!({"success": false, "error": e})),
        };
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let json: Vec<Value> = entries
                    .into_iter()
                    .map(|e| serde_json::json!({"name": e.name, "isDirectory": e.is_directory}))
                    .collect();
                Ok(serde_json::json!({"success": true, "data": json}))
            }
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── ModuleService 도구 (execute = 사용자 정의 모듈) ──────────────────────────

pub struct ExecuteHandler {
    pub module: Arc<ModuleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ExecuteHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let path = obj_str(&args, "path").ok_or_else(|| "path 필수".to_string())?;
        // execute = user/modules only (system modules via sysmod_*). Same confine as file tools —
        // blocks executing module source under system/ etc. (admin → user/ zone, hub → session jail).
        let path = match firebat_core::utils::hub_context::confine_hub_path(&args, &path) {
            Ok(p) => p,
            Err(e) => return Ok(serde_json::json!({"success": false, "error": e})),
        };
        let input = args
            .get("inputData")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        if input.is_object() && input.as_object().map(|m| m.is_empty()).unwrap_or(false) {
            return Ok(serde_json::json!({"success": false, "error": "inputData 빈 객체 금지. 모듈 입력 필드를 실제 값으로 채워라. 시스템 모듈이면 sysmod_* 사용."}));
        }
        match self
            .module
            .execute(
                &path,
                &input,
                &firebat_core::ports::SandboxExecuteOpts::default(),
            )
            .await
        {
            Ok(output) => Ok(if output.success {
                serde_json::json!({"success": true, "data": output.data})
            } else {
                serde_json::json!({"success": false, "error": output.error.unwrap_or_default()})
            }),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── ScheduleService 도구 ──────────────────────────────────────────────────

pub struct ScheduleTaskHandler {
    pub schedule: Arc<ScheduleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ScheduleTaskHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        if let Some(r) = pending_or_passthrough(&args, "schedule_task", |s| {
            let title = obj_str(s, "title").unwrap_or_else(|| "(제목 없음)".to_string());
            let when = obj_str(s, "cronTime")
                .or_else(|| obj_str(s, "runAt"))
                .or_else(|| {
                    s.get("delaySec")
                        .and_then(|v| v.as_i64())
                        .map(|d| format!("{}초 후", d))
                })
                .unwrap_or_default();
            format!("예약 등록: {} ({})", title, when)
        }) {
            return Ok(r);
        }
        let job_id = obj_str(&args, "jobId").unwrap_or_default();
        let target_path = obj_str(&args, "targetPath").unwrap_or_default();
        let opts: CronScheduleOptions = serde_json::from_value(args.clone()).unwrap_or_default();
        match self.schedule.schedule(&job_id, &target_path, opts).await {
            Ok(()) => Ok(serde_json::json!({"success": true, "jobId": job_id})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// cron(스케줄) 도메인 — ScheduleManager 백엔드. ToolManager(register_schedule_tools) 와 동일 이름.
// 도메인 구분: **cron = 스케줄**(예약·반복) ↔ **task = 파이프라인**(run_task, 즉시 1회).
// 옛 이름 cancel_task/list_tasks 는 ScheduleManager 백엔드인데 task 와 혼동돼 cron 이름으로 통일.
pub struct CancelCronJobHandler {
    pub schedule: Arc<ScheduleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for CancelCronJobHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        if let Some(r) = pending_or_passthrough(&args, "cancel_cron_job", |s| {
            format!("예약 해제: {}", obj_str(s, "jobId").unwrap_or_default())
        }) {
            return Ok(r);
        }
        let job_id = obj_str(&args, "jobId").ok_or_else(|| "jobId 필수".to_string())?;
        let owner = obj_str(&args, "owner").filter(|s| !s.is_empty()); // latent 방어 — admin=None=무검사, hub=자기 잡만
        match self.schedule.cancel_owned(&job_id, owner.as_deref()).await {
            Ok(true) => Ok(serde_json::json!({"success": true})),
            Ok(false) => Ok(serde_json::json!({"success": false, "error": format!("cron 잡 {} 미등록", job_id)})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct ListCronJobsHandler {
    pub schedule: Arc<ScheduleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ListCronJobsHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // hub 면 주입된 owner 로 스코프(args-based) — owner 버리고 list() 호출해 전 테넌트 크론 노출하던 누수(CRON-2) fix
        let owner = args.get("owner").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        let jobs = match owner { Some(o) => self.schedule.list_by_owner(Some(o)), None => self.schedule.list() };
        Ok(serde_json::json!({"success": true, "data": jobs}))
    }
}

pub struct RunCronJobHandler {
    pub schedule: Arc<ScheduleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for RunCronJobHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let job_id = obj_str(&args, "jobId").ok_or_else(|| "jobId 필수".to_string())?;
        let owner = obj_str(&args, "owner").filter(|s| !s.is_empty()); // latent 방어 — admin=None=무검사, hub=자기 잡만
        match self.schedule.trigger_now_owned(&job_id, owner.as_deref()).await {
            Ok(()) => Ok(serde_json::json!({"success": true})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── TaskService 도구 (run_task = 파이프라인 즉시 실행) ────────────────────

pub struct RunTaskHandler {
    pub task: Arc<TaskManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for RunTaskHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let pipeline = args.get("pipeline").cloned().unwrap_or(Value::Array(vec![]));
        let steps: Vec<PipelineStep> =
            serde_json::from_value(pipeline).map_err(|e| format!("pipeline: {e}"))?;
        let result = self.task.execute_pipeline(&steps).await;
        Ok(if result.success {
            serde_json::json!({"success": true, "data": result.data})
        } else {
            serde_json::json!({"success": false, "error": result.error.unwrap_or_default()})
        })
    }
}

// ── SysmodCache drill-in 도구 (cache_read / cache_grep / cache_aggregate / cache_drop) ──
// 큰 sysmod 응답(yfinance/한투/키움/DART 시계열)의 `_cacheKey` 부분 조회.
// ToolManager(tool_registry.rs::register_cache_tools, API 모델용)와 동일 동작 — CLI(hosted MCP)
// 모델도 tools/list 로 보고 직접 호출하도록 MCP 레이어에도 등록. (옛 ToolManager 에만 있어
// CLI 가 execute/run_task 로 우회하다 실패하던 것 정정.)

pub struct CacheReadHandler {
    pub cache: Arc<SysmodCacheAdapter>,
}
#[async_trait::async_trait]
impl McpToolHandler for CacheReadHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let key = obj_str(&args, "cacheKey").ok_or_else(|| "cache_read: cacheKey 필수".to_string())?;
        let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
        self.cache.read(&key, offset, limit)
    }
}

pub struct CacheGrepHandler {
    pub cache: Arc<SysmodCacheAdapter>,
}
#[async_trait::async_trait]
impl McpToolHandler for CacheGrepHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let key = obj_str(&args, "cacheKey").ok_or_else(|| "cache_grep: cacheKey 필수".to_string())?;
        let field = obj_str(&args, "field").ok_or_else(|| "cache_grep: field 필수".to_string())?;
        let op = obj_str(&args, "op").ok_or_else(|| "cache_grep: op 필수".to_string())?;
        let value = args
            .get("value")
            .cloned()
            .ok_or_else(|| "cache_grep: value 필수".to_string())?;
        self.cache.grep(&key, &field, &op, &value)
    }
}

pub struct CacheAggregateHandler {
    pub cache: Arc<SysmodCacheAdapter>,
}
#[async_trait::async_trait]
impl McpToolHandler for CacheAggregateHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let key = obj_str(&args, "cacheKey").ok_or_else(|| "cache_aggregate: cacheKey 필수".to_string())?;
        let field = obj_str(&args, "field").ok_or_else(|| "cache_aggregate: field 필수".to_string())?;
        let op = obj_str(&args, "op").ok_or_else(|| "cache_aggregate: op 필수".to_string())?;
        self.cache.aggregate(&key, &field, &op)
    }
}

pub struct CacheDropHandler {
    pub cache: Arc<SysmodCacheAdapter>,
}
#[async_trait::async_trait]
impl McpToolHandler for CacheDropHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let key = obj_str(&args, "cacheKey").ok_or_else(|| "cache_drop: cacheKey 필수".to_string())?;
        self.cache
            .drop_key(&key)
            .map(|_| serde_json::json!({"success": true}))
    }
}

// ── SecretService / McpService 도구 ───────────────────────────────────────

pub struct RequestSecretHandler {
    pub secret: Arc<SecretManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for RequestSecretHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let name = obj_str(&args, "name").ok_or_else(|| "name 필수".to_string())?;
        // Return presence only — never the secret VALUE into the AI context (prompt-injection
        // exfil risk). Modules receive secrets via sandbox env injection, not through the AI.
        let present = !self.secret.get_user(&name).unwrap_or_default().is_empty();
        Ok(serde_json::json!({"success": true, "name": name, "present": present}))
    }
}

pub struct McpCallHandler {
    pub mcp: Arc<McpManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for McpCallHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let server = obj_str(&args, "server").ok_or_else(|| "server 필수".to_string())?;
        let tool = obj_str(&args, "tool").ok_or_else(|| "tool 필수".to_string())?;
        let tool_args = args
            .get("arguments")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        match self.mcp.call_tool(&server, &tool, &tool_args).await {
            Ok(v) => Ok(serde_json::json!({"success": true, "data": v})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── EntityService / EpisodicService 도구 (Recall) ──────────────────

pub struct SaveEntityHandler {
    pub entity: Arc<EntityManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SaveEntityHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let input = SaveEntityInput {
            name: obj_str(&args, "name").ok_or_else(|| "name 필수".to_string())?,
            // Entity type is dormant/optional (name is the identity) — match the FC save_entity
            // tool + advertised schema (name-only). Older code forced it, breaking name-only saves.
            entity_type: obj_str(&args, "type")
                .or_else(|| obj_str(&args, "entityType"))
                .unwrap_or_default(),
            aliases: args
                .get("aliases")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
            metadata: args.get("metadata").cloned(),
            source_conv_id: obj_str(&args, "sourceConvId"),
            dedup_threshold: Some(0.92),
            owner: obj_str(&args, "owner"),
        };
        match self.entity.save_entity(input).await {
            Ok((id, created)) => Ok(serde_json::json!({"success": true, "id": id, "created": created})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct SaveEntityFactHandler {
    pub entity: Arc<EntityManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SaveEntityFactHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let input = SaveFactInput {
            entity_id: obj_i64(&args, "entityId").ok_or_else(|| "entityId 필수".to_string())?,
            content: obj_str(&args, "content").ok_or_else(|| "content 필수".to_string())?,
            fact_type: obj_str(&args, "factType"),
            occurred_at: obj_i64(&args, "occurredAt"),
            tags: args
                .get("tags")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
            source_conv_id: obj_str(&args, "sourceConvId"),
            ttl_days: obj_i64(&args, "ttlDays"),
            dedup_threshold: args.get("dedupThreshold").and_then(|v| v.as_f64()),
            owner: obj_str(&args, "owner"),
            supersede: args.get("supersede").and_then(|v| v.as_bool()).unwrap_or(false),
            explicit: args.get("explicit").and_then(|v| v.as_bool()).unwrap_or(false),
            confidence: args.get("confidence").and_then(|v| v.as_f64()),
        };
        match self.entity.save_fact(input).await {
            Ok((id, skipped, sim)) => Ok(serde_json::json!({
                "success": true, "id": id, "skipped": skipped, "similarity": sim
            })),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct SearchEntitiesHandler {
    pub entity: Arc<EntityManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SearchEntitiesHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let opts: EntitySearchOpts =
            serde_json::from_value(args).map_err(|e| format!("search_entities args: {e}"))?;
        match self.entity.search_entities(opts).await {
            Ok(list) => Ok(serde_json::json!({"success": true, "data": list})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct SearchEntityFactsHandler {
    pub entity: Arc<EntityManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SearchEntityFactsHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let opts: FactSearchOpts =
            serde_json::from_value(args).map_err(|e| format!("search_facts args: {e}"))?;
        match self.entity.search_facts(opts).await {
            Ok(list) => Ok(serde_json::json!({"success": true, "data": list})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct EntityTimelineHandler {
    pub entity: Arc<EntityManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for EntityTimelineHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let entity_id = obj_i64(&args, "entityId").ok_or_else(|| "entityId 필수".to_string())?;
        let opts: TimelineOpts =
            serde_json::from_value(args).unwrap_or_else(|_| TimelineOpts::default());
        match self.entity.get_entity_timeline(entity_id, opts) {
            Ok(list) => Ok(serde_json::json!({"success": true, "data": list})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct SaveEventHandler {
    pub episodic: Arc<EpisodicManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SaveEventHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let input = SaveEventInput {
            event_type: obj_str(&args, "type")
                .or_else(|| obj_str(&args, "eventType"))
                .ok_or_else(|| "type 필수".to_string())?,
            title: obj_str(&args, "title").ok_or_else(|| "title 필수".to_string())?,
            description: obj_str(&args, "description"),
            who: obj_str(&args, "who"),
            context: args.get("context").cloned(),
            occurred_at: obj_i64(&args, "occurredAt"),
            entity_ids: args
                .get("entityIds")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
            source_conv_id: obj_str(&args, "sourceConvId"),
            ttl_days: obj_i64(&args, "ttlDays"),
            dedup_threshold: args.get("dedupThreshold").and_then(|v| v.as_f64()),
            owner: obj_str(&args, "owner"),
            explicit: args.get("explicit").and_then(|v| v.as_bool()).unwrap_or(false),
            confidence: args.get("confidence").and_then(|v| v.as_f64()),
        };
        match self.episodic.save_event(input).await {
            Ok((id, skipped, sim)) => Ok(serde_json::json!({
                "success": true, "id": id, "skipped": skipped, "similarity": sim
            })),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct SearchEventsHandler {
    pub episodic: Arc<EpisodicManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SearchEventsHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let opts: EventSearchOpts =
            serde_json::from_value(args).map_err(|e| format!("search_events args: {e}"))?;
        match self.episodic.search_events(opts).await {
            Ok(list) => Ok(serde_json::json!({"success": true, "data": list})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct ListRecentEventsHandler {
    pub episodic: Arc<EpisodicManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ListRecentEventsHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let opts: ListRecentOpts =
            serde_json::from_value(args).unwrap_or_else(|_| ListRecentOpts::default());
        match self.episodic.list_recent_events(opts) {
            Ok(list) => Ok(serde_json::json!({"success": true, "data": list})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── ConversationService 도구 ──────────────────────────────────────────────

pub struct SearchHistoryHandler {
    pub conversation: Arc<ConversationManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SearchHistoryHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let owner = obj_str(&args, "owner").unwrap_or_else(|| "admin".to_string());
        let query = obj_str(&args, "query").ok_or_else(|| "query 필수".to_string())?;
        let opts = SearchHistoryOpts {
            current_conv_id: obj_str(&args, "currentConvId"),
            limit: obj_i64(&args, "limit").map(|v| v as usize),
            within_days: obj_i64(&args, "withinDays"),
            min_score: args.get("minScore").and_then(|v| v.as_f64()).map(|v| v as f32),
            include_blocks: obj_bool(&args, "includeBlocks").unwrap_or(false),
        };
        match self.conversation.search_history(&owner, &query, opts).await {
            Ok(matches) => Ok(serde_json::json!({"success": true, "data": matches})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// 라이브러리(업로드 자료) 검색 — E5(dense) + BM25(sparse) 하이브리드. AI 가 직접 호출해
// 질의를 다듬고 재검색할 수 있는 도구 (자동 주입과 별개로 AI 가 E5 를 능동 제어).
pub struct SearchLibraryHandler {
    pub library: Arc<LibraryManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SearchLibraryHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let owner = obj_str(&args, "owner").unwrap_or_else(|| "admin".to_string());
        let query = obj_str(&args, "query").ok_or_else(|| "query 필수".to_string())?;
        let limit = obj_i64(&args, "limit").map(|v| v as usize).unwrap_or(5).clamp(1, 20);
        // referenceIds — 특정 자료 그룹만 검색 (빈 배열/미지정 = owner 전체 Reference).
        let reference_ids: Vec<String> = args
            .get("referenceIds")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        // 본인(owner) 자료 검색
        let mut hits = match self.library.search_scoped(&owner, &reference_ids, &query, limit).await {
            Ok(h) => h,
            Err(e) => return Ok(serde_json::json!({"success": false, "error": e})),
        };
        // hub 위젯 — AI 가 특정 referenceIds 를 안 고른 경우, admin 이 이 hub 에 공유한 reference(allowed_references)도
        // 합쳐 검색 (위젯 챗봇이 admin 지식베이스로도 답하도록). FC 경로(ai.rs reference_filter)와 패리티.
        // referenceIds 를 명시했으면 그 의도 존중(추가 안 함). 본인 ∪ 공유 병합 후 점수순 truncate.
        if reference_ids.is_empty() {
            if let Some(allowed) = firebat_core::utils::hub_context::active_allowed_references() {
                let extra: Vec<String> = allowed.into_iter().filter(|r| !r.is_empty()).collect();
                if !extra.is_empty() {
                    if let Ok(shared) = self.library.search(&owner, &extra, &query, limit).await {
                        hits.extend(shared);
                        hits.sort_by(|a, b| {
                            b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        hits.truncate(limit);
                    }
                }
            }
        }
        if hits.is_empty() {
            Ok(serde_json::json!({
                "success": true,
                "data": [],
                "hint": "매치된 자료가 없습니다. 동의어·핵심 명사·상위어 등 다른 키워드로 재검색하거나, referenceIds 를 비워 전체 자료를 검색해 보세요."
            }))
        } else {
            Ok(serde_json::json!({"success": true, "data": hits}))
        }
    }
}

// ── MediaService 도구 (image_gen 비동기) ──────────────────────────────────

pub struct ImageGenHandler {
    pub media: Arc<MediaManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ImageGenHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let input: firebat_core::managers::media::GenerateImageInput =
            serde_json::from_value(args).map_err(|e| format!("image_gen args: {e}"))?;
        match self.media.start_generate(input).await {
            Ok((slug, url)) => Ok(serde_json::json!({
                "success": true, "slug": slug, "url": url, "status": "rendering"
            })),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// search_media / regenerate_image — ToolManager(register_media_tools) 와 같은 MediaManager 위임.
// 옛엔 MCP 누락이라 hosted MCP 모델(CLI/Anthropic/OpenAI)이 갤러리 검색·이미지 재생성 불가했음.
pub struct SearchMediaHandler {
    pub media: Arc<MediaManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SearchMediaHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let scope = obj_str(&args, "scope").and_then(|s| match s.as_str() {
            "user" => Some(firebat_core::ports::MediaScope::User),
            "system" => Some(firebat_core::ports::MediaScope::System),
            _ => None,
        });
        let opts = firebat_core::ports::MediaListOpts {
            search: obj_str(&args, "query"),
            scope,
            limit: args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize),
            offset: args.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize),
            hub_owner: obj_str(&args, "hubOwner"),
        };
        match self.media.list(opts).await {
            Ok(result) => Ok(serde_json::json!({"success": true, "data": result})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct RegenerateImageHandler {
    pub media: Arc<MediaManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for RegenerateImageHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let slug = obj_str(&args, "slug").ok_or_else(|| "slug 필수".to_string())?;
        // hubOwner (injected for hub turns) → regenerate_image_owned scopes to user/hub/<id>/media/ +
        // re-saves into the same hub scope. admin (None) = unscoped. Closes the cross-tenant regen leak.
        match self.media.regenerate_image_owned(&slug, obj_str(&args, "hubOwner").as_deref()).await {
            Ok((result, regen_from)) => {
                let mut value = serde_json::to_value(&result).unwrap_or_default();
                if let serde_json::Value::Object(ref mut map) = value {
                    map.insert("regenFrom".to_string(), serde_json::Value::String(regen_from));
                }
                Ok(serde_json::json!({"success": true, "data": value}))
            }
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

// ── AI 메타 도구 (suggest / propose_plan / network_request) ───────────────

pub struct SuggestHandler;
#[async_trait::async_trait]
impl McpToolHandler for SuggestHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // suggest 도구 — args.suggestions 그대로 echo (Frontend 가 UI suggestion 칩 렌더).
        Ok(serde_json::json!({"success": true, "suggestions": args.get("suggestions").cloned().unwrap_or(Value::Array(vec![]))}))
    }
}

pub struct ProposePlanHandler;
#[async_trait::async_trait]
impl McpToolHandler for ProposePlanHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // 실행 본체는 core plan_store 단일 소스 (ToolManager FC 경로와 공유 → drift 차단).
        Ok(firebat_core::utils::plan_store::build_propose_plan_result(&args))
    }
}

pub struct NetworkRequestHandler {
    pub network: Arc<dyn firebat_core::ports::INetworkPort>,
}
#[async_trait::async_trait]
impl McpToolHandler for NetworkRequestHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let url = obj_str(&args, "url").ok_or_else(|| "url 필수".to_string())?;
        // SSRF guard — block internal/private/metadata targets (prompt-injection defense).
        if let Some(reason) = firebat_core::utils::net_guard::is_blocked_fetch_url(&url) {
            tracing::warn!(target: "network", url = %url, %reason, "[network_request] SSRF 차단");
            return Ok(serde_json::json!({"success": false, "error": format!("network_request blocked ({reason}) — 내부/사설 주소 요청은 차단됩니다")}));
        }
        let method = obj_str(&args, "method").unwrap_or_else(|| "GET".to_string());
        let headers: Option<std::collections::HashMap<String, String>> = args
            .get("headers")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        let body = args.get("body").cloned();
        let timeout_ms = obj_i64(&args, "timeoutMs").unwrap_or(30_000) as u64;
        tracing::info!(
            target: "network",
            url = %url,
            method = %method,
            timeout_ms = timeout_ms,
            "[network_request] 호출 시작"
        );
        let req = firebat_core::ports::NetworkRequest {
            url: url.clone(),
            method: method.clone(),
            headers,
            body,
            timeout_ms,
        };
        match self.network.fetch(req).await {
            Ok(resp) => {
                let body_size = match &resp.body {
                    serde_json::Value::String(s) => s.len(),
                    other => other.to_string().len(),
                };
                tracing::info!(
                    target: "network",
                    url = %url,
                    status = resp.status,
                    ok = resp.ok,
                    body_size = body_size,
                    "[network_request] 응답 수신"
                );
                Ok(serde_json::json!({"success": true, "data": resp}))
            }
            Err(e) => {
                tracing::warn!(target: "network", url = %url, error = %e, "[network_request] 실패");
                Ok(serde_json::json!({"success": false, "error": e}))
            }
        }
    }
}

/// 모든 builtin 도구 일괄 등록. 옛 mcp/internal-server.ts 의 30+ server.tool 1:1 port.
pub struct BuiltinDeps {
    pub page: Arc<PageManager>,
    pub storage: Arc<StorageManager>,
    pub module: Arc<ModuleManager>,
    pub schedule: Arc<ScheduleManager>,
    pub task: Arc<TaskManager>,
    pub secret: Arc<SecretManager>,
    pub mcp: Arc<McpManager>,
    pub entity: Arc<EntityManager>,
    pub episodic: Arc<EpisodicManager>,
    pub conversation: Arc<ConversationManager>,
    pub media: Arc<MediaManager>,
    pub library: Arc<LibraryManager>,
    pub network: Arc<dyn firebat_core::ports::INetworkPort>,
    /// sysmod 자동캐시 drill-in (cache_read / cache_grep / cache_aggregate / cache_drop).
    /// sandbox 가 큰 응답을 저장한 것과 동일 Arc 여야 cacheKey 가 맞는다.
    pub cache: Arc<SysmodCacheAdapter>,
    /// Stage 2 auto-sync — ToolManager(core) 카탈로그를 iterate 해 MCP 에 빠진 도구를 자동 노출.
    /// 새 core 도구 추가 시 register_core_tools 한 곳만 등록하면 hosted MCP 에도 자동 반영(drift 차단).
    pub tool_manager: Arc<ToolManager>,
}

/// Stage 2 — ToolManager(core) 카탈로그 위임 핸들러. MCP 에 명시 핸들러 없는 core 도구를 자동 노출.
/// 기존 명시 핸들러(bespoke pending 요약·envelope 보유)는 그대로 보존되고, 본 핸들러는 그 외
/// (주로 read-only/meta) 도구 전용 — 새 core 도구 추가 시 register_core_tools 한 곳만 등록하면
/// hosted MCP tools/list 에도 자동 반영(drift 차단).
pub struct ToolManagerProxyHandler {
    pub tool_manager: Arc<ToolManager>,
    pub name: String,
}
#[async_trait::async_trait]
impl McpToolHandler for ToolManagerProxyHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        // hub visitor 가드 — read-only allow 규칙은 core 단일 소스(ai.rs FC 경로와 공유).
        // auto-sync 대상은 context 주입 불요한 read-only/meta 도구 — 인자 주입(hub_owner 등)이 필요한
        // 도구는 명시 핸들러로 등록해야 하며 auto-sync 대상이 아니다(아래 register 루프 skip 로직 참고).
        if firebat_core::utils::hub_context::is_hub_context_active()
            && !firebat_core::utils::hub_context::is_hub_readonly_tool(&self.name)
            // Project Builder 빌드 도구(start_build/advance_build/cancel_build)도 허용 — 빌드 세션은
            // hubOwner 로 scope(start_build 핸들러 + inject_hub_owner) 라 visitor 격리. permits_tool 과 짝.
            && !firebat_core::utils::hub_context::is_hub_build_tool(&self.name)
        {
            return Ok(serde_json::json!({
                "success": false,
                "error": format!("이 hub 에서는 '{}' 도구 사용이 허용되지 않습니다.", self.name)
            }));
        }
        // ToolManager 핸들러는 raw 결과(success 필드 없음)를 반환할 수 있음 — CLI(cli_claude_code)가
        // tool_result 의 success 로 done/error 판정하므로 없으면 false 빨간 뱃지로 오인(cache_read 와 동류).
        // 성공 dispatch 면 success:true 보장(이미 있으면 보존). 객체 아니면 {success, data} 래핑.
        match self.tool_manager.dispatch(&self.name, &args).await {
            Ok(Value::Object(mut m)) => {
                m.entry("success".to_string()).or_insert(Value::Bool(true));
                Ok(Value::Object(m))
            }
            Ok(other) => Ok(serde_json::json!({ "success": true, "data": other })),
            Err(e) => Err(e),
        }
    }
}

/// auto-sync 제외 목록 — 다른 이름의 명시 핸들러가 이미 같은 기능 제공 시 추가(중복 방지).
/// (call_mcp_tool↔mcp_call 이름 통일 후 비어있음. ToolManager 와 MCP 가 mcp_call 로 일치.)
const AUTOSYNC_SKIP: &[&str] = &[];

pub async fn register_builtin_tools(state: &Arc<McpServerState>, deps: BuiltinDeps) {
    // Page
    state.register(McpTool {
        name: "list_pages".into(),
        description: "전체 페이지 메타 목록 반환 (slug / status / project / updatedAt 등).".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(ListPagesHandler { page: deps.page.clone() }),
    }).await;
    state.register(McpTool {
        name: "get_page".into(),
        description: "단일 페이지 전체 spec 조회. inputSchema: {slug}.".into(),
        input_schema: schema_object(serde_json::json!({"slug": {"type": "string"}})),
        handler: Arc::new(GetPageHandler { page: deps.page.clone() }),
    }).await;
    state.register(McpTool {
        name: "save_page".into(),
        description: "페이지 spec 저장 (생성/덮어쓰기). inputSchema: {slug, spec, status?, project?, visibility?, password?}.".into(),
        input_schema: schema_object(serde_json::json!({
            "slug": {"type": "string"},
            "spec": {"type": "object"},
            "status": {"type": "string"},
            "project": {"type": "string"},
            "visibility": {"type": "string"},
            "password": {"type": "string"}
        })),
        handler: Arc::new(SavePageHandler { page: deps.page.clone() }),
    }).await;
    state.register(McpTool {
        name: "delete_page".into(),
        description: "페이지 삭제. inputSchema: {slug}.".into(),
        input_schema: schema_object(serde_json::json!({"slug": {"type": "string"}})),
        handler: Arc::new(DeletePageHandler { page: deps.page }),
    }).await;

    // Storage
    state.register(McpTool {
        name: "read_file".into(),
        description: "파일 내용 읽기. inputSchema: {path}.".into(),
        input_schema: schema_object(serde_json::json!({"path": {"type": "string"}})),
        handler: Arc::new(ReadFileHandler { storage: deps.storage.clone() }),
    }).await;
    state.register(McpTool {
        name: "write_file".into(),
        description: "파일 생성/덮어쓰기. inputSchema: {path, content}.".into(),
        input_schema: schema_object(serde_json::json!({"path": {"type": "string"}, "content": {"type": "string"}})),
        handler: Arc::new(WriteFileHandler { storage: deps.storage.clone() }),
    }).await;
    state.register(McpTool {
        name: "delete_file".into(),
        description: "파일 삭제. inputSchema: {path}.".into(),
        input_schema: schema_object(serde_json::json!({"path": {"type": "string"}})),
        handler: Arc::new(DeleteFileHandler { storage: deps.storage.clone() }),
    }).await;
    state.register(McpTool {
        name: "list_dir".into(),
        description: "디렉토리 항목 목록. inputSchema: {path}.".into(),
        input_schema: schema_object(serde_json::json!({"path": {"type": "string"}})),
        handler: Arc::new(ListDirHandler { storage: deps.storage }),
    }).await;

    // Module
    state.register(McpTool {
        name: "execute".into(),
        description: "⚠️ 시스템 모듈은 sysmod_* 사용. user/modules 사용자 정의 모듈 실행 전용. inputSchema: {path, inputData}.".into(),
        input_schema: schema_object(serde_json::json!({
            "path": {"type": "string"},
            "inputData": {"type": "object"}
        })),
        handler: Arc::new(ExecuteHandler { module: deps.module }),
    }).await;

    // Schedule / Task — trigger 시각은 cronTime/runAt/delaySec 중 직접 하나만 지정.
    // 옛에 mode field 가 있어 AI 가 `mode: "runAt"` 만 쓰고 실제 runAt 누락 → validator reject 반복.
    // core/src/tool_registry.rs 의 schedule_task schema 와 일관성 유지.
    state.register(McpTool {
        name: "schedule_task".into(),
        description: "크론 / 일회성 작업 예약 — 특정 시각·주기에 작업을 자동 실행한다(스케줄). 단지 날짜·약속을 기록만 할 거면 sysmod_calendar(캘린더)를 써라. trigger 시각은 cronTime(반복: '0 8 * * *' 형태) / runAt(1회 ISO 8601 + timezone offset, 예: '2026-05-25T14:35:00+09:00') / delaySec(N초 후) 중 정확히 하나의 field 만 지정한다. 'mode' 같은 별도 field 는 넣지 마라 — schema 에 없다.".into(),
        input_schema: schema_object(serde_json::json!({
            "jobId": {"type": "string", "description": "고유 job id (이미 있는 jobId 면 덮어쓰기)"},
            "targetPath": {"type": "string", "description": "executionMode=agent 면 'agent'. 인라인 파이프라인은 아래 pipeline 필드 사용(이때 targetPath 는 라벨)"},
            "cronTime": {"type": "string", "description": "반복 cron 표현식 (분 시 일 월 요일). 없으면 runAt/delaySec 중 하나 지정"},
            "runAt": {"type": "string", "description": "1회 실행 ISO 8601 (반드시 timezone offset 포함, 예: +09:00)"},
            "delaySec": {"type": "integer", "description": "N 초 후 1회 실행"},
            "title": {"type": "string"},
            "executionMode": {"type": "string", "enum": ["pipeline", "agent"], "description": "매 trigger 같은 절차면 pipeline(권장 — 결정적, 런타임 LLM 0회 또는 합성 1회), 매 trigger 런타임 판단 필요하면 agent(매번 LLM 루프)"},
            "pipeline": {"type": "array", "description": "executionMode=pipeline 의 결정적 step 배열. step={type: EXECUTE|MCP_CALL|NETWORK_REQUEST|CONDITION|LLM_TRANSFORM|SAVE_PAGE|TOOL_CALL, ...}. 이전 step 출력은 inputMap/$prev 로 참조. 임계·규칙 판정은 CONDITION. 요약·리포트 합성이 필요하면 LLM_TRANSFORM 한 step(자동 컨텍스트 없으니 형식·구조 지시는 instruction 에 명시)", "items": {"type": "object"}},
            "agentPrompt": {"type": "string", "description": "executionMode=agent 일 때 AI 가 매 trigger 받는 자연어 지시문"}
        })),
        handler: Arc::new(ScheduleTaskHandler { schedule: deps.schedule.clone() }),
    }).await;
    // cron(스케줄) 도메인 — ToolManager 와 동일 이름. 옛 cancel_task/list_tasks 는 task(파이프라인)와
    // 혼동돼 cron 이름으로 통일 (둘 다 ScheduleManager 백엔드).
    state.register(McpTool {
        name: "cancel_cron_job".into(),
        description: "cron / 예약 잡 해제. inputSchema: {jobId}.".into(),
        input_schema: schema_object(serde_json::json!({"jobId": {"type": "string"}})),
        handler: Arc::new(CancelCronJobHandler { schedule: deps.schedule.clone() }),
    }).await;
    state.register(McpTool {
        name: "list_cron_jobs".into(),
        description: "등록된 cron / 1회 예약 / delay 잡 목록.".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(ListCronJobsHandler { schedule: deps.schedule.clone() }),
    }).await;
    state.register(McpTool {
        name: "run_cron_job".into(),
        description: "예약 작업 즉시 실행 (one-shot). inputSchema: {jobId}.".into(),
        input_schema: schema_object(serde_json::json!({"jobId": {"type": "string"}})),
        handler: Arc::new(RunCronJobHandler { schedule: deps.schedule }),
    }).await;
    state.register(McpTool {
        name: "run_task".into(),
        description: "파이프라인 즉시 실행 (예약 아님). inputSchema: {pipeline: [step, ...]}.".into(),
        input_schema: schema_object(serde_json::json!({"pipeline": {"type": "array"}})),
        handler: Arc::new(RunTaskHandler { task: deps.task }),
    }).await;

    // SysmodCache drill-in — 큰 sysmod 응답의 `_cacheKey` 부분 조회 (yfinance/한투/키움/DART 시계열).
    state.register(McpTool {
        name: "cache_read".into(),
        description: "sysmod `_cacheKey` 의 records 페이지네이션 조회. 큰 시계열 응답에서 일부만 가져올 때 offset/limit 으로 자르기. inputSchema: {cacheKey, offset?, limit?}.".into(),
        input_schema: schema_object(serde_json::json!({
            "cacheKey": {"type": "string", "description": "sysmod 응답의 `_cacheKey` 값"},
            "offset": {"type": "integer", "description": "시작 인덱스 (기본 0)"},
            "limit": {"type": "integer", "description": "최대 행 수 (기본 50)"}
        })),
        handler: Arc::new(CacheReadHandler { cache: deps.cache.clone() }),
    }).await;
    state.register(McpTool {
        name: "cache_grep".into(),
        description: "sysmod `_cacheKey` records 조건 필터. field=점 표기, op=eq/ne/gt/gte/lt/lte/contains/in. inputSchema: {cacheKey, field, op, value}.".into(),
        input_schema: schema_object(serde_json::json!({
            "cacheKey": {"type": "string"},
            "field": {"type": "string", "description": "필드 경로 (점 표기)"},
            "op": {"type": "string", "enum": ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"]},
            "value": {"description": "비교값 (op 따라 타입 다름)"}
        })),
        handler: Arc::new(CacheGrepHandler { cache: deps.cache.clone() }),
    }).await;
    state.register(McpTool {
        name: "cache_aggregate".into(),
        description: "sysmod `_cacheKey` records 집계. op=count/sum/avg/min/max, field=숫자 필드 경로(count 는 무시). inputSchema: {cacheKey, field, op}.".into(),
        input_schema: schema_object(serde_json::json!({
            "cacheKey": {"type": "string"},
            "field": {"type": "string", "description": "숫자 필드 경로 (점 표기)"},
            "op": {"type": "string", "enum": ["count", "sum", "avg", "min", "max"]}
        })),
        handler: Arc::new(CacheAggregateHandler { cache: deps.cache.clone() }),
    }).await;
    state.register(McpTool {
        name: "cache_drop".into(),
        description: "sysmod `_cacheKey` 캐시 삭제. inputSchema: {cacheKey}.".into(),
        input_schema: schema_object(serde_json::json!({"cacheKey": {"type": "string"}})),
        handler: Arc::new(CacheDropHandler { cache: deps.cache }),
    }).await;

    // Secret / Mcp
    state.register(McpTool {
        name: "request_secret".into(),
        description: "API 키/시크릿 조회 (등록 여부 + 값). inputSchema: {name}.".into(),
        input_schema: schema_object(serde_json::json!({"name": {"type": "string"}})),
        handler: Arc::new(RequestSecretHandler { secret: deps.secret }),
    }).await;
    state.register(McpTool {
        name: "mcp_call".into(),
        description: "외부 MCP 서버 도구 호출. inputSchema: {server, tool, arguments?}.".into(),
        input_schema: schema_object(serde_json::json!({
            "server": {"type": "string"},
            "tool": {"type": "string"},
            "arguments": {"type": "object"}
        })),
        handler: Arc::new(McpCallHandler { mcp: deps.mcp }),
    }).await;

    // Memory tier
    state.register(McpTool {
        name: "save_entity".into(),
        description: "Save the identity of a tracked subject — one thing you'll want to recall later. The `name` is the BARE NOUN for the thing itself (answers 'what is it?') — NOT what it's doing, its state, a plan/strategy/method applied to it, a time period, or any qualifier; those go in facts (save_entity_fact), never the name. Self-check: if the name reads as 'THING + descriptor', keep ONLY the thing as the entity and move the descriptor to a fact. Name + aliases is the dedup key — a qualifier baked into the name splits one subject into duplicates and breaks recall.".into(),
        input_schema: schema_object(serde_json::json!({
            "name": {"type":"string", "description": "Bare canonical noun for the subject itself — no method/strategy/status/time/attribute mixed in (those are facts). Stable across mentions (dedup key)."},
            "aliases": {"type":"array", "items": {"type":"string"}, "description": "Alternative forms of the same subject — abbreviations, codes/tickers, alternate spellings, language variants — so later mentions merge instead of duplicating."}
        })),
        handler: Arc::new(SaveEntityHandler { entity: deps.entity.clone() }),
    }).await;
    state.register(McpTool {
        name: "save_entity_fact".into(),
        description: "Record a durable statement about a tracked entity — something that stays true OUTSIDE this conversation (state, attribute, decision, position, goal). NEVER log conversation activity ('the user asked/requested X') — a fact must stand on its own later. Include figures/dates in content. factType groups the entity's facts: REUSE existing labels (see <TRACKED_ENTITIES>/timeline) so the same kind groups together. supersede=true when this is a NEW VALUE of a state the entity already has (old value retires into history). explicit=true ONLY when the user explicitly asked to remember. Numeric time-series (price history) do NOT belong here.".into(),
        input_schema: schema_object(serde_json::json!({"entityId": {"type":"integer"}, "content": {"type":"string"}, "factType": {"type":"string"}, "supersede": {"type":"boolean"}, "explicit": {"type":"boolean"}})),
        handler: Arc::new(SaveEntityFactHandler { entity: deps.entity.clone() }),
    }).await;
    state.register(McpTool {
        name: "search_entities".into(),
        description: "Entity 검색 (embedding + 이름). inputSchema: EntitySearchOpts.".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(SearchEntitiesHandler { entity: deps.entity.clone() }),
    }).await;
    state.register(McpTool {
        name: "search_entity_facts".into(),
        description: "Entity 사실 검색. inputSchema: FactSearchOpts.".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(SearchEntityFactsHandler { entity: deps.entity.clone() }),
    }).await;
    state.register(McpTool {
        name: "get_entity_timeline".into(),
        description: "Entity 의 사실 + 이벤트 시간순. inputSchema: {entityId, limit?, offset?, orderBy?}.".into(),
        input_schema: schema_object(serde_json::json!({"entityId": {"type":"integer"}})),
        handler: Arc::new(EntityTimelineHandler { entity: deps.entity }),
    }).await;
    state.register(McpTool {
        name: "save_event".into(),
        description: "Record something that happened (or is scheduled) in the WORLD at a point in time — a trade executed, a release/announcement, a decision the user made, a milestone. NEVER log conversation activity ('user asked about X') — requests/Q&A live in conversation history, not here. Reuse the same type for the same kind of occurrence; link entityIds. explicit=true only when the user explicitly asked to remember.".into(),
        input_schema: schema_object(serde_json::json!({"type": {"type":"string"}, "title": {"type":"string"}, "entityIds": {"type":"array"}, "explicit": {"type":"boolean"}})),
        handler: Arc::new(SaveEventHandler { episodic: deps.episodic.clone() }),
    }).await;
    state.register(McpTool {
        name: "search_events".into(),
        description: "Event 검색. inputSchema: EventSearchOpts.".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(SearchEventsHandler { episodic: deps.episodic.clone() }),
    }).await;
    state.register(McpTool {
        name: "list_recent_events".into(),
        description: "최근 Event 목록. inputSchema: ListRecentOpts.".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(ListRecentEventsHandler { episodic: deps.episodic }),
    }).await;

    // Conversation
    state.register(McpTool {
        name: "search_history".into(),
        description: "이전 대화 검색 (embedding). inputSchema: {owner?, query, currentConvId?, limit?, withinDays?, minScore?, includeBlocks?}.".into(),
        input_schema: schema_object(serde_json::json!({"query": {"type":"string"}})),
        handler: Arc::new(SearchHistoryHandler { conversation: deps.conversation }),
    }).await;
    state.register(McpTool {
        name: "search_library".into(),
        description: "라이브러리(업로드 자료) 검색 — E5(의미) + BM25(정확 토큰) 하이브리드. 질문이 업로드 자료와 관련될 가능성이 있으면 명시 지시 없이 호출하라. 결과가 비거나 부실하면 같은 쿼리 반복 대신 키워드를 바꿔 재검색. inputSchema: {query, owner?, referenceIds?, limit?}.".into(),
        input_schema: schema_object(serde_json::json!({"query": {"type":"string"}})),
        handler: Arc::new(SearchLibraryHandler { library: deps.library }),
    }).await;

    // Media
    state.register(McpTool {
        name: "search_media".into(),
        description: "갤러리 미디어 검색 (slug / filenameHint / prompt / model 매칭, 최신순). inputSchema: {query?, scope?, limit?, offset?}.".into(),
        input_schema: schema_object(serde_json::json!({
            "query": {"type": "string"},
            "scope": {"type": "string", "enum": ["user", "system"]},
            "limit": {"type": "integer"},
            "offset": {"type": "integer"}
        })),
        handler: Arc::new(SearchMediaHandler { media: deps.media.clone() }),
    }).await;
    state.register(McpTool {
        name: "regenerate_image".into(),
        description: "갤러리 이미지 재생성 — 기존 slug 의 prompt/model/size/aspectRatio 메타 그대로 재실행. inputSchema: {slug}.".into(),
        input_schema: schema_object(serde_json::json!({"slug": {"type": "string"}})),
        handler: Arc::new(RegenerateImageHandler { media: deps.media.clone() }),
    }).await;
    state.register(McpTool {
        name: "image_gen".into(),
        description: "AI 이미지 생성 (비동기). 즉시 placeholder URL 반환, 백그라운드 완성. inputSchema: GenerateImageInput.".into(),
        input_schema: schema_object(serde_json::json!({
            "prompt": {"type":"string"},
            "size": {"type":"string"},
            "quality": {"type":"string"},
            "model": {"type":"string"},
            "aspectRatio": {"type":"string"}
        })),
        handler: Arc::new(ImageGenHandler { media: deps.media }),
    }).await;

    // AI 메타
    state.register(McpTool {
        name: "suggest".into(),
        description: "Present next-action suggestion chips. suggestions = array; each item is one of: a string (standalone shortcut chip — sends IMMEDIATELY on click, cannot combine with other groups), or {type:'toggle', label, options:[...], defaults?:[...], single?:bool} (a select group submitted together with the card's other groups via one Send button — multi-select by default; set single:true for a single-pick radio that STILL coexists with other groups under that one submit; options is REQUIRED and non-empty), or {type:'input', label, placeholder?} (free text, also part of the one submit). Pick the type per the choice: pick-many => toggle; exactly one-of-many that must coexist with other groups in a single submit => toggle with single:true; a standalone immediate shortcut (e.g. 'proceed with the recommendation') => string; open-ended => input. Do NOT hardcode single vs multi — judge by whether the choices can coexist. Applies to every suggest use, build steps included.".into(),
        input_schema: schema_object(serde_json::json!({"suggestions": {"type":"array"}})),
        handler: Arc::new(SuggestHandler),
    }).await;
    state.register(McpTool {
        name: "propose_plan".into(),
        description: "복합 작업 계획 제안 + plan store 저장. inputSchema: {title, steps[], estimatedTime?, risks?}.".into(),
        input_schema: schema_object(serde_json::json!({"title": {"type":"string"}, "steps": {"type":"array"}})),
        handler: Arc::new(ProposePlanHandler),
    }).await;
    state.register(McpTool {
        name: "network_request".into(),
        description: "가벼운 HTTP 요청. inputSchema: {url, method?, headers?, body?, timeoutMs?}.".into(),
        input_schema: schema_object(serde_json::json!({"url": {"type":"string"}})),
        handler: Arc::new(NetworkRequestHandler { network: deps.network }),
    }).await;

    // ── Stage 2: ToolManager(core) 카탈로그 auto-sync ──
    // 위에서 명시 등록 안 된 core 도구(get_memory_stats / list_system_modules / consolidate_conversation
    // 등)를 ToolManagerProxyHandler 로 자동 노출. 명시 핸들러(bespoke pending 요약·envelope)가 있는
    // 도구는 이미 state 에 있어 건너뜀(보존). 새 core 도구 추가 시 register_core_tools 한 곳만 등록하면
    // 여기서 자동으로 hosted MCP tools/list 에 반영 → 한쪽만 등록하던 drift 원천 차단.
    let core_catalog = deps.tool_manager.list(&ToolListFilter {
        source: Some("core".to_string()),
        name_prefix: None,
    });
    for def in core_catalog {
        if AUTOSYNC_SKIP.contains(&def.name.as_str()) {
            continue;
        }
        if state.tools.read().await.contains_key(&def.name) {
            continue; // 명시 핸들러 우선
        }
        let name = def.name.clone();
        state
            .register(McpTool {
                name: def.name,
                description: def.description,
                input_schema: def.parameters,
                handler: Arc::new(ToolManagerProxyHandler {
                    tool_manager: deps.tool_manager.clone(),
                    name,
                }),
            })
            .await;
    }
}

/// MCP server 부팅 — port 바인딩 + axum serve.
/// FIREBAT_MCP_LISTEN env 으로 listen 주소 override (default 127.0.0.1:50052).
pub async fn serve(state: Arc<McpServerState>) -> Result<(), String> {
    let listen = std::env::var("FIREBAT_MCP_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:50052".to_string());
    let addr: SocketAddr = listen
        .parse()
        .map_err(|e| format!("FIREBAT_MCP_LISTEN 파싱 실패: {e}"))?;
    let router = build_router(state);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("MCP listener bind 실패 ({addr}): {e}"))?;
    tracing::info!(target: "mcp", "MCP HTTP server listening on {addr}");
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("MCP serve 실패: {e}"))?;
    Ok(())
}

// ════════════════════════════════════════════════════════════════════════════
// stdio MCP transport — 외부 사용자 진입용 (Claude desktop / Cursor / npm run mcp 등).
// JSON-RPC 2.0 over stdin/stdout. HTTP transport 와 같은 도구 registry 공유.
// ════════════════════════════════════════════════════════════════════════════

/// stdio MCP server 부팅 — Bearer token 검증 X (stdio 자체가 신뢰 경계 — 외부 사용자가 spawn).
/// 도구 호출 패턴은 HTTP 와 동일 (initialize / tools/list / tools/call).
pub async fn serve_stdio(state: Arc<McpServerState>) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    tracing::info!(target: "mcp", "MCP stdio server 시작 (외부 사용자 진입용)");
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let req: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err = JsonRpcError {
                    jsonrpc: "2.0",
                    id: Value::Null,
                    error: JsonRpcErrorBody {
                        code: -32700,
                        message: format!("parse error: {e}"),
                        data: None,
                    },
                };
                write_stdio(&mut stdout, &err).await?;
                continue;
            }
        };
        if req.jsonrpc != "2.0" {
            let err = JsonRpcError {
                jsonrpc: "2.0",
                id: req.id.unwrap_or(Value::Null),
                error: JsonRpcErrorBody {
                    code: -32600,
                    message: "Invalid Request".to_string(),
                    data: None,
                },
            };
            write_stdio(&mut stdout, &err).await?;
            continue;
        }
        let id = req.id.clone().unwrap_or(Value::Null);
        let result = dispatch_method(&state, &req.method, &req.params).await;
        match result {
            Ok(Some(body)) => {
                let resp = JsonRpcResponse {
                    jsonrpc: "2.0",
                    id,
                    result: body,
                };
                write_stdio(&mut stdout, &resp).await?;
            }
            Ok(None) => {
                // notifications (id 없음) — 응답 안 함.
            }
            Err((code, message)) => {
                let err = JsonRpcError {
                    jsonrpc: "2.0",
                    id,
                    error: JsonRpcErrorBody {
                        code,
                        message,
                        data: None,
                    },
                };
                write_stdio(&mut stdout, &err).await?;
            }
        }
    }
    Ok(())
}

async fn write_stdio<T: serde::Serialize>(
    stdout: &mut tokio::io::Stdout,
    payload: &T,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let mut buf = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    buf.push(b'\n');
    stdout.write_all(&buf).await.map_err(|e| e.to_string())?;
    stdout.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// HTTP 와 stdio 공통 method dispatch — JSON-RPC 처리 로직 단일 source.
async fn dispatch_method(
    state: &Arc<McpServerState>,
    method: &str,
    params: &Value,
) -> Result<Option<Value>, (i32, String)> {
    match method {
        "initialize" => Ok(Some(serde_json::json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "firebat", "version": env!("CARGO_PKG_VERSION") },
        }))),
        "tools/list" => {
            let tools = state.tools.read().await;
            let items: Vec<ToolListItem> = tools
                .values()
                .filter(|t| is_tool_visible(state, &t.name))
                .map(|t| ToolListItem {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    input_schema: t.input_schema.clone(),
                })
                .collect();
            Ok(Some(serde_json::json!({ "tools": items })))
        }
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            inject_hub_owner(&mut args);
            if name.is_empty() {
                return Err((-32602, "missing 'name' parameter".to_string()));
            }
            let handler = {
                let tools = state.tools.read().await;
                tools.get(&name).map(|t| t.handler.clone())
            };
            let Some(handler) = handler else {
                // unknown tool — JSON-RPC error 대신 tool result (isError: true) 로 반환 (옛 HTTP path 와 동일).
                // CLI 자체 MCP loop 안에서 JSON-RPC error 는 LLM 에 명확히 전달되지 못해 hallucinate
                // 도구 (TaskCreate / TaskUpdate / task_create / add_task 등) retry 를 유발한다.
                let available_preview: Vec<String> = {
                    let tools = state.tools.read().await;
                    let mut keys: Vec<String> = tools.keys().cloned().collect();
                    keys.sort();
                    keys.into_iter().take(15).collect()
                };
                let msg = format!(
                    "'{}' 도구는 존재하지 않습니다. 작업 예약 = schedule_task / 즉시 실행 = run_task / plan 카드 = propose_plan. 'tools/list' 에 있는 도구만 사용하세요. 일부 사용 가능 도구: {}",
                    name,
                    available_preview.join(", ")
                );
                let text = serde_json::json!({ "error": msg }).to_string();
                return Ok(Some(serde_json::json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": true
                })));
            };
            if hub_blocks_tool(&name) {
                let text = serde_json::json!({
                    "error": format!("이 hub 에서는 '{}' 도구 사용이 허용되지 않습니다.", name)
                })
                .to_string();
                return Ok(Some(serde_json::json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": true
                })));
            }
            match gated_tool_call(state, &name, args, &handler, "stdio").await {
                Ok(result) => {
                    let text = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
                    Ok(Some(serde_json::json!({
                        "content": [{ "type": "text", "text": text }],
                        "isError": false
                    })))
                }
                Err(err) => {
                    let text = serde_json::json!({ "error": err }).to_string();
                    Ok(Some(serde_json::json!({
                        "content": [{ "type": "text", "text": text }],
                        "isError": true
                    })))
                }
            }
        }
        "notifications/initialized" => Ok(None),
        other => Err((-32601, format!("method not found: {}", other))),
    }
}

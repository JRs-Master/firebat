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

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

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
use firebat_core::managers::mcp::McpManager;
use firebat_core::managers::media::{MediaManager};
use firebat_core::managers::module::ModuleManager;
use firebat_core::managers::page::PageManager;
use firebat_core::managers::schedule::ScheduleManager;
use firebat_core::managers::secret::SecretManager;
use firebat_core::managers::storage::StorageManager;
use firebat_core::managers::task::{PipelineStep, TaskManager};
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
}

impl McpServerState {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            vault,
            auth: None,
            module_manager: None,
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
    // 도메인 분리 도구 (sysmod_<name>_<domain>) — 첫 segment 가 module name. config 안 `-` 가 있으면 `_` 로 등록됨.
    // 매칭 시 두 변형 모두 시도 — module 이름이 정확히 hit 할 때까지.
    let candidate = rest.split('_').next().unwrap_or(rest);
    let with_dash = candidate.replace('_', "-");
    if mm.is_enabled(candidate) || mm.is_enabled(&with_dash) {
        return true;
    }
    // 두 candidate 모두 disabled — 단 module 자체 존재 0 시 (builtin 등 sysmod_ 접두인데 module 아닌 도구)
    // false negative 방지: 어떤 이름이라도 module 미존재 면 default true 처리 어렵. 보수적으로 disabled 처리.
    false
}

/// Bearer token 검증 — 두 source 받음 (옛 frontend mcp-internal + mcp-app 통합):
///   1. Vault `system:internal-mcp-token` (옛 internal MCP 토큰 — Frontend / CLI 어댑터)
///   2. AuthManager.validate_api_token (옛 외부 MCP 토큰 — Claude desktop / Cursor 등)
fn verify_token(state: &Arc<McpServerState>, headers: &HeaderMap) -> Result<(), StatusCode> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").unwrap_or("");
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
            return Ok(());
        }
    }
    // 2. 외부 사용자 API token 매칭 (AuthManager.validate_api_token).
    if let Some(auth_mgr) = &state.auth {
        if auth_mgr.validate_api_token(token).is_some() {
            return Ok(());
        }
    }
    Err(StatusCode::UNAUTHORIZED)
}

async fn handle_rpc(
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    if let Err(status) = verify_token(&state, &headers) {
        return (status, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }
    if req.jsonrpc != "2.0" {
        return rpc_error(req.id.unwrap_or(Value::Null), -32600, "Invalid Request");
    }

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
            let args = req
                .params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            if name.is_empty() {
                return rpc_error(id, -32602, "missing 'name' parameter");
            }
            let tool = {
                let tools = state.tools.read().await;
                tools.get(&name).map(|t| t.handler.clone())
            };
            let Some(handler) = tool else {
                return rpc_error(id, -32601, &format!("tool not found: {}", name));
            };
            match handler.call(args).await {
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

async fn handle_sse(
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(status) = verify_token(&state, &headers) {
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
        // Hub visitor 가드 — hub_context 활성 상태에서 allowed_sysmods 에 박지 않은 sysmod 호출 차단.
        // ai.rs:669-694 의 hub filter 는 tools.is_empty() 분기 (API 모델) 만 박혀있어 CLI 모델
        // (supports_mcp=true) 의 자체 MCP loop 영역에서는 우회 박힘. 본 가드 = MCP path 보안 영역.
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
        // 진단 log — args 영역 실제 형태 확인 (Issue 3 root cause 진단용).
        // CLI 자체 MCP loop / API 모델 / etc 각 path 가 args 박는 형태 다를 가능성 추적.
        // root cause 확정 박은 후 본 log 영역 제거.
        let args_preview: String = serde_json::to_string(&args)
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect();
        let args_type = if args.is_array() { "array" }
            else if args.is_string() { "string" }
            else if args.is_object() { "object" }
            else if args.is_null() { "null" }
            else { "other" };
        tracing::info!(
            target: "render",
            "[Render] args type={} preview={}",
            args_type,
            args_preview
        );
        // args 형태 robustness — 일부 CLI 어댑터 / 모델이 args 를 stringified JSON 으로 보내거나
        // blocks 배열 자체를 직접 보내는 경우 수용. 옛 = args.get("blocks") 단일 경로라
        // 'blocks (array) 가 필요합니다' 거짓 거부 (AI 가 정상 {blocks:[...]} 보냈을 때도).
        let parsed_args: Value = match args.as_str() {
            Some(s) => serde_json::from_str(s).unwrap_or(args.clone()),
            None => args.clone(),
        };
        // blocks 값도 stringified 일 수 있음 (blocks: "[...]") → parse.
        let blocks_val = parsed_args.get("blocks").cloned();
        let blocks_owned: Vec<Value> = if let Some(bv) = blocks_val {
            match bv {
                Value::Array(a) => a,
                Value::String(s) => serde_json::from_str::<Vec<Value>>(&s)
                    .map_err(|_| "render: 'blocks' 가 array 가 아닙니다".to_string())?,
                _ => return Err("render: 'blocks' (array) 가 필요합니다".to_string()),
            }
        } else if let Value::Array(a) = &parsed_args {
            // args 자체가 blocks 배열인 경우
            a.clone()
        } else {
            return Err("render: 'blocks' (array) 가 필요합니다".to_string());
        };
        let blocks = &blocks_owned;
        if blocks.is_empty() {
            return Err("render: 'blocks' 가 비어있습니다 (최소 1개 필요)".to_string());
        }

        // block 별 graceful 처리 — 정상 block 은 rendered 에 push, 실패 block 은 failed 에 분리 push.
        // 옛 흐름은 첫 fail 만나면 즉시 Err return → 통째 도구 호출 실패 → 사용자 화면 0 block.
        // 정공 = 1개 block hallucinate (예: marker 안 lon 누락) 이 있어도 나머지 정상 block 은 화면 표시 +
        // 실패한 block 만 사용자 / AI 한테 에러 안내. AI 는 응답 안 `failed` 배열 보고 retry 결정 자율.
        let mut rendered = Vec::with_capacity(blocks.len());
        let mut failed: Vec<Value> = Vec::new();
        for (idx, block) in blocks.iter().enumerate() {
            let block_type = match block.get("type").and_then(|v| v.as_str()) {
                Some(t) => t,
                None => {
                    failed.push(serde_json::json!({
                        "idx": idx,
                        "type": Value::Null,
                        "error": format!("blocks[{idx}]: 'type' (string) 가 필요합니다"),
                    }));
                    continue;
                }
            };
            let mut props = block
                .get("props")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));

            // 정규화(synonym 매핑 / extras drop) 전 Claude 가 실제 보낸 키 — 검증 실패 진단용.
            // 핵심 prop(text/children/headers 등) 누락 시, Claude 가 다른 키(label/items/columns)로
            // 보냈는지(→ synonym 매핑 필요) 통째 누락인지 구분하려면 원본 키가 필요하다.
            let original_keys: Vec<String> = props
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();

            let comp = match firebat_core::managers::ai::component_registry::find_component(block_type) {
                Some(c) => c,
                None => {
                    failed.push(serde_json::json!({
                        "idx": idx,
                        "type": block_type,
                        "error": format!("알 수 없는 컴포넌트 '{}'. components.json 의 26 종 중 하나여야", block_type),
                    }));
                    continue;
                }
            };

            // AI hallucination normalize — AI 가 schema 잘못 학습해서 'name' / 'currency' 등 보내는
            // 경우 자주 발생. additionalProperties false + required title 명시 + description 강화로도
            // 해결 안 됨 (commit `2cedd5b` 이후 또 발생). 검증 전 흡수.
            //   1. 'name' 이 있고 'title' 이 없으면 → 'title' 매핑 (의미상 동일, stock_chart 같은
            //      component 안 옛에 'name' 쓰던 적 있어 AI 가 학습한 잔재). sanitize 전에 처리.
            //   2. sanitize_to_schema 가 나머지 정규화를 재귀적으로 수행 — additionalProperties:false
            //      미지 키 drop / 중첩 객체·배열의 optional enum·type 위반 drop / 누락 required 의
            //      default·null 채움. top-level 만 처리하던 옛 인라인 로직의 중첩 누락을 일반화.
            if let Some(obj) = props.as_object_mut() {
                if !obj.contains_key("title") {
                    if let Some(name_val) = obj.remove("name") {
                        obj.insert("title".to_string(), name_val);
                    }
                }
            }
            firebat_core::managers::ai::component_registry::sanitize_to_schema(
                &mut props,
                &comp.props_schema,
            );

            // propsSchema 검증 — 실패 block 만 분리, 정상 block 은 계속 push.
            if let Err(e) =
                firebat_core::managers::module::validate_value(&props, &comp.props_schema)
            {
                failed.push(serde_json::json!({
                    "idx": idx,
                    "type": block_type,
                    "error": format!("props 검증 실패: {}", e),
                    "gotKeys": original_keys,
                }));
                continue;
            }

            rendered.push(serde_json::json!({
                "type": "component",
                "name": comp.component_type,
                "props": props,
            }));
        }

        // 모두 실패 — 옛 흐름 호환 위해 Err return (AI retry 유도).
        if rendered.is_empty() && !failed.is_empty() {
            let summary = failed
                .iter()
                .filter_map(|f| f.get("error").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(format!(
                "render: 모든 block 검증 실패 ({}). schema 맞춰 다시 호출하라.",
                summary
            ));
        }

        // 부분 성공 시 진단 — 검증 실패 block 이 silent skip 되어 사용자 화면 안 header 만 박히고
        // 본문 빠짐 root cause 추적. journalctl 안 어떤 block 이 왜 실패했는지 확정.
        if !failed.is_empty() {
            tracing::warn!(
                target: "render",
                rendered_count = rendered.len(),
                failed_count = failed.len(),
                failed = %serde_json::to_string(&failed).unwrap_or_default(),
                "[render] 일부 block 검증 실패 — silent skip (사용자 화면 미표시)"
            );
        }

        // 부분 성공 / 전체 성공 — success: true 설정 + failed 배열은 사용자 / AI 안내용.
        Ok(serde_json::json!({
            "success": true,
            "blocks": rendered,
            "failed": failed,
        }))
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
    async fn call(&self, _args: Value) -> Result<Value, String> {
        let items = self.page.list();
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
        match self.page.get(&slug) {
            Some(rec) => Ok(serde_json::json!({"success": true, "data": rec})),
            None => Ok(serde_json::json!({"success": false, "error": "page not found"})),
        }
    }
}

/// admin context 면 pending 박은 결과 반환 (Some). cron context 면 None — caller 가 기존 동작 진행.
///
/// 옛 TS commit 262bc78 의 `globalThis.__firebatCronAgentJobId` 분기 Rust port. CLI 모델의 자체
/// MCP loop 가 destructive 도구 (save_page / delete_* / schedule_task / cancel_task) 호출 시
/// 본 helper 통과 — admin chat 호출이면 pending action 생성 → 사용자 ✓ 박혀야 실행. cron 자동
/// 실행 영역 (CronContextGuard 활성) 이면 우회 후 직접 실행.
fn pending_or_passthrough(
    args: &Value,
    tool_name: &str,
    summary_fn: impl FnOnce(&Value) -> String,
) -> Option<Value> {
    // Hub visitor 영역 = destructive 도구 사용 차단 (ai.rs:686-687 admin path 와 일관 X).
    // hub visitor 가 admin DB 영구 손실 (페이지 덮어쓰기 / 파일 삭제 / 등) 박는 영역 차단.
    if firebat_core::utils::hub_context::is_hub_context_active() {
        return Some(serde_json::json!({
            "success": false,
            "error": format!(
                "이 hub 에서는 destructive 도구 '{}' 사용이 허용되지 않습니다.",
                tool_name
            ),
        }));
    }
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
    let plan_id = firebat_core::utils::pending_tools::create_pending(pending_args, &summary);
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
        // admin context → pending 박음 (사용자 승인 카드). cron context → 직접 실행.
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
        match self.page.delete(&slug) {
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

pub struct CancelTaskHandler {
    pub schedule: Arc<ScheduleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for CancelTaskHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        if let Some(r) = pending_or_passthrough(&args, "cancel_task", |s| {
            format!("예약 해제: {}", obj_str(s, "jobId").unwrap_or_default())
        }) {
            return Ok(r);
        }
        let job_id = obj_str(&args, "jobId").ok_or_else(|| "jobId 필수".to_string())?;
        match self.schedule.cancel(&job_id).await {
            Ok(true) => Ok(serde_json::json!({"success": true})),
            Ok(false) => Ok(serde_json::json!({"success": false, "error": format!("cron 잡 {} 미등록", job_id)})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
        }
    }
}

pub struct ListTasksHandler {
    pub schedule: Arc<ScheduleManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for ListTasksHandler {
    async fn call(&self, _args: Value) -> Result<Value, String> {
        let jobs = self.schedule.list();
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
        match self.schedule.trigger_now(&job_id).await {
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

// ── SecretService / McpService 도구 ───────────────────────────────────────

pub struct RequestSecretHandler {
    pub secret: Arc<SecretManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for RequestSecretHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let name = obj_str(&args, "name").ok_or_else(|| "name 필수".to_string())?;
        let value = self.secret.get_user(&name).unwrap_or_default();
        let present = !value.is_empty();
        Ok(serde_json::json!({"success": true, "name": name, "present": present, "value": value}))
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

// ── EntityService / EpisodicService 도구 (메모리 4-tier) ──────────────────

pub struct SaveEntityHandler {
    pub entity: Arc<EntityManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SaveEntityHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let input = SaveEntityInput {
            name: obj_str(&args, "name").ok_or_else(|| "name 필수".to_string())?,
            entity_type: obj_str(&args, "type")
                .or_else(|| obj_str(&args, "entityType"))
                .ok_or_else(|| "type 필수".to_string())?,
            aliases: args
                .get("aliases")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
            metadata: args.get("metadata").cloned(),
            source_conv_id: obj_str(&args, "sourceConvId"),
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
        // propose_plan — plan store 저장 후 PlanCard component + plan-confirm/revise suggestions 응답.
        // 옛 TS mcp/internal-server.ts 1:1 — AiManager result_processor 가 component='PlanCard' →
        // blocks 안 PlanCard 자동 변환 + suggestions 영역 frontend 가 ✓실행 / ⚙수정 버튼 UI.
        let plan_id = format!("plan_{}", uuid::Uuid::new_v4().simple());
        let title = obj_str(&args, "title").unwrap_or_default();
        let steps: Vec<firebat_core::utils::plan_store::PlanStep> = args
            .get("steps")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        let estimated_time = obj_str(&args, "estimatedTime");
        let risks: Option<Vec<String>> = args
            .get("risks")
            .and_then(|v| serde_json::from_value(v.clone()).ok());
        firebat_core::utils::plan_store::store_plan(firebat_core::utils::plan_store::PlanInsert {
            plan_id: plan_id.clone(),
            title: title.clone(),
            steps: steps.clone(),
            estimated_time: estimated_time.clone(),
            risks: risks.clone(),
        });
        // steps / risks 영역 serde_json::Value 변환 — frontend 안 그대로 props 사용.
        let steps_json = serde_json::to_value(&steps).unwrap_or(serde_json::Value::Array(vec![]));
        let risks_json = risks
            .as_ref()
            .map(|r| serde_json::to_value(r).unwrap_or(serde_json::Value::Array(vec![])))
            .unwrap_or(serde_json::Value::Null);
        let est_time_json = estimated_time
            .as_ref()
            .map(|s| serde_json::Value::String(s.clone()))
            .unwrap_or(serde_json::Value::Null);
        Ok(serde_json::json!({
            "success": true,
            "planId": plan_id,
            "component": "PlanCard",
            "props": {
                "planId": plan_id,
                "title": title,
                "steps": steps_json,
                "estimatedTime": est_time_json,
                "risks": risks_json,
            },
            // ✓실행 = plan-confirm → AiManager 가 plan_execute_id 받아 다음 turn prompt 안 강제 주입.
            // ⚙수정 = plan-revise → 사용자 입력 받은 후 AI 가 plan 재작성.
            "suggestions": [
                { "type": "plan-confirm", "planId": plan_id, "label": "✓ 실행" },
                { "type": "plan-revise", "planId": plan_id, "label": "⚙ 수정 제안", "placeholder": "예: 1단계 빼고, 차트도 추가해줘" },
                "✕ 취소"
            ]
        }))
    }
}

pub struct NetworkRequestHandler {
    pub network: Arc<dyn firebat_core::ports::INetworkPort>,
}
#[async_trait::async_trait]
impl McpToolHandler for NetworkRequestHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
        let url = obj_str(&args, "url").ok_or_else(|| "url 필수".to_string())?;
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
    pub network: Arc<dyn firebat_core::ports::INetworkPort>,
}

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

    // Schedule / Task — trigger 시각은 cronTime/runAt/delaySec 중 직접 하나만 박음.
    // 옛에 mode field 박혀있어 AI 가 `mode: "runAt"` 박고 실제 runAt 누락 → validator reject 반복.
    // core/src/tool_registry.rs 의 schedule_task schema 와 일관성 박힘.
    state.register(McpTool {
        name: "schedule_task".into(),
        description: "크론 / 일회성 작업 예약. trigger 시각은 cronTime(반복: '0 8 * * *' 형태) / runAt(1회 ISO 8601 + timezone offset, 예: '2026-05-25T14:35:00+09:00') / delaySec(N초 후) 중 정확히 하나의 field 를 직접 박는다. 'mode' 같은 별도 field 박지 마라 — schema 에 없다.".into(),
        input_schema: schema_object(serde_json::json!({
            "jobId": {"type": "string", "description": "고유 job id (이미 박힌 jobId 면 덮어쓰기)"},
            "targetPath": {"type": "string", "description": "agent | <pipeline 식별자>"},
            "cronTime": {"type": "string", "description": "반복 cron 표현식 (분 시 일 월 요일). 없으면 runAt/delaySec 중 하나 박음"},
            "runAt": {"type": "string", "description": "1회 실행 ISO 8601 (반드시 timezone offset 포함, 예: +09:00)"},
            "delaySec": {"type": "integer", "description": "N 초 후 1회 실행"},
            "title": {"type": "string"},
            "agentPrompt": {"type": "string", "description": "executionMode=agent 일 때 AI 가 받는 자연어 지시문"},
            "executionMode": {"type": "string", "enum": ["pipeline", "agent"], "description": "pipeline(기본 — step 배열 결정적 실행) 또는 agent(매 trigger 마다 LLM Function Calling)"}
        })),
        handler: Arc::new(ScheduleTaskHandler { schedule: deps.schedule.clone() }),
    }).await;
    state.register(McpTool {
        name: "cancel_task".into(),
        description: "예약 작업 취소. inputSchema: {jobId}.".into(),
        input_schema: schema_object(serde_json::json!({"jobId": {"type": "string"}})),
        handler: Arc::new(CancelTaskHandler { schedule: deps.schedule.clone() }),
    }).await;
    state.register(McpTool {
        name: "list_tasks".into(),
        description: "예약 작업 목록.".into(),
        input_schema: schema_object(serde_json::json!({})),
        handler: Arc::new(ListTasksHandler { schedule: deps.schedule.clone() }),
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
        description: "Entity 저장 (추적 대상). inputSchema: {name, type, aliases?, metadata?, sourceConvId?}.".into(),
        input_schema: schema_object(serde_json::json!({"name": {"type":"string"}, "type": {"type":"string"}})),
        handler: Arc::new(SaveEntityHandler { entity: deps.entity.clone() }),
    }).await;
    state.register(McpTool {
        name: "save_entity_fact".into(),
        description: "Entity 사실 추가. inputSchema: {entityId, content, factType?, occurredAt?, tags?, ttlDays?}.".into(),
        input_schema: schema_object(serde_json::json!({"entityId": {"type":"integer"}, "content": {"type":"string"}})),
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
        description: "Event 저장 (Episodic memory). inputSchema: {type, title, description?, who?, context?, entityIds?, ttlDays?}.".into(),
        input_schema: schema_object(serde_json::json!({"type": {"type":"string"}, "title": {"type":"string"}})),
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

    // Media
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
        description: "사용자에게 자동 답변 칩 제시. inputSchema: {suggestions: [string | {type, label, ...}]}.".into(),
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
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            if name.is_empty() {
                return Err((-32602, "missing 'name' parameter".to_string()));
            }
            let handler = {
                let tools = state.tools.read().await;
                tools.get(&name).map(|t| t.handler.clone())
            };
            let Some(handler) = handler else {
                return Err((-32601, format!("tool not found: {}", name)));
            };
            match handler.call(args).await {
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

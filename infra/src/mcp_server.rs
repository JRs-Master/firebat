//! Firebat 자체 MCP HTTP server (Phase E, 2026-05-12).
//!
//! 옛 `mcp/internal-server.ts` (Node @modelcontextprotocol/sdk) → Rust axum endpoint 으로 이관.
//! Claude CLI / Codex / Gemini CLI 의 `--mcp-config http://127.0.0.1:<port>/mcp` 가 직접 연결.
//!
//! 프로토콜: JSON-RPC 2.0 over HTTP (MCP "streamable HTTP transport" 표준).
//!  - POST /mcp — JSON-RPC 메시지 수신 + 응답
//!  - GET /mcp — Server-Sent Events (선택적 streaming, 추후 박음)
//!
//! 인증: Bearer token (Vault `system:internal-mcp-token`) — Authorization 헤더 검증.
//!
//! 도구 registry: McpToolRegistry trait 으로 추상화. 호출자가 핸들러 + schema 등록.
//! 초기 박은 핸들러는 ToolManager 의 list/execute 위임 — 추후 sysmod / render_* / pending 등록 확장.

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
}

impl McpServerState {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            vault,
            auth: None,
        }
    }

    /// 외부 사용자 API token 검증 활성 — AuthManager 설정.
    pub fn with_auth(mut self, auth: Arc<AuthManager>) -> Self {
        self.auth = Some(auth);
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
    // SSE streaming — 추후 박음 (listChanged 알림 등).
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
                    Ok(serde_json::json!({
                        "success": false,
                        "error": output.error.unwrap_or_else(|| "module failed".to_string()),
                    }))
                }
            }
            Err(e) => Err(e),
        }
    }
}

/// system/modules 의 config.json 스캔 → sysmod_<name> 도구 자동 등록.
/// 옛 TS mcp/internal-server.ts:589-668 의 동적 노출 1:1.
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
        // sysmod_<name> — '-' → '_' 정규화 (옛 TS 1:1).
        let tool_name = format!("sysmod_{}", entry.name.replace('-', "_"));
        let description = build_sysmod_description(&entry.name, &config);
        // inputSchema — config.input.properties 그대로 JSON Schema 으로 전달.
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
        let blocks = args
            .get("blocks")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "render: 'blocks' (array) 가 필요합니다".to_string())?;
        if blocks.is_empty() {
            return Err("render: 'blocks' 가 비어있습니다 (최소 1개 필요)".to_string());
        }

        let mut rendered = Vec::with_capacity(blocks.len());
        for (idx, block) in blocks.iter().enumerate() {
            let block_type = block
                .get("type")
                .and_then(|v| v.as_str())
                .ok_or_else(|| format!("blocks[{idx}]: 'type' (string) 가 필요합니다"))?;
            let props = block
                .get("props")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));

            let comp = firebat_core::managers::ai::component_registry::find_component(block_type)
                .ok_or_else(|| {
                    format!(
                        "blocks[{idx}]: 알 수 없는 컴포넌트 '{}'. components.json 의 26 종 중 하나여야",
                        block_type
                    )
                })?;

            // propsSchema 검증 — 실패 시 LLM 이 schema 맞춰 retry.
            firebat_core::managers::module::validate_value(&props, &comp.props_schema).map_err(
                |e| format!("blocks[{idx}] ({}) props 검증 실패: {}", block_type, e),
            )?;

            rendered.push(serde_json::json!({
                "type": "component",
                "name": comp.component_type,
                "props": props,
            }));
        }

        Ok(serde_json::json!({
            "success": true,
            "blocks": rendered,
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
    let secrets = config
        .get("secrets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            let names: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            if names.is_empty() {
                String::new()
            } else {
                format!("\n필요 시크릿: {} (미설정 시 request_secret 호출)", names.join(", "))
            }
        })
        .unwrap_or_default();
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

pub struct SavePageHandler {
    pub page: Arc<PageManager>,
}
#[async_trait::async_trait]
impl McpToolHandler for SavePageHandler {
    async fn call(&self, args: Value) -> Result<Value, String> {
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
        let job_id = obj_str(&args, "jobId").ok_or_else(|| "jobId 필수".to_string())?;
        match self.schedule.cancel(&job_id).await {
            Ok(()) => Ok(serde_json::json!({"success": true})),
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
        // propose_plan — plan store 박은 후 planId 반환. 옛 TS lib/plan-store.ts 1:1.
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
            title,
            steps,
            estimated_time,
            risks,
        });
        Ok(serde_json::json!({"success": true, "planId": plan_id}))
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
        let req = firebat_core::ports::NetworkRequest {
            url,
            method,
            headers,
            body,
            timeout_ms,
        };
        match self.network.fetch(req).await {
            Ok(resp) => Ok(serde_json::json!({"success": true, "data": resp})),
            Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
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

    // Schedule / Task
    state.register(McpTool {
        name: "schedule_task".into(),
        description: "크론 / 일회성 작업 예약. inputSchema: {jobId?, targetPath, mode, cronTime?, runAt?, ...}.".into(),
        input_schema: schema_object(serde_json::json!({
            "jobId": {"type": "string"},
            "targetPath": {"type": "string"},
            "mode": {"type": "string"}
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
    tracing::info!("MCP HTTP server listening on {addr}");
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
    tracing::info!("MCP stdio server 시작 (외부 사용자 진입용)");
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

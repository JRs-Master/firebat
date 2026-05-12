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

use firebat_core::ports::IVaultPort;

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

/// MCP server state — 도구 registry + Vault (토큰 검증).
pub struct McpServerState {
    pub tools: RwLock<HashMap<String, McpTool>>,
    pub vault: Arc<dyn IVaultPort>,
}

impl McpServerState {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            tools: RwLock::new(HashMap::new()),
            vault,
        }
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

/// Bearer token 검증 — Vault `system:internal-mcp-token` 와 비교.
fn verify_token(headers: &HeaderMap, vault: &Arc<dyn IVaultPort>) -> Result<(), StatusCode> {
    let stored = vault
        .get_secret("system:internal-mcp-token")
        .unwrap_or_default();
    if stored.is_empty() {
        // 토큰 미설정 — 모든 호출 거부 (silent stdio fallback 차단)
        return Err(StatusCode::UNAUTHORIZED);
    }
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let expected = format!("Bearer {}", stored);
    let eq: bool = subtle::ConstantTimeEq::ct_eq(auth.as_bytes(), expected.as_bytes()).into();
    if !eq {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(())
}

async fn handle_rpc(
    State(state): State<Arc<McpServerState>>,
    headers: HeaderMap,
    Json(req): Json<JsonRpcRequest>,
) -> impl IntoResponse {
    if let Err(status) = verify_token(&headers, &state.vault) {
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
    if let Err(status) = verify_token(&headers, &state.vault) {
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

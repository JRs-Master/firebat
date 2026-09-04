//! McpClientFileAdapter — IMcpClientPort 풀 구현 (2026-05-07).
//!
//! 두 transport 지원 (옛 TS `infra/mcp-client/index.ts` 동등):
//!  - **stdio** — 자식 process spawn + stdin/stdout JSON-RPC 2.0 line frames.
//!    Claude Code / Cursor / 로컬 MCP 도구 (`@modelcontextprotocol/server-*` 등) 호환.
//!  - **HTTP+SSE** (`sse`) — `endpoint` event 로 POST URL 받고 `message` event 로 response 받음.
//!    MCP `2024-11-05` 의 전송이고 스펙에서 폐기됐다. 이미 이 설정으로 등록된 서버 때문에 남는다.
//!  - **Streamable HTTP** (`http`) — 메시지 하나 = POST 하나, 응답은 그 POST 의 본문.
//!    `2025-03-26` 이후의 전송이라 **요즘 서버는 이쪽만 여는 경우가 많고**, 우리엔 이 경로가 없었다.
//!
//! 영속:
//!  - 서버 설정 = `data/mcp-servers.json` (옛 TS 와 동일 포맷)
//!  - connection 자체는 lazy — `list_tools` / `call_tool` 첫 호출 시 connect + initialize handshake
//!
//! Lifecycle:
//!  1. `add_server(config)` → file 영속만. 아직 connect X
//!  2. `list_tools(name)` 첫 호출 시 → connect + `initialize` → `tools/list` 호출
//!  3. 이후 같은 server 재호출 시 cache 된 connection 재사용
//!  4. `call_tool(name, tool, args)` → 같은 connection 위에서 `tools/call` 호출
//!  5. `disconnect_all()` → 모든 connection close (process kill / SSE close)
//!
//! Timeout / 에러: 30s call timeout, initialize 10s. 실패 시 connection 폐기 → 다음 호출 시 재시도.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;

use firebat_core::ports::{
    IMcpClientPort, InfraResult, McpServerConfig, McpToolInfo, McpTransport,
};

// ──────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 frame types
// ──────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct JsonRpcRequest<'a> {
    jsonrpc: &'static str,
    id: u64,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
struct JsonRpcNotification<'a> {
    jsonrpc: &'static str,
    method: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonRpcResponse {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
    #[serde(default)]
    data: Option<serde_json::Value>,
}

const JSONRPC_VERSION: &str = "2.0";
/// MCP spec 최신 (2025-11-25) — `modelcontextprotocol.io/specification/2025-11-25`.
/// 옛 `2024-11-05` → 신 서버 (Gmail/Slack/Notion latest) 와 핸드셰이크 시 downgrade·거부 위험.
/// spec 변경 시 갱신.
const PROTOCOL_VERSION: &str = "2025-11-25";
/// Streamable HTTP 는 본문의 버전을 헤더로도 요구한다(2025-06-18 부터).
const MCP_PROTOCOL_HEADER: &str = "MCP-Protocol-Version";
/// 세션을 쓰는 서버가 발급하고, 이후 요청이 되돌려주는 헤더.
const MCP_SESSION_HEADER: &str = "Mcp-Session-Id";
const CLIENT_NAME: &str = "firebat";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const SSE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

// ──────────────────────────────────────────────────────────────────────────
// Connection trait — stdio / sse 공통 인터페이스
// ──────────────────────────────────────────────────────────────────────────

#[async_trait]
trait Connection: Send + Sync {
    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<serde_json::Value>;

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<()>;

    async fn shutdown(&self);
}

// 응답 대기 채널 — request id 별 oneshot.
type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>;

// ──────────────────────────────────────────────────────────────────────────
// stdio transport
// ──────────────────────────────────────────────────────────────────────────

struct StdioConnection {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    next_id: AtomicU64,
    pending: PendingMap,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
    server_name: String,
}

impl StdioConnection {
    async fn spawn(config: &McpServerConfig) -> InfraResult<Arc<Self>> {
        let command = config
            .command
            .as_ref()
            .ok_or_else(|| format!("MCP {} stdio transport command 누락", config.name))?;

        let mut cmd = Command::new(command);
        cmd.args(&config.args)
            .envs(&config.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "MCP {} stdio spawn 실패 — command={} ({}). PATH 확인 또는 npm i 필요할 수 있습니다.",
                config.name, command, e
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("MCP {} stdin 획득 실패", config.name))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("MCP {} stdout 획득 실패", config.name))?;
        // stderr 는 별도 task 에서 흡수 (server log 가 stdin/stdout protocol 오염 방지).
        if let Some(stderr) = child.stderr.take() {
            let server_name = config.name.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            // server stderr → tracing::debug (운영 진단용)
                            tracing::debug!(server = %server_name, "[mcp stderr] {}", line.trim_end());
                        }
                    }
                }
            });
        }

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        let server_name = config.name.clone();
        let server_name_for_reader = server_name.clone();

        // Reader task — stdout 의 line 단위로 JSON 파싱 + pending oneshot 깨우기
        let reader_handle = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => {
                        tracing::debug!(server = %server_name_for_reader, "MCP stdio EOF");
                        break;
                    }
                    Err(e) => {
                        tracing::warn!(server = %server_name_for_reader, error = %e, "MCP stdio read failed");
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<JsonRpcResponse>(trimmed) {
                            Ok(resp) => {
                                if let Some(id) = resp.id {
                                    let mut guard = pending_for_reader.lock().await;
                                    if let Some(tx) = guard.remove(&id) {
                                        let _ = tx.send(resp);
                                    }
                                }
                                // notification (id 없음) 은 현재 무시 — MCP 의 progress / 알림 미처리
                            }
                            Err(e) => {
                                tracing::debug!(
                                    server = %server_name_for_reader,
                                    error = %e,
                                    line = %trimmed,
                                    "MCP stdio JSON parse failed"
                                );
                            }
                        }
                    }
                }
            }
            // EOF / error → pending 모두 깨움 (취소)
            let mut guard = pending_for_reader.lock().await;
            guard.clear();
        });

        Ok(Arc::new(Self {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            next_id: AtomicU64::new(1),
            pending,
            reader_handle: Mutex::new(Some(reader_handle)),
            server_name,
        }))
    }
}

#[async_trait]
impl Connection for StdioConnection {
    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: JSONRPC_VERSION,
            id,
            method,
            params,
        };
        let mut payload = serde_json::to_string(&req)
            .map_err(|e| format!("JSON-RPC request 직렬화 실패: {e}"))?;
        payload.push('\n');

        let (tx, rx) = oneshot::channel::<JsonRpcResponse>();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id, tx);
        }

        {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| format!("MCP {} stdin 닫힘", self.server_name))?;
            stdin
                .write_all(payload.as_bytes())
                .await
                .map_err(|e| format!("MCP {} stdin write 실패: {e}", self.server_name))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("MCP {} stdin flush 실패: {e}", self.server_name))?;
        }

        let resp = match timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => {
                return Err(format!(
                    "MCP {} 응답 채널 닫힘 — server 이상 종료 가능성",
                    self.server_name
                ));
            }
            Err(_) => {
                // timeout — pending 정리
                let mut guard = self.pending.lock().await;
                guard.remove(&id);
                return Err(format!(
                    "MCP {} {} timeout ({}s)",
                    self.server_name,
                    method,
                    CALL_TIMEOUT.as_secs()
                ));
            }
        };

        if let Some(err) = resp.error {
            return Err(format!(
                "MCP {} {} 에러 (code {}): {}",
                self.server_name, method, err.code, err.message
            ));
        }
        Ok(resp.result.unwrap_or(serde_json::Value::Null))
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<()> {
        let notif = JsonRpcNotification {
            jsonrpc: JSONRPC_VERSION,
            method,
            params,
        };
        let mut payload = serde_json::to_string(&notif)
            .map_err(|e| format!("JSON-RPC notification 직렬화 실패: {e}"))?;
        payload.push('\n');

        let mut stdin_guard = self.stdin.lock().await;
        let stdin = stdin_guard
            .as_mut()
            .ok_or_else(|| format!("MCP {} stdin 닫힘", self.server_name))?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("MCP {} stdin write 실패: {e}", self.server_name))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("MCP {} stdin flush 실패: {e}", self.server_name))?;
        Ok(())
    }

    async fn shutdown(&self) {
        // stdin close → child 가 EOF 받고 정상 종료.
        {
            let mut stdin_guard = self.stdin.lock().await;
            stdin_guard.take();
        }
        // reader task 종료 대기 — 최대 2초.
        if let Some(handle) = self.reader_handle.lock().await.take() {
            let _ = timeout(Duration::from_secs(2), handle).await;
        }
        // child 강제 kill (이미 종료됐으면 no-op).
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
        }
        // pending 모두 정리.
        let mut guard = self.pending.lock().await;
        guard.clear();
    }
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP+SSE transport (옛 MCP spec)
// ──────────────────────────────────────────────────────────────────────────
//
// 흐름:
//   1. GET <sse_url> → text/event-stream
//   2. 첫 'endpoint' event → POST URL (relative path 또는 absolute)
//   3. 이후 'message' event → JSON-RPC response (line-buffered)
//   4. Client → POST <endpoint> with JSON-RPC body

struct SseConnection {
    /// POST endpoint (initialize 후에만 설정)
    post_url: Mutex<Option<String>>,
    next_id: AtomicU64,
    pending: PendingMap,
    sse_handle: Mutex<Option<JoinHandle<()>>>,
    http: reqwest::Client,
    base_url: String,
    server_name: String,
}

impl SseConnection {
    async fn connect(config: &McpServerConfig) -> InfraResult<Arc<Self>> {
        use futures_util::StreamExt;

        let url = config
            .url
            .as_ref()
            .ok_or_else(|| format!("MCP {} sse transport url 누락", config.name))?
            .clone();

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60 * 5)) // streaming response — 큰 timeout
            .build()
            .map_err(|e| format!("reqwest 빌드 실패: {e}"))?;

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let post_url: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // SSE stream 시작
        let response = timeout(
            SSE_CONNECT_TIMEOUT,
            http.get(&url).header("Accept", "text/event-stream").send(),
        )
        .await
        .map_err(|_| format!("MCP {} SSE connect timeout", config.name))?
        .map_err(|e| format!("MCP {} SSE connect 실패: {e}", config.name))?;

        if !response.status().is_success() {
            return Err(format!(
                "MCP {} SSE connect 실패 (HTTP {})",
                config.name,
                response.status()
            ));
        }

        let mut byte_stream = response.bytes_stream();
        let pending_for_reader = pending.clone();
        let post_url_for_reader = post_url.clone();
        let server_name = config.name.clone();
        let server_name_for_reader = server_name.clone();
        let base_url = url.clone();

        // 첫 'endpoint' event 받기 위한 oneshot
        let (endpoint_tx, endpoint_rx) = oneshot::channel::<String>();
        let endpoint_tx = Arc::new(Mutex::new(Some(endpoint_tx)));
        let endpoint_tx_for_reader = endpoint_tx.clone();

        let sse_handle = tokio::spawn(async move {
            let mut buf = String::new();
            let mut current_event: Option<String> = None;
            let mut current_data = String::new();

            while let Some(chunk) = byte_stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(server = %server_name_for_reader, error = %e, "SSE stream disconnected");
                        break;
                    }
                };
                let s = match std::str::from_utf8(&chunk) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                buf.push_str(s);

                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim_end_matches('\r').to_string();
                    buf.drain(..=pos);

                    if line.is_empty() {
                        // event 종료 — process current
                        if let Some(event_name) = &current_event {
                            match event_name.as_str() {
                                "endpoint" => {
                                    let endpoint = resolve_endpoint(&base_url, current_data.trim());
                                    *post_url_for_reader.lock().await = Some(endpoint.clone());
                                    if let Some(tx) = endpoint_tx_for_reader.lock().await.take() {
                                        let _ = tx.send(endpoint);
                                    }
                                }
                                "message" => {
                                    if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(
                                        current_data.trim(),
                                    ) {
                                        if let Some(id) = resp.id {
                                            let mut guard = pending_for_reader.lock().await;
                                            if let Some(tx) = guard.remove(&id) {
                                                let _ = tx.send(resp);
                                            }
                                        }
                                    }
                                }
                                _ => {
                                    // 미지원 event — 무시
                                }
                            }
                        }
                        current_event = None;
                        current_data.clear();
                    } else if let Some(value) = line.strip_prefix("event:") {
                        current_event = Some(value.trim().to_string());
                    } else if let Some(value) = line.strip_prefix("data:") {
                        if !current_data.is_empty() {
                            current_data.push('\n');
                        }
                        current_data.push_str(value.trim_start());
                    }
                    // : 시작 = comment / 그 외 = ignore
                }
            }
            // stream 종료 → pending 정리
            let mut guard = pending_for_reader.lock().await;
            guard.clear();
        });

        // endpoint event 도달 대기
        let endpoint = timeout(SSE_CONNECT_TIMEOUT, endpoint_rx)
            .await
            .map_err(|_| format!("MCP {} endpoint event timeout", config.name))?
            .map_err(|_| format!("MCP {} endpoint 채널 닫힘", config.name))?;

        Ok(Arc::new(Self {
            post_url: Mutex::new(Some(endpoint)),
            next_id: AtomicU64::new(1),
            pending,
            sse_handle: Mutex::new(Some(sse_handle)),
            http,
            base_url: url,
            server_name,
        }))
    }
}

/// SSE endpoint 가 absolute URL 또는 relative path 일 수 있음 — base_url 와 join.
fn resolve_endpoint(base: &str, data: &str) -> String {
    if data.starts_with("http://") || data.starts_with("https://") {
        return data.to_string();
    }
    if let Ok(base_url) = url::Url::parse(base) {
        if let Ok(joined) = base_url.join(data) {
            return joined.to_string();
        }
    }
    // fallback — base + data
    if data.starts_with('/') {
        if let Some(idx) = base
            .find("://")
            .and_then(|i| base[i + 3..].find('/').map(|j| i + 3 + j))
        {
            let origin = &base[..idx];
            return format!("{}{}", origin, data);
        }
    }
    format!("{}/{}", base.trim_end_matches('/'), data.trim_start_matches('/'))
}

#[async_trait]
impl Connection for SseConnection {
    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: JSONRPC_VERSION,
            id,
            method,
            params,
        };

        let post_url = self
            .post_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| format!("MCP {} POST endpoint 미설정 (SSE 끊김)", self.server_name))?;

        let (tx, rx) = oneshot::channel::<JsonRpcResponse>();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id, tx);
        }

        let resp = self
            .http
            .post(&post_url)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("MCP {} POST 실패: {e}", self.server_name))?;
        if !resp.status().is_success() {
            // pending 정리
            let mut guard = self.pending.lock().await;
            guard.remove(&id);
            return Err(format!(
                "MCP {} POST HTTP {} — body: {}",
                self.server_name,
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }
        // SSE channel 로 응답이 옴 (POST body 자체엔 없음)

        let resp = match timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => {
                return Err(format!("MCP {} SSE 채널 닫힘", self.server_name));
            }
            Err(_) => {
                let mut guard = self.pending.lock().await;
                guard.remove(&id);
                return Err(format!(
                    "MCP {} {} timeout ({}s)",
                    self.server_name,
                    method,
                    CALL_TIMEOUT.as_secs()
                ));
            }
        };

        if let Some(err) = resp.error {
            return Err(format!(
                "MCP {} {} 에러 (code {}): {}",
                self.server_name, method, err.code, err.message
            ));
        }
        Ok(resp.result.unwrap_or(serde_json::Value::Null))
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<()> {
        let notif = JsonRpcNotification {
            jsonrpc: JSONRPC_VERSION,
            method,
            params,
        };
        let post_url = self
            .post_url
            .lock()
            .await
            .clone()
            .ok_or_else(|| format!("MCP {} POST endpoint 미설정", self.server_name))?;

        let resp = self
            .http
            .post(&post_url)
            .json(&notif)
            .send()
            .await
            .map_err(|e| format!("MCP {} notification POST 실패: {e}", self.server_name))?;
        if !resp.status().is_success() {
            return Err(format!(
                "MCP {} notification HTTP {}",
                self.server_name,
                resp.status()
            ));
        }
        Ok(())
    }

    async fn shutdown(&self) {
        // SSE task abort.
        if let Some(handle) = self.sse_handle.lock().await.take() {
            handle.abort();
        }
        let mut guard = self.pending.lock().await;
        guard.clear();
        let _ = self.base_url; // suppress unused warning
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Streamable HTTP transport (MCP spec 2025-03-26 이후)
// ──────────────────────────────────────────────────────────────────────────
//
// 위 HTTP+SSE 와 같은 HTTP 인데 **모양이 첫 수부터 다르다** — 여는 GET 도, `endpoint` 이벤트도,
// 상시 스트림도 없다. 메시지 하나가 POST 하나이고 응답은 그 POST 자신의 본문으로 온다:
//
//   Content-Type: application/json   → JSON-RPC 응답 한 개
//   Content-Type: text/event-stream  → 그 요청에 딸린 알림이 흐르고 **마지막에** 응답, 그리고 닫힘
//
// 세션을 쓰는 서버는 `Mcp-Session-Id` 헤더로 발급하고, 클라이언트는 이후 요청마다 그 값을
// 되돌려준다(2025-03-26~2025-11-25. `2026-07-28` 에서 세션 자체가 삭제됐다).
//
// ⚠️ 이 경로가 없어서 **Streamable HTTP 만 여는 서버엔 붙을 방법이 아예 없었다**(2026-09-04 판독).
// 옛 `Sse` 는 그대로 둔다 — 이미 그 설정으로 등록된 서버가 무엇인지 여기서 알 수 없고, 두 전송은
// 첫 수부터 갈려서 한쪽을 고쳐도 다른 쪽이 안 따라온다.

struct StreamableHttpConnection {
    url: String,
    next_id: AtomicU64,
    http: reqwest::Client,
    /// 서버가 발급한 세션 id. 주는 서버에만 생기고, 생긴 뒤로는 매 요청에 실어 되돌려준다.
    session_id: Mutex<Option<String>>,
    server_name: String,
}

impl StreamableHttpConnection {
    async fn connect(config: &McpServerConfig) -> InfraResult<Arc<Self>> {
        let url = config
            .url
            .as_ref()
            .ok_or_else(|| format!("MCP {} http transport url 누락", config.name))?
            .clone();

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60 * 5))
            .build()
            .map_err(|e| format!("reqwest 빌드 실패: {e}"))?;

        // 여는 왕복이 없다 — 첫 POST(`initialize`)가 곧 첫 접촉이라 여기서 할 I/O 가 없다.
        Ok(Arc::new(Self {
            url,
            next_id: AtomicU64::new(1),
            http,
            session_id: Mutex::new(None),
            server_name: config.name.clone(),
        }))
    }

    /// 요청·알림 공통 POST. 세션이 있으면 싣고, 응답 헤더로 세션이 오면 받아 둔다.
    async fn post(&self, body: &serde_json::Value) -> InfraResult<reqwest::Response> {
        let mut req = self
            .http
            .post(&self.url)
            // 스펙이 둘 다 받으라고 요구한다 — 서버가 요청마다 어느 쪽으로 답할지 고른다.
            .header("Accept", "application/json, text/event-stream")
            .header(MCP_PROTOCOL_HEADER, PROTOCOL_VERSION)
            .json(body);

        if let Some(sid) = self.session_id.lock().await.clone() {
            req = req.header(MCP_SESSION_HEADER, sid);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("MCP {} POST 실패: {e}", self.server_name))?;

        if let Some(sid) = resp
            .headers()
            .get(MCP_SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session_id.lock().await = Some(sid.to_string());
        }
        Ok(resp)
    }
}

/// Streamable HTTP 의 SSE 응답 본문에서 **그 요청의** JSON-RPC 응답을 꺼낸다.
///
/// 스트림에는 그 요청에 딸린 알림(`notifications/progress`·`notifications/message`)이 먼저 흐르고
/// **마지막에** 응답이 온다. 그래서 첫 `data:` 를 답으로 읽으면 알림을 결과로 착각한다 — id 가 맞는
/// 것을 찾아야 하고, 그게 이 함수가 따로 있는 이유다.
fn rpc_from_sse_body(body: &str, id: u64) -> Option<JsonRpcResponse> {
    let mut data = String::new();
    let mut out: Option<JsonRpcResponse> = None;

    // 마지막 이벤트가 빈 줄로 안 끝나고 스트림이 닫힐 수 있다 — 빈 줄 하나를 덧대 흘려보낸다.
    for raw in body.lines().chain(std::iter::once("")) {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            if !data.is_empty() {
                if let Ok(r) = serde_json::from_str::<JsonRpcResponse>(data.trim()) {
                    if r.id == Some(id) {
                        out = Some(r);
                    }
                }
                data.clear();
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.trim_start());
        }
        // `event:` / `id:` / `:` 주석 — 이 경로가 쓸 일이 없다.
    }
    out
}

#[async_trait]
impl Connection for StreamableHttpConnection {
    async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = JsonRpcRequest {
            jsonrpc: JSONRPC_VERSION,
            id,
            method,
            params,
        };
        let body = serde_json::to_value(&req)
            .map_err(|e| format!("MCP {} 요청 직렬화 실패: {e}", self.server_name))?;

        let resp = match timeout(CALL_TIMEOUT, self.post(&body)).await {
            Ok(r) => r?,
            Err(_) => {
                return Err(format!(
                    "MCP {} {} timeout ({}s)",
                    self.server_name,
                    method,
                    CALL_TIMEOUT.as_secs()
                ));
            }
        };

        let status = resp.status();
        let is_sse = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.starts_with("text/event-stream"))
            .unwrap_or(false);

        let text = match timeout(CALL_TIMEOUT, resp.text()).await {
            Ok(t) => t.map_err(|e| format!("MCP {} 응답 읽기 실패: {e}", self.server_name))?,
            Err(_) => {
                return Err(format!(
                    "MCP {} {} 응답 본문 timeout ({}s)",
                    self.server_name,
                    method,
                    CALL_TIMEOUT.as_secs()
                ));
            }
        };

        if !status.is_success() {
            // 본문을 같이 싣는다 — 신판 서버는 여기에 왜 거절했는지를 JSON-RPC 에러로 적는다.
            return Err(format!(
                "MCP {} POST HTTP {} — body: {}",
                self.server_name, status, text
            ));
        }

        let rpc: JsonRpcResponse = if is_sse {
            rpc_from_sse_body(&text, id).ok_or_else(|| {
                format!(
                    "MCP {} {} — SSE 스트림이 id {} 의 응답 없이 끝났다",
                    self.server_name, method, id
                )
            })?
        } else {
            serde_json::from_str(&text)
                .map_err(|e| format!("MCP {} {} 응답 파싱 실패: {e}", self.server_name, method))?
        };

        if let Some(err) = rpc.error {
            return Err(format!(
                "MCP {} {} 에러 (code {}): {}",
                self.server_name, method, err.code, err.message
            ));
        }
        Ok(rpc.result.unwrap_or(serde_json::Value::Null))
    }

    async fn send_notification(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> InfraResult<()> {
        let notif = JsonRpcNotification {
            jsonrpc: JSONRPC_VERSION,
            method,
            params,
        };
        let body = serde_json::to_value(&notif)
            .map_err(|e| format!("MCP {} 알림 직렬화 실패: {e}", self.server_name))?;

        let resp = match timeout(CALL_TIMEOUT, self.post(&body)).await {
            Ok(r) => r?,
            Err(_) => return Err(format!("MCP {} notification timeout", self.server_name)),
        };
        if !resp.status().is_success() {
            return Err(format!(
                "MCP {} notification HTTP {}",
                self.server_name,
                resp.status()
            ));
        }
        Ok(())
    }

    async fn shutdown(&self) {
        // 세션을 발급한 서버에겐 DELETE 가 종료 신호다. 안 준 서버면 보낼 것이 없다 — 무상태라
        // 끊는 것 자체가 아무 상태도 안 남긴다.
        let sid = self.session_id.lock().await.take();
        if let Some(sid) = sid {
            let _ = self
                .http
                .delete(&self.url)
                .header(MCP_PROTOCOL_HEADER, PROTOCOL_VERSION)
                .header(MCP_SESSION_HEADER, sid)
                .send()
                .await;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// MCP initialize handshake
// ──────────────────────────────────────────────────────────────────────────

async fn initialize_connection(conn: &dyn Connection) -> InfraResult<()> {
    let params = serde_json::json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {
            "name": CLIENT_NAME,
            "version": CLIENT_VERSION
        }
    });
    let _result = timeout(INITIALIZE_TIMEOUT, conn.send_request("initialize", Some(params)))
        .await
        .map_err(|_| "MCP initialize timeout".to_string())??;
    // initialized notification (response 없음)
    conn.send_notification("notifications/initialized", None)
        .await?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// McpClientFileAdapter — 메인 어댑터
// ──────────────────────────────────────────────────────────────────────────

pub struct McpClientFileAdapter {
    config_path: PathBuf,
    servers: Mutex<HashMap<String, McpServerConfig>>,
    connections: Mutex<HashMap<String, Arc<dyn Connection>>>,
}

impl McpClientFileAdapter {
    pub fn new(config_path: PathBuf) -> InfraResult<Self> {
        let servers = if config_path.exists() {
            let raw = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("MCP servers 파일 read 실패: {e}"))?;
            serde_json::from_str::<Vec<McpServerConfig>>(&raw)
                .unwrap_or_default()
                .into_iter()
                .map(|c| (c.name.clone(), c))
                .collect()
        } else {
            HashMap::new()
        };
        Ok(Self {
            config_path,
            servers: Mutex::new(servers),
            connections: Mutex::new(HashMap::new()),
        })
    }

    fn flush(&self, servers: &HashMap<String, McpServerConfig>) -> InfraResult<()> {
        if let Some(parent) = self.config_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("MCP servers 디렉토리 생성 실패: {e}"))?;
        }
        let mut list: Vec<&McpServerConfig> = servers.values().collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        let raw = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("MCP servers 직렬화 실패: {e}"))?;
        std::fs::write(&self.config_path, raw)
            .map_err(|e| format!("MCP servers 파일 write 실패: {e}"))?;
        Ok(())
    }

    /// 캐시된 connection 가져오거나 신규 connect + initialize.
    async fn get_or_connect(&self, server_name: &str) -> InfraResult<Arc<dyn Connection>> {
        {
            let guard = self.connections.lock().await;
            if let Some(conn) = guard.get(server_name) {
                return Ok(conn.clone());
            }
        }
        let config = {
            let guard = self.servers.lock().await;
            guard.get(server_name).cloned()
        };
        let config =
            config.ok_or_else(|| format!("MCP 서버 미등록: {}", server_name))?;
        if !config.enabled {
            return Err(format!("MCP 서버 {} 비활성", server_name));
        }

        let conn: Arc<dyn Connection> = match config.transport {
            McpTransport::Stdio => {
                let conn = StdioConnection::spawn(&config).await?;
                conn as Arc<dyn Connection>
            }
            McpTransport::Sse => {
                let conn = SseConnection::connect(&config).await?;
                conn as Arc<dyn Connection>
            }
            McpTransport::Http => {
                let conn = StreamableHttpConnection::connect(&config).await?;
                conn as Arc<dyn Connection>
            }
        };

        if let Err(e) = initialize_connection(conn.as_ref()).await {
            // initialize 실패 → connection 폐기
            conn.shutdown().await;
            return Err(format!("MCP {} initialize 실패: {e}", server_name));
        }

        let mut guard = self.connections.lock().await;
        guard.insert(server_name.to_string(), conn.clone());
        Ok(conn)
    }
}

#[async_trait]
impl IMcpClientPort for McpClientFileAdapter {
    fn list_servers(&self) -> Vec<McpServerConfig> {
        let guard = self.servers.try_lock();
        match guard {
            Ok(g) => {
                let mut list: Vec<McpServerConfig> = g.values().cloned().collect();
                list.sort_by(|a, b| a.name.cmp(&b.name));
                list
            }
            Err(_) => Vec::new(),
        }
    }

    async fn add_server(&self, config: McpServerConfig) -> InfraResult<()> {
        if config.name.trim().is_empty() {
            return Err("MCP 서버 name 누락".to_string());
        }
        let mut guard = self.servers.lock().await;
        // 기존 서버 교체 시 connection 도 무효화 (다음 호출 시 재 connect)
        let had_existing = guard.contains_key(&config.name);
        guard.insert(config.name.clone(), config.clone());
        self.flush(&guard)?;
        drop(guard);
        if had_existing {
            let mut conns = self.connections.lock().await;
            if let Some(conn) = conns.remove(&config.name) {
                drop(conns);
                conn.shutdown().await;
            }
        }
        Ok(())
    }

    async fn remove_server(&self, name: &str) -> InfraResult<()> {
        let mut guard = self.servers.lock().await;
        if guard.remove(name).is_none() {
            return Err(format!("MCP 서버 {} 미등록", name));
        }
        self.flush(&guard)?;
        drop(guard);
        // 활성 connection 도 정리
        let mut conns = self.connections.lock().await;
        if let Some(conn) = conns.remove(name) {
            drop(conns);
            conn.shutdown().await;
        }
        Ok(())
    }

    async fn list_tools(&self, server_name: &str) -> InfraResult<Vec<McpToolInfo>> {
        let conn = self.get_or_connect(server_name).await?;
        let result = conn.send_request("tools/list", None).await?;
        parse_tools_list(server_name, &result)
    }

    async fn list_all_tools(&self) -> InfraResult<Vec<McpToolInfo>> {
        let names: Vec<String> = {
            let guard = self.servers.lock().await;
            guard
                .values()
                .filter(|c| c.enabled)
                .map(|c| c.name.clone())
                .collect()
        };
        let mut all = Vec::new();
        for name in names {
            match self.list_tools(&name).await {
                Ok(mut tools) => all.append(&mut tools),
                Err(e) => {
                    // 한 server 실패해도 나머지 계속 — 운영 안정성 (옛 TS 동등)
                    tracing::warn!(server = %name, error = %e, "MCP list_tools failed (skip)");
                }
            }
        }
        Ok(all)
    }

    async fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        let conn = self.get_or_connect(server_name).await?;
        let params = serde_json::json!({
            "name": tool_name,
            "arguments": args,
        });
        conn.send_request("tools/call", Some(params)).await
    }

    async fn disconnect_all(&self) {
        let mut guard = self.connections.lock().await;
        let conns: Vec<Arc<dyn Connection>> = guard.drain().map(|(_, v)| v).collect();
        drop(guard);
        for conn in conns {
            conn.shutdown().await;
        }
    }
}

/// `tools/list` 응답 → McpToolInfo 배열.
/// 응답 형식: `{ "tools": [{ "name": ..., "description": ..., "inputSchema": ... }] }`
fn parse_tools_list(
    server_name: &str,
    result: &serde_json::Value,
) -> InfraResult<Vec<McpToolInfo>> {
    let tools = result
        .get("tools")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("MCP {} tools/list 응답에 tools 배열 없음", server_name))?;
    let mut out = Vec::with_capacity(tools.len());
    for t in tools {
        let name = t
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let description = t
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let input_schema = t.get("inputSchema").cloned();
        out.push(McpToolInfo {
            server: server_name.to_string(),
            name,
            description,
            input_schema,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_adapter() -> (McpClientFileAdapter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp-servers.json");
        let adapter = McpClientFileAdapter::new(path).unwrap();
        (adapter, dir)
    }

    #[tokio::test]
    async fn add_list_remove_roundtrip() {
        let (adapter, _dir) = make_adapter();

        adapter
            .add_server(McpServerConfig {
                name: "gmail".to_string(),
                transport: McpTransport::Stdio,
                command: Some("npx".to_string()),
                args: vec!["@modelcontextprotocol/server-gmail".to_string()],
                env: HashMap::new(),
                url: None,
                enabled: true,
            })
            .await
            .unwrap();

        let list = adapter.list_servers();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "gmail");
        assert_eq!(list[0].transport, McpTransport::Stdio);

        adapter.remove_server("gmail").await.unwrap();
        assert!(adapter.list_servers().is_empty());
    }

    /// Streamable HTTP 의 스트림 응답에서 답을 고르는 규칙 — **마지막 것도 첫 것도 아니고 id 가 맞는 것**.
    ///
    /// 그 요청에 딸린 알림이 먼저 흐르므로 첫 `data:` 를 답으로 읽으면 진행률을 결과로 착각한다.
    #[test]
    fn sse_body_picks_the_reply_not_the_notification_before_it() {
        let body = concat!(
            "event: message
",
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}
",
            "
",
            "event: message
",
            "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"tools\":[]}}
",
            "
",
        );
        let got = rpc_from_sse_body(body, 7).expect("id 7 의 응답이 있어야 한다");
        assert_eq!(got.id, Some(7));
        assert!(got.result.is_some());
    }

    /// 알림만 흐르고 끝난 스트림은 "답 없음"이다 — 알림을 답으로 승격시키면 안 된다.
    #[test]
    fn sse_body_without_a_matching_id_is_no_answer() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}

";
        assert!(rpc_from_sse_body(body, 1).is_none());
        // 다른 요청의 응답이 섞여 들어와도 내 것이 아니다.
        let other = "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}

";
        assert!(rpc_from_sse_body(other, 1).is_none());
    }

    /// CRLF 로 오고 마지막 이벤트가 빈 줄 없이 닫혀도 읽어야 한다 — 둘 다 실물에서 온다.
    #[test]
    fn sse_body_survives_crlf_and_an_unterminated_last_event() {
        let body = "event: message
data: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"ok\":true}}";
        let got = rpc_from_sse_body(body, 3).expect("빈 줄 없이 끝나도 읽혀야 한다");
        assert_eq!(got.id, Some(3));
    }

    /// 여러 줄로 쪼개진 `data:` 는 개행으로 이어 붙인 뒤에야 JSON 이 된다.
    #[test]
    fn sse_body_joins_a_multiline_data_field() {
        let body = "data: {\"jsonrpc\":\"2.0\",
 data: \"id\":4,
 data: \"result\":{}}

";
        // 위는 `data:` 접두만 벗기면 세 조각이 한 JSON 이 된다.
        let joined = rpc_from_sse_body(
            "data: {\"jsonrpc\": \"2.0\",
data: \"id\": 4,
data: \"result\": {}}

",
            4,
        );
        assert!(joined.is_some(), "여러 줄 data 를 못 이었다: {body}");
    }

    #[tokio::test]
    async fn add_persists_to_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("mcp.json");

        {
            let adapter = McpClientFileAdapter::new(path.clone()).unwrap();
            adapter
                .add_server(McpServerConfig {
                    name: "slack".to_string(),
                    transport: McpTransport::Sse,
                    command: None,
                    args: vec![],
                    env: HashMap::new(),
                    url: Some("https://example.com/mcp".to_string()),
                    enabled: true,
                })
                .await
                .unwrap();
        }

        let adapter = McpClientFileAdapter::new(path).unwrap();
        let list = adapter.list_servers();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].url.as_deref(), Some("https://example.com/mcp"));
    }

    #[tokio::test]
    async fn remove_unknown_returns_error() {
        let (adapter, _dir) = make_adapter();
        let result = adapter.remove_server("none").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn call_tool_unregistered_server_errors() {
        let (adapter, _dir) = make_adapter();
        let result = adapter
            .call_tool("missing", "tool", &serde_json::json!({}))
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("미등록"));
    }

    #[tokio::test]
    async fn list_all_tools_empty_when_no_servers() {
        let (adapter, _dir) = make_adapter();
        let tools = adapter.list_all_tools().await.unwrap();
        assert!(tools.is_empty());
    }

    #[test]
    fn parse_tools_list_extracts_fields() {
        let json = serde_json::json!({
            "tools": [
                { "name": "send_email", "description": "이메일 발송", "inputSchema": {"type": "object"} },
                { "name": "list_inbox", "description": "받은 편지함" }
            ]
        });
        let parsed = parse_tools_list("gmail", &json).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].server, "gmail");
        assert_eq!(parsed[0].name, "send_email");
        assert!(parsed[0].input_schema.is_some());
        assert_eq!(parsed[1].name, "list_inbox");
        assert!(parsed[1].input_schema.is_none());
    }

    #[test]
    fn resolve_endpoint_handles_relative_and_absolute() {
        // absolute URL passthrough
        assert_eq!(
            resolve_endpoint("https://api.example.com/sse", "https://other.host/post"),
            "https://other.host/post"
        );
        // relative path
        assert_eq!(
            resolve_endpoint("https://api.example.com/sse", "/messages"),
            "https://api.example.com/messages"
        );
        // relative without leading slash
        assert!(resolve_endpoint("https://api.example.com/sse", "messages").contains("messages"));
    }
}

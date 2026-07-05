//! WS API transport adapter — request/response over a short-lived WebSocket connection.
//!
//! Common infra for WebSocket-only sysmod actions (Kiwoom 조건검색 etc). Everything
//! provider-specific lives in the module's config.json `ws` block as DATA (endpoint,
//! frames, match rules) — this adapter only owns the mechanics:
//!
//! - connect (wss, rustls) with an overall deadline
//! - login handshake, token filled from the shared OAuthTokenProvider (proactive refresh;
//!   reactive force-refresh + one reconnect retry on `invalidWhen` match — sandbox mirror)
//! - request → response correlation by a frame-type field (e.g. "trnm"), echoing keepalive
//!   frames (e.g. Kiwoom PING) verbatim and skipping unrelated frames
//! - shared auto-cache choke-point (`ProcessSandboxAdapter::apply_auto_cache`) so big result
//!   arrays behave exactly like sandbox sysmod results (cache_read / cache_grep)
//!
//! Persistent subscriptions (realtime push, e.g. ka10173) are a later stage — this port is
//! strictly one-shot: connect → login → ask → answer → close.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use firebat_core::ports::{IWsApiPort, InfraResult, ModuleOutput, WsApiCall, WsFieldEq};
use firebat_core::utils::secret_schema::OAuthSpec;
use firebat_core::utils::sysmod_cache::SysmodCacheAdapter;

use crate::adapters::sandbox::ProcessSandboxAdapter;
use crate::adapters::token_provider::OAuthTokenProvider;

pub struct WsApiAdapter {
    workspace_root: PathBuf,
    token_provider: Option<Arc<OAuthTokenProvider>>,
    cache: Option<Arc<SysmodCacheAdapter>>,
}

impl WsApiAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            token_provider: None,
            cache: None,
        }
    }

    /// Shared with the sandbox path — one provider instance keeps the per-secret locks
    /// effective across both transports (no thundering herd on the token endpoint).
    pub fn with_token_provider(mut self, provider: Arc<OAuthTokenProvider>) -> Self {
        self.token_provider = Some(provider);
        self
    }

    /// Shared auto-cache — same SysmodCacheAdapter instance the sandbox uses.
    pub fn with_cache(mut self, cache: Arc<SysmodCacheAdapter>) -> Self {
        self.cache = Some(cache);
        self
    }

    /// The module's token oauth spec for `login.tokenSecret` (same config source the sandbox
    /// proactive/reactive path reads).
    fn token_spec(&self, call: &WsApiCall) -> Option<(String, OAuthSpec, u64)> {
        let secret_name = call.login.as_ref()?.token_secret.as_deref()?;
        let module_dir = self.workspace_root.join(&call.module_dir);
        ProcessSandboxAdapter::oauth_token_secrets(&module_dir)
            .into_iter()
            .find(|(name, _, _)| name == secret_name)
    }

    async fn attempt(&self, call: &WsApiCall, force_token: bool) -> InfraResult<ModuleOutput> {
        let deadline = Instant::now() + Duration::from_millis(call.timeout_ms);

        // Token first (proactive; force on the reactive retry). No valid token = no login.
        let token = if let Some(login) = &call.login {
            if login.token_secret.is_some() {
                let Some(tp) = &self.token_provider else {
                    return Err(format!(
                        "[{}] ws login needs a token but no token provider is wired",
                        call.module
                    ));
                };
                let Some((name, spec, life)) = self.token_spec(call) else {
                    return Err(format!(
                        "[{}] ws login tokenSecret has no oauth spec in config.json",
                        call.module
                    ));
                };
                Some(
                    tp.ensure_fresh(&name, &spec, life, call.mock, force_token)
                        .await
                        .map_err(|e| format!("[{}] token refresh failed: {e}", call.module))?,
                )
            } else {
                None
            }
        } else {
            None
        };

        let (mut ws, _resp) = tokio::time::timeout(
            remaining(deadline)?,
            tokio_tungstenite::connect_async(&call.endpoint),
        )
        .await
        .map_err(|_| format!("[{}] ws connect timeout: {}", call.module, call.endpoint))?
        .map_err(|e| format!("[{}] ws connect failed: {e}", call.module))?;

        // Login handshake (when declared).
        if let Some(login) = &call.login {
            let frame = fill_token(&login.frame, token.as_deref());
            send_json(&mut ws, &frame, call).await?;
            let resp = await_frame(&mut ws, call, &login.response_match, deadline).await?;
            if let Some(rule) = &login.success_when {
                if !field_eq(&resp, rule) {
                    let msg = error_message(&resp, call);
                    let _ = ws.close(None).await;
                    return Err(format!("[{}] ws login failed: {msg}", call.module));
                }
            }
        }

        // Prerequisite frames — same-session ordering some providers require (e.g. Kiwoom
        // answers CNSRREQ only after CNSRLST loaded the condition list into this session).
        for pre in &call.pre_frames {
            send_json(&mut ws, &pre.frame, call).await?;
            if pre.response_match.is_empty() {
                continue; // fire-and-forget pre-frame (no ack defined)
            }
            let resp = await_frame(&mut ws, call, &pre.response_match, deadline).await?;
            if let Some(rule) = &pre.success_when {
                if !field_eq(&resp, rule) {
                    let msg = error_message(&resp, call);
                    let _ = ws.close(None).await;
                    return Err(format!(
                        "[{}] ws pre-frame {} failed: {msg}",
                        call.module, pre.response_match
                    ));
                }
            }
        }

        // Request → matching response.
        send_json(&mut ws, &call.request_frame, call).await?;
        let resp = await_frame(&mut ws, call, &call.response_match, deadline).await?;
        let _ = ws.close(None).await;
        tracing::info!(
            target: "ws_api",
            module = %call.module,
            action = %call.action,
            "ws call completed"
        );

        let ok = call
            .success_when
            .as_ref()
            .map(|rule| field_eq(&resp, rule))
            .unwrap_or(true);
        if ok {
            // Shared choke-point: big arrays → cache file + preview, exactly like sandbox
            // sysmod results (and the future range-coverage store hooks here too).
            let data = match &self.cache {
                Some(cache) => ProcessSandboxAdapter::apply_auto_cache(
                    resp,
                    cache.as_ref(),
                    &call.module,
                    &call.action,
                ),
                None => resp,
            };
            Ok(ModuleOutput {
                success: true,
                data,
                ..ModuleOutput::default()
            })
        } else {
            let msg = error_message(&resp, call);
            Ok(ModuleOutput {
                success: false,
                data: resp,
                error: Some(msg),
                ..ModuleOutput::default()
            })
        }
    }
}

#[async_trait]
impl IWsApiPort for WsApiAdapter {
    async fn call(&self, call: &WsApiCall) -> InfraResult<ModuleOutput> {
        let result = self.attempt(call, false).await?;

        // Reactive token refresh — the response matched the module's `invalidWhen` rule
        // (expired/revoked token): force re-issue and retry exactly once (sandbox mirror).
        if !result.success {
            if let (Some(tp), Some((_, spec, _))) = (&self.token_provider, self.token_spec(call)) {
                if tp.is_invalid(&spec, &result.data) {
                    tracing::info!(
                        target: "ws_api",
                        module = %call.module,
                        action = %call.action,
                        "token invalid on ws response — force refresh + one retry"
                    );
                    return self.attempt(call, true).await;
                }
            }
        }
        Ok(result)
    }
}

fn remaining(deadline: Instant) -> InfraResult<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| "ws call deadline exceeded".to_string())
}

/// Replace the literal `"{TOKEN}"` string values with the fetched token (deep walk).
fn fill_token(frame: &serde_json::Value, token: Option<&str>) -> serde_json::Value {
    match frame {
        serde_json::Value::String(s) if s == "{TOKEN}" => {
            serde_json::Value::String(token.unwrap_or_default().to_string())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), fill_token(v, token)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|i| fill_token(i, token)).collect())
        }
        other => other.clone(),
    }
}

/// String-coerced field comparison — mirrors the token provider's `invalidWhen` semantics
/// (providers are loose about number-vs-string, e.g. return_code 0 vs "0").
fn field_eq(frame: &serde_json::Value, rule: &WsFieldEq) -> bool {
    let Some(actual) = frame.get(&rule.field) else {
        return false;
    };
    coerce(actual) == coerce(&rule.equals)
}

fn coerce(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Human-readable failure message: config-declared field (e.g. return_msg) when present,
/// otherwise a compact dump of the frame (capped, char-safe).
fn error_message(frame: &serde_json::Value, call: &WsApiCall) -> String {
    if let Some(field) = &call.error_msg_field {
        if let Some(msg) = frame.get(field).and_then(|v| v.as_str()) {
            if !msg.trim().is_empty() {
                return msg.to_string();
            }
        }
    }
    let raw = frame.to_string();
    raw.chars().take(300).collect()
}

async fn send_json(
    ws: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    frame: &serde_json::Value,
    call: &WsApiCall,
) -> InfraResult<()> {
    ws.send(Message::Text(frame.to_string()))
        .await
        .map_err(|e| format!("[{}] ws send failed: {e}", call.module))
}

/// Read frames until one whose `match_field` equals `expected`. Echo declared keepalive
/// frames (e.g. Kiwoom `{"trnm":"PING"}` must be echoed verbatim) and skip everything else.
async fn await_frame<S>(
    ws: &mut S,
    call: &WsApiCall,
    expected: &str,
    deadline: Instant,
) -> InfraResult<serde_json::Value>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    loop {
        let msg = tokio::time::timeout(remaining(deadline)?, ws.next())
            .await
            .map_err(|_| {
                format!(
                    "[{}] ws response timeout waiting for {expected}",
                    call.module
                )
            })?
            .ok_or_else(|| format!("[{}] ws closed while waiting for {expected}", call.module))?
            .map_err(|e| format!("[{}] ws read failed: {e}", call.module))?;

        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => {
                return Err(format!(
                    "[{}] ws closed by server while waiting for {expected}",
                    call.module
                ));
            }
            // Protocol ping/pong is answered by tungstenite; binary/other frames are skipped.
            _ => continue,
        };
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(kind) = frame.get(&call.match_field).and_then(|v| v.as_str()) else {
            continue;
        };
        if call.echo_values.iter().any(|e| e == kind) {
            // App-level keepalive — echo back verbatim (provider contract).
            let _ = ws.send(Message::Text(text)).await;
            continue;
        }
        if kind == expected {
            return Ok(frame);
        }
        // Unrelated frame type — keep waiting until the deadline. Logged (frame-type only,
        // never the payload — login frames carry tokens) so silent-timeout diagnosis is
        // possible from journalctl.
        tracing::info!(
            target: "ws_api",
            module = %call.module,
            frame_kind = %kind,
            waiting_for = %expected,
            "skip unrelated ws frame"
        );
    }
}

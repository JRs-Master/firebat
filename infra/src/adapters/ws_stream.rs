//! WS stream adapter — persistent realtime subscriptions (config `ws.streams` declarative).
//!
//! One tokio task per watch: connect → login → preFrames → subscribe → forward every frame
//! matching `realtime_match` to the sink (event bus + notify, wired in main). The task owns
//! reconnection: on drop it backs off (5s → 60s cap) and re-runs the whole handshake +
//! resubscribe. Stop sends the declared unsubscribe frame best-effort and ends the task.
//!
//! Provider specifics (frames, match rules) are config data — this file owns mechanics only.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use firebat_core::ports::{
    IWsStreamPort, InfraResult, WsDecryptSpec, WsFrameFormat, WsStreamSink, WsStreamSpec,
    WsStreamStatus,
};
use firebat_core::utils::secret_schema::OAuthSpec;

use crate::adapters::sandbox::ProcessSandboxAdapter;
use crate::adapters::token_provider::OAuthTokenProvider;
use crate::adapters::ws_api::{coerce, field_eq, fill_token, frame_get};

/// Per-handshake-step budget (connect / login / pre-frame / subscribe ack).
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
const BACKOFF_STEPS_SEC: &[u64] = &[5, 10, 20, 40, 60];
/// A session that stayed alive this long resets the reconnect backoff.
const STABLE_SESSION: Duration = Duration::from_secs(60);

struct StatusInner {
    state: String,
    detail: Option<String>,
    since_ms: i64,
    last_event_ms: Option<i64>,
    event_count: u64,
}

struct WatchTask {
    cancel: tokio::sync::watch::Sender<bool>,
    status: Arc<Mutex<StatusInner>>,
}

pub struct WsStreamAdapter {
    workspace_root: PathBuf,
    token_provider: Option<Arc<OAuthTokenProvider>>,
    /// Shared holder — set after construction (main wires event bus + notify) and read
    /// lazily by watch tasks, so boot-restored watches see the sink once it's wired.
    sink: Arc<Mutex<Option<WsStreamSink>>>,
    tasks: Mutex<HashMap<String, WatchTask>>,
}

impl WsStreamAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            token_provider: None,
            sink: Arc::new(Mutex::new(None)),
            tasks: Mutex::new(HashMap::new()),
        }
    }

    /// Shared with sandbox/ws_api — one instance keeps per-secret locks effective.
    pub fn with_token_provider(mut self, provider: Arc<OAuthTokenProvider>) -> Self {
        self.token_provider = Some(provider);
        self
    }

    /// Event sink — set after construction because the closure captures managers that are
    /// built later in main (module manager for notify routing).
    pub fn set_sink(&self, sink: WsStreamSink) {
        *self.sink.lock().unwrap_or_else(|p| p.into_inner()) = Some(sink);
    }

    fn token_spec(&self, spec: &WsStreamSpec) -> Option<(String, OAuthSpec, u64)> {
        // Token secret comes from the LOGIN frame (kiwoom) or spec-level (한투 approval_key,
        // which rides in the subscribe frame rather than a LOGIN handshake).
        let secret_name = spec
            .login
            .as_ref()
            .and_then(|l| l.token_secret.as_deref())
            .or(spec.token_secret.as_deref())?;
        let module_dir = self.workspace_root.join(&spec.module_dir);
        ProcessSandboxAdapter::oauth_token_secrets(&module_dir)
            .into_iter()
            .find(|(name, _, _)| name == secret_name)
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn set_state(status: &Arc<Mutex<StatusInner>>, state: &str, detail: Option<String>) {
    let mut s = status.lock().unwrap_or_else(|p| p.into_inner());
    s.state = state.to_string();
    s.detail = detail;
}

#[async_trait]
impl IWsStreamPort for WsStreamAdapter {
    async fn start(&self, spec: WsStreamSpec) -> InfraResult<()> {
        // Replace an existing task with the same id (idempotent restart).
        if let Some(old) = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&spec.watch_id)
        {
            let _ = old.cancel.send(true);
        }

        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let status = Arc::new(Mutex::new(StatusInner {
            state: "connecting".to_string(),
            detail: None,
            since_ms: now_ms(),
            last_event_ms: None,
            event_count: 0,
        }));

        let task = WatchTask {
            cancel: cancel_tx,
            status: status.clone(),
        };
        self.tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(spec.watch_id.clone(), task);

        let token_provider = self.token_provider.clone();
        let token_spec = self.token_spec(&spec);
        // Lazy sink read via the shared holder (not a snapshot) — the sink may be wired
        // after start() during boot restore, and capturing the holder avoids an Arc cycle.
        let sink_holder = self.sink.clone();
        let sink_getter: Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync> =
            Arc::new(move || sink_holder.lock().unwrap_or_else(|p| p.into_inner()).clone());

        tokio::spawn(watch_loop(
            spec,
            cancel_rx,
            status,
            token_provider,
            token_spec,
            sink_getter,
        ));
        Ok(())
    }

    async fn stop(&self, watch_id: &str) -> InfraResult<()> {
        if let Some(task) = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(watch_id)
        {
            let _ = task.cancel.send(true);
        }
        Ok(())
    }

    fn list(&self) -> Vec<WsStreamStatus> {
        self.tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(id, t)| {
                let s = t.status.lock().unwrap_or_else(|p| p.into_inner());
                WsStreamStatus {
                    watch_id: id.clone(),
                    state: s.state.clone(),
                    detail: s.detail.clone(),
                    since_ms: s.since_ms,
                    last_event_ms: s.last_event_ms,
                    event_count: s.event_count,
                }
            })
            .collect()
    }
}

// ── the long-lived task ─────────────────────────────────────────────────────

async fn watch_loop(
    spec: WsStreamSpec,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    status: Arc<Mutex<StatusInner>>,
    token_provider: Option<Arc<OAuthTokenProvider>>,
    token_spec: Option<(String, OAuthSpec, u64)>,
    sink_getter: Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync>,
) {
    let mut backoff_idx = 0usize;
    loop {
        if *cancel_rx.borrow() {
            break;
        }
        set_state(&status, "connecting", None);
        let session_started = Instant::now();
        match run_session(
            &spec,
            &mut cancel_rx,
            &status,
            &token_provider,
            &token_spec,
            &sink_getter,
        )
        .await
        {
            SessionEnd::Cancelled => break,
            SessionEnd::Dropped(reason) => {
                if session_started.elapsed() >= STABLE_SESSION {
                    backoff_idx = 0;
                }
                let wait = BACKOFF_STEPS_SEC[backoff_idx.min(BACKOFF_STEPS_SEC.len() - 1)];
                backoff_idx += 1;
                set_state(
                    &status,
                    "reconnecting",
                    Some(format!("{reason} — retry in {wait}s")),
                );
                tracing::warn!(
                    target: "ws_stream",
                    watch_id = %spec.watch_id,
                    reason = %reason,
                    retry_in_sec = wait,
                    "ws stream session dropped — will reconnect"
                );
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
                    _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
                }
            }
        }
    }
    set_state(&status, "stopped", None);
    tracing::info!(target: "ws_stream", watch_id = %spec.watch_id, "watch stopped");
}

enum SessionEnd {
    Cancelled,
    Dropped(String),
}

async fn run_session(
    spec: &WsStreamSpec,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    status: &Arc<Mutex<StatusInner>>,
    token_provider: &Option<Arc<OAuthTokenProvider>>,
    token_spec: &Option<(String, OAuthSpec, u64)>,
    sink_getter: &Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync>,
) -> SessionEnd {
    // Token (proactive per (re)connect). Present when a secret is declared in the LOGIN frame
    // (kiwoom) or at spec level (한투 approval_key — rides in the subscribe frame, no LOGIN).
    let needs_token = spec
        .login
        .as_ref()
        .map(|l| l.token_secret.is_some())
        .unwrap_or(false)
        || spec.token_secret.is_some();
    let token = if needs_token {
        let (Some(tp), Some((name, oauth, life))) = (token_provider, token_spec) else {
            return SessionEnd::Dropped("token provider/spec not wired".to_string());
        };
        match tp.ensure_fresh(name, oauth, *life, spec.mock, false).await {
            Ok(t) => Some(t),
            Err(e) => return SessionEnd::Dropped(format!("token refresh failed: {e}")),
        }
    } else {
        None
    };

    let connect = tokio::time::timeout(
        STEP_TIMEOUT,
        tokio_tungstenite::connect_async(&spec.endpoint),
    )
    .await;
    let mut ws = match connect {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => return SessionEnd::Dropped(format!("connect failed: {e}")),
        Err(_) => return SessionEnd::Dropped("connect timeout".to_string()),
    };

    // Login → preFrames → subscribe (each with a step budget).
    if let Some(login) = &spec.login {
        let frame = fill_token(&login.frame, token.as_deref());
        if let Err(e) = send(&mut ws, &frame).await {
            return SessionEnd::Dropped(e);
        }
        match exchange(&mut ws, spec, &login.response_match).await {
            Ok(resp) => {
                if let Some(rule) = &login.success_when {
                    if !field_eq(&resp, rule) {
                        return SessionEnd::Dropped(format!(
                            "login rejected: {}",
                            frame_error(&resp, spec)
                        ));
                    }
                }
            }
            Err(e) => return SessionEnd::Dropped(format!("login: {e}")),
        }
    }
    for pre in &spec.pre_frames {
        let frame = fill_token(&pre.frame, token.as_deref());
        if let Err(e) = send(&mut ws, &frame).await {
            return SessionEnd::Dropped(e);
        }
        if pre.response_match.is_empty() {
            continue;
        }
        match exchange(&mut ws, spec, &pre.response_match).await {
            Ok(resp) => {
                if let Some(rule) = &pre.success_when {
                    if !field_eq(&resp, rule) {
                        return SessionEnd::Dropped(format!(
                            "pre-frame {} rejected: {}",
                            pre.response_match,
                            frame_error(&resp, spec)
                        ));
                    }
                }
            }
            Err(e) => return SessionEnd::Dropped(format!("pre-frame: {e}")),
        }
    }
    // For 한투 (token_secret at spec level), the approval_key rides in the subscribe frame
    // header via `{TOKEN}`. kiwoom has no `{TOKEN}` here so fill_token is a no-op.
    let subscribe_frame = fill_token(&spec.subscribe_frame, token.as_deref());
    if let Err(e) = send(&mut ws, &subscribe_frame).await {
        return SessionEnd::Dropped(e);
    }
    // Captured from the subscribe ack for KIS 체결통보 (flag 1) — the ack body carries iv/key.
    let mut decrypt_keys: Option<(String, String)> = None;
    if !spec.subscribe_match.is_empty() {
        match exchange(&mut ws, spec, &spec.subscribe_match).await {
            Ok(resp) => {
                if let Some(rule) = &spec.subscribe_success {
                    if !field_eq(&resp, rule) {
                        return SessionEnd::Dropped(format!(
                            "subscribe rejected: {}",
                            frame_error(&resp, spec)
                        ));
                    }
                }
                // KIS ack carries the AES iv/key — capture (never forward: it's a secret).
                if let Some(dec) = &spec.decrypt {
                    decrypt_keys = capture_decrypt_keys(&resp, dec);
                    if decrypt_keys.is_none() {
                        tracing::warn!(
                            target: "ws_stream",
                            watch_id = %spec.watch_id,
                            "encrypted stream but subscribe ack had no iv/key — flag-1 frames will be skipped"
                        );
                    }
                }
                // For JSON providers the ack often carries the initial snapshot — forward it so
                // consumers start from full state. For KisPipe the ack is a control message
                // (and may hold the decrypt key), so it is never forwarded.
                if spec.frame_format == WsFrameFormat::Json {
                    if let Some(sink) = sink_getter() {
                        sink(spec, resp);
                    }
                }
            }
            Err(e) => return SessionEnd::Dropped(format!("subscribe: {e}")),
        }
    }

    set_state(status, "live", None);
    tracing::info!(
        target: "ws_stream",
        watch_id = %spec.watch_id,
        module = %spec.module,
        stream = %spec.stream,
        "ws stream live"
    );

    // Realtime loop — cancel-aware.
    loop {
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    if let Some(unsub) = &spec.unsubscribe_frame {
                        let _ = send(&mut ws, unsub).await; // best-effort
                    }
                    let _ = ws.close(None).await;
                    return SessionEnd::Cancelled;
                }
            }
            msg = ws.next() => {
                let msg = match msg {
                    None => return SessionEnd::Dropped("server closed".to_string()),
                    Some(Err(e)) => return SessionEnd::Dropped(format!("read failed: {e}")),
                    Some(Ok(m)) => m,
                };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => return SessionEnd::Dropped("server closed".to_string()),
                    _ => continue,
                };

                // 한투 positional realtime frame: `flag|TR_ID|count|f1^f2^…` (flag 1 = AES256).
                if spec.frame_format == WsFrameFormat::KisPipe && is_positional(&text) {
                    match decode_positional(&text, spec, &decrypt_keys) {
                        Some((tr_id, value)) => {
                            // One watch subscribes one TR — guard against a stray other-TR frame.
                            if !spec.realtime_match.is_empty() && tr_id != spec.realtime_match {
                                continue;
                            }
                            {
                                let mut s = status.lock().unwrap_or_else(|p| p.into_inner());
                                s.last_event_ms = Some(now_ms());
                                s.event_count += 1;
                            }
                            if let Some(sink) = sink_getter() {
                                sink(spec, value);
                            }
                        }
                        None => tracing::warn!(
                            target: "ws_stream",
                            watch_id = %spec.watch_id,
                            "positional realtime frame decode failed — skipped"
                        ),
                    }
                    continue;
                }

                // JSON frame (kiwoom REAL / 한투 PINGPONG or control).
                let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let Some(kind) = frame_get(&frame, &spec.match_field).and_then(|v| v.as_str()) else { continue };
                if spec.echo_values.iter().any(|e| e == kind) {
                    let _ = ws.send(Message::Text(text)).await;
                    continue;
                }
                if kind == spec.realtime_match {
                    {
                        let mut s = status.lock().unwrap_or_else(|p| p.into_inner());
                        s.last_event_ms = Some(now_ms());
                        s.event_count += 1;
                    }
                    if let Some(sink) = sink_getter() {
                        sink(spec, frame);
                    }
                    continue;
                }
                tracing::info!(
                    target: "ws_stream",
                    watch_id = %spec.watch_id,
                    frame_kind = %kind,
                    "skip unrelated stream frame"
                );
            }
        }
    }
}

async fn send<S>(ws: &mut S, frame: &serde_json::Value) -> Result<(), String>
where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    ws.send(Message::Text(frame.to_string()))
        .await
        .map_err(|e| format!("send failed: {e}"))
}

/// Wait (with the step budget) for a frame whose match-field equals `expected`; echoes
/// keepalive frames and skips everything else.
async fn exchange<S>(
    ws: &mut S,
    spec: &WsStreamSpec,
    expected: &str,
) -> Result<serde_json::Value, String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| format!("timeout waiting for {expected}"))?;
        let msg = tokio::time::timeout(left, ws.next())
            .await
            .map_err(|_| format!("timeout waiting for {expected}"))?
            .ok_or_else(|| format!("closed while waiting for {expected}"))?
            .map_err(|e| format!("read failed: {e}"))?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => return Err(format!("closed while waiting for {expected}")),
            _ => continue,
        };
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(kind) = frame_get(&frame, &spec.match_field).and_then(|v| v.as_str()) else {
            continue;
        };
        if spec.echo_values.iter().any(|e| e == kind) {
            let _ = ws.send(Message::Text(text)).await;
            continue;
        }
        if kind == expected {
            return Ok(frame);
        }
    }
}

// ── 한투 (KisPipe) positional realtime decode + AES256-CBC ───────────────────

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// A 한투 realtime frame is `flag|TR_ID|count|body` — flag is a single digit (0 plaintext /
/// 1 AES). Control frames (subscribe ack, PINGPONG) are JSON objects starting with `{`.
fn is_positional(text: &str) -> bool {
    text.starts_with("0|") || text.starts_with("1|")
}

/// Capture the AES iv/key from the subscribe ack (dot-paths). None when absent.
fn capture_decrypt_keys(ack: &serde_json::Value, dec: &WsDecryptSpec) -> Option<(String, String)> {
    let iv = frame_get(ack, &dec.iv_field)?.as_str()?.to_string();
    let key = frame_get(ack, &dec.key_field)?.as_str()?.to_string();
    if iv.is_empty() || key.is_empty() {
        return None;
    }
    Some((iv, key))
}

/// AES256-CBC decrypt (PKCS7) — KIS gives the raw ASCII iv (16) / key (32) in the ack, the
/// body is base64. Best-effort: any failure returns None (frame skipped, never crashes).
fn aes256_cbc_decrypt(b64: &str, iv: &str, key: &str) -> Option<String> {
    let ct = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let dec = Aes256CbcDec::new_from_slices(key.as_bytes(), iv.as_bytes()).ok()?;
    let pt = dec.decrypt_padded_vec_mut::<Pkcs7>(&ct).ok()?;
    String::from_utf8(pt).ok()
}

/// Decode `flag|TR_ID|count|f1^f2^…` → `(tr_id, {trId, count, records})`. `records` maps the
/// caret-delimited values onto `field_order` (from `_ws_apis.json` responseBody), chunked by
/// `count`. Flag 1 = decrypt the body first. Returns None on malformed/undecryptable frames.
fn decode_positional(
    text: &str,
    spec: &WsStreamSpec,
    keys: &Option<(String, String)>,
) -> Option<(String, serde_json::Value)> {
    let mut parts = text.splitn(4, '|');
    let flag = parts.next()?;
    let tr_id = parts.next()?.to_string();
    let count: usize = parts.next()?.trim().parse().unwrap_or(1);
    let body = parts.next().unwrap_or("");

    let plain = if flag == "1" {
        let (iv, key) = keys.as_ref()?; // encrypted but no key captured → skip
        aes256_cbc_decrypt(body, iv, key)?
    } else {
        body.to_string()
    };

    let values: Vec<&str> = plain.split('^').collect();
    let records = if spec.field_order.is_empty() {
        serde_json::Value::Array(
            values
                .iter()
                .map(|v| serde_json::Value::String((*v).to_string()))
                .collect(),
        )
    } else {
        let per = spec.field_order.len();
        let recs: Vec<serde_json::Value> = values
            .chunks(per)
            .map(|chunk| {
                let mut obj = serde_json::Map::new();
                for (i, name) in spec.field_order.iter().enumerate() {
                    if let Some(v) = chunk.get(i) {
                        obj.insert(name.clone(), serde_json::Value::String((*v).to_string()));
                    }
                }
                serde_json::Value::Object(obj)
            })
            .collect();
        serde_json::Value::Array(recs)
    };

    Some((
        tr_id.clone(),
        serde_json::json!({ "trId": tr_id, "count": count, "records": records }),
    ))
}

fn frame_error(frame: &serde_json::Value, spec: &WsStreamSpec) -> String {
    if let Some(field) = &spec.error_msg_field {
        if let Some(msg) = frame.get(field).and_then(|v| v.as_str()) {
            if !msg.trim().is_empty() {
                return msg.to_string();
            }
        }
    }
    coerce(frame).chars().take(300).collect()
}

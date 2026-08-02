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
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use crate::adapters::ws_api::{coerce, field_eq, fill_token, frame_get};

/// Per-handshake-step budget (connect / login / pre-frame / subscribe ack).
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
const BACKOFF_STEPS_SEC: &[u64] = &[5, 10, 20, 40, 60];
/// A session that stayed alive this long resets the reconnect backoff.
const STABLE_SESSION: Duration = Duration::from_secs(60);
/// start() waits this long for the first handshake outcome so a deterministic
/// subscribe NACK (bad args) fails the registration in-turn instead of spawning
/// a zombie that reconnects forever (2026-07-11: type="0" watch churned all night).
const FIRST_RESULT_TIMEOUT: Duration = Duration::from_secs(12);
/// Consecutive subscribe NACKs after which a previously-working watch gives up.
/// A NACK is an application-level rejection of our args — it will not heal by retrying.
const MAX_SUBSCRIBE_REJECTS: u32 = 3;

/// One-shot channel start() listens on for the first session outcome.
type FirstResultTx = tokio::sync::oneshot::Sender<Result<(), String>>;

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
    /// Read directly for locally signed JWTs. The token provider fetches and refreshes; a signed
    /// token is computed from keys we already hold, so it never goes near that machinery.
    vault: Option<Arc<dyn firebat_core::ports::IVaultPort>>,
    /// Shared holder — set after construction (main wires event bus + notify) and read
    /// lazily by watch tasks, so boot-restored watches see the sink once it's wired.
    sink: Arc<Mutex<Option<WsStreamSink>>>,
    tasks: Mutex<HashMap<String, WatchTask>>,
    /// Shared connections, keyed by endpoint + credential. Only modules that declare
    /// `ws.shareConnection` land here; everything else keeps a socket per watch.
    conns: Mutex<HashMap<String, ConnHandle>>,
    /// watch_id → connection key, so stop() knows which connection to unsubscribe from.
    watch_conn: Mutex<HashMap<String, String>>,
}

struct ConnHandle {
    cmd: tokio::sync::mpsc::UnboundedSender<ConnCmd>,
    cancel: tokio::sync::watch::Sender<bool>,
}

impl WsStreamAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            token_provider: None,
            vault: None,
            sink: Arc::new(Mutex::new(None)),
            tasks: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            watch_conn: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_vault(mut self, vault: Arc<dyn firebat_core::ports::IVaultPort>) -> Self {
        self.vault = Some(vault);
        self
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
        let vault = self.vault.clone();
        let token_spec = self.token_spec(&spec);
        // Lazy sink read via the shared holder (not a snapshot) — the sink may be wired
        // after start() during boot restore, and capturing the holder avoids an Arc cycle.
        let sink_holder = self.sink.clone();
        let sink_getter: Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync> =
            Arc::new(move || sink_holder.lock().unwrap_or_else(|p| p.into_inner()).clone());

        let watch_id = spec.watch_id.clone();
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        let member = Member {
            spec,
            status,
            first: Some(first_tx),
            rejects: 0,
        };
        if member.spec.share_connection {
            // One socket per endpoint + credential. The provider caps sessions per token, so a
            // second socket would evict the first; registrations stack on the one that exists.
            let key = conn_key(&member.spec);
            let mut conns = self.conns.lock().unwrap_or_else(|p| p.into_inner());
            let handle = conns.entry(key.clone()).or_insert_with(|| {
                let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
                let (conn_cancel_tx, conn_cancel_rx) = tokio::sync::watch::channel(false);
                tokio::spawn(conn_loop(
                    Vec::new(),
                    Some(cmd_rx),
                    conn_cancel_rx,
                    token_provider.clone(),
                    vault.clone(),
                    None,
                    sink_getter.clone(),
                ));
                ConnHandle {
                    cmd: cmd_tx,
                    cancel: conn_cancel_tx,
                }
            });
            if handle.cmd.send(ConnCmd::Add(member, token_spec)).is_err() {
                // The task died between lookup and send — drop the entry so the next start()
                // rebuilds it rather than talking to a closed channel forever.
                conns.remove(&key);
                drop(conns);
                self.tasks
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&watch_id);
                return Err("shared ws connection is gone — retry".to_string());
            }
            drop(conns);
            self.watch_conn
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(watch_id.clone(), key);
        } else {
            tokio::spawn(conn_loop(
                vec![member],
                None,
                cancel_rx,
                token_provider,
                vault,
                token_spec,
                sink_getter,
            ));
        }

        // Bounded wait for the first handshake outcome. A subscribe NACK is deterministic
        // (our args are wrong) — fail the registration so the caller (the model, in-turn)
        // gets the provider's error and can fix the args. Transient failures / slow networks
        // fall through on timeout and the watch keeps retrying as before.
        match tokio::time::timeout(FIRST_RESULT_TIMEOUT, first_rx).await {
            Ok(Ok(Err(reason))) => {
                self.tasks
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&watch_id);
                return Err(format!("stream subscribe rejected by provider: {reason}"));
            }
            _ => {} // live / still connecting / task ended — keep the watch registered.
        }
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
        // On a shared connection the socket outlives the watch: unsubscribe just this
        // registration and leave the others running.
        let key = self
            .watch_conn
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(watch_id);
        if let Some(key) = key {
            let mut conns = self.conns.lock().unwrap_or_else(|p| p.into_inner());
            let dead = match conns.get(&key) {
                Some(h) => h.cmd.send(ConnCmd::Remove(watch_id.to_string())).is_err(),
                None => false,
            };
            if dead {
                if let Some(h) = conns.remove(&key) {
                    let _ = h.cancel.send(true);
                }
            }
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

/// One watch attached to a connection. A private connection holds exactly one; a shared one holds
/// every watch that landed on the same endpoint + credential.
struct Member {
    spec: WsStreamSpec,
    status: Arc<Mutex<StatusInner>>,
    first: Option<FirstResultTx>,
    /// Consecutive subscribe rejections for this registration alone — a NACK is the provider
    /// refusing these args, so it must not take the shared socket (or its neighbours) down.
    rejects: u32,
}

/// What a running shared connection accepts. Registrations arrive and leave while the socket
/// stays up, which is the whole point: reconnecting to add a symbol would evict the session.
enum ConnCmd {
    Add(Member, Option<(String, OAuthSpec, u64)>),
    Remove(String),
}

/// Connections are shared per endpoint + credential. Endpoint matters because a provider can serve
/// several markets on separate paths, and the credential because the session cap is per token.
fn conn_key(spec: &WsStreamSpec) -> String {
    let cred = spec
        .login
        .as_ref()
        .and_then(|l| l.token_secret.as_deref())
        .or(spec.token_secret.as_deref())
        .unwrap_or("-");
    format!("{}|{}|{}", spec.endpoint, cred, spec.mock)
}

/// Which records of a realtime frame belong to this watch — `None` when none do. A watch that
/// declares no routing path gets the frame untouched, which is how a private connection and every
/// non-JSON dialect keep behaving exactly as before.
fn route_frame(frame: &serde_json::Value, spec: &WsStreamSpec) -> Option<serde_json::Value> {
    let Some(item_path) = &spec.route_item_path else {
        return Some(frame.clone());
    };
    let Some(records) = frame.get("data").and_then(|d| d.as_array()) else {
        return Some(frame.clone());
    };
    let matches = |rec: &serde_json::Value, path: &Option<String>, want: &[String]| -> bool {
        // No expectation declared = the provider ignores this axis for the type (account-scoped
        // and market-wide broadcasts), so everything on it is ours.
        if want.is_empty() {
            return true;
        }
        match path
            .as_ref()
            .and_then(|p| frame_get(rec, p))
            .and_then(|v| v.as_str())
        {
            Some(v) => want.iter().any(|w| w == v),
            None => true, // record does not carry the field — do not silently drop it
        }
    };
    let keep: Vec<serde_json::Value> = records
        .iter()
        .filter(|r| {
            matches(r, &Some(item_path.clone()), &spec.subscribe_items)
                && matches(r, &spec.route_type_path, &spec.subscribe_types)
        })
        .cloned()
        .collect();
    if keep.is_empty() {
        return None;
    }
    let mut out = frame.clone();
    if let Some(o) = out.as_object_mut() {
        o.insert("data".into(), serde_json::Value::Array(keep));
    }
    Some(out)
}

/// A JWT signed here and now, from a key pair in the vault.
///
/// Not the same thing as the OAuth token beside it, though both are called tokens: that one is
/// issued by the venue and has to be asked for and refreshed, this one is arithmetic over keys we
/// already hold and is valid the moment it exists. Upbit authenticates its private streams with
/// it on the handshake, so without this the fill and balance streams are unreachable — the only
/// route left is polling, which is how a stop ends up five minutes late.
fn sign_ws_jwt(
    spec: &firebat_core::ports::WsJwtSpec,
    vault: &dyn firebat_core::ports::IVaultPort,
) -> Result<String, String> {
    let read = |name: &str| -> Result<String, String> {
        vault
            .get_secret(&format!("user:{name}"))
            .or_else(|| vault.get_secret(name))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("vault 에 {name} 이 없습니다"))
    };
    let access = read(&spec.access_key_secret)?;
    let secret = read(&spec.secret_key_secret)?;
    let alg = match spec.algorithm.to_uppercase().as_str() {
        "HS256" => jsonwebtoken::Algorithm::HS256,
        "HS384" => jsonwebtoken::Algorithm::HS384,
        "HS512" => jsonwebtoken::Algorithm::HS512,
        other => return Err(format!("지원하지 않는 서명 알고리즘: {other}")),
    };
    let mut claims = serde_json::Map::new();
    claims.insert(spec.access_claim.clone(), serde_json::Value::String(access));
    claims.insert(
        spec.nonce_claim.clone(),
        serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
    );
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(alg),
        &serde_json::Value::Object(claims),
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("JWT 서명 실패: {e}"))
}


async fn conn_loop(
    mut members: Vec<Member>,
    mut cmd_rx: Option<tokio::sync::mpsc::UnboundedReceiver<ConnCmd>>,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    token_provider: Option<Arc<OAuthTokenProvider>>,
    vault: Option<Arc<dyn firebat_core::ports::IVaultPort>>,
    mut token_spec: Option<(String, OAuthSpec, u64)>,
    sink_getter: Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync>,
) {
    let mut backoff_idx = 0usize;
    let mut consecutive_rejects = 0u32;
    let mut failed = false;
    // Login/token rejection (e.g. kiwoom CODE=8005 "Token이 유효하지 않습니다") — the cached
    // token was revoked server-side while still TTL-fresh, so a plain reconnect re-sends the
    // SAME stale token forever (2026-07-13 실측: 3 watches 가 밤새 60s 8005 루프). The next
    // attempt must FORCE-refresh the token; if the forced token is also rejected repeatedly,
    // give up like subscribe rejects (it will not heal by retrying).
    let mut force_token = false;
    loop {
        if *cancel_rx.borrow() {
            break;
        }
        // A shared connection outlives its registrations. With none left, hold the socket closed
        // and wait instead of reconnecting on a timer to serve nobody.
        if members.is_empty() {
            let Some(rx) = cmd_rx.as_mut() else { break };
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    None => break,
                    Some(ConnCmd::Add(m, ts)) => {
                        if token_spec.is_none() {
                            token_spec = ts;
                        }
                        members.push(m);
                    }
                    Some(ConnCmd::Remove(_)) => {}
                },
                _ = cancel_rx.changed() => { if *cancel_rx.borrow() { break; } }
            }
            continue;
        }
        for m in members.iter() {
            set_state(&m.status, "connecting", None);
        }
        let session_started = Instant::now();
        match run_session(
            &mut members,
            &mut cmd_rx,
            &mut cancel_rx,
            &token_provider,
            &vault,
            &mut token_spec,
            &sink_getter,
            std::mem::take(&mut force_token),
        )
        .await
        {
            SessionEnd::Cancelled => break,
            SessionEnd::Dropped(reason) => {
                // Subscribe rejections are handled per registration inside the session — only
                // login and transport failures reach here, and those are connection-wide.
                let is_login_reject = reason.starts_with("login rejected");
                if is_login_reject {
                    force_token = true;
                }
                consecutive_rejects = if is_login_reject { consecutive_rejects + 1 } else { 0 };
                if is_login_reject && consecutive_rejects >= MAX_SUBSCRIBE_REJECTS {
                    // Forced refresh already tried between attempts — the credential itself
                    // is bad. Stop the churn; the user fixes the key and restarts the watch.
                    for m in members.iter_mut() {
                        set_state(&m.status, "failed", Some(reason.clone()));
                        if let Some(tx) = m.first.take() {
                            let _ = tx.send(Err(reason.clone()));
                        }
                    }
                    failed = true;
                    tracing::error!(
                        target: "ws_stream",
                        reason = %reason,
                        attempts = consecutive_rejects,
                        "ws connection giving up — login/token repeatedly rejected even after forced refresh"
                    );
                    break;
                }
                if session_started.elapsed() >= STABLE_SESSION {
                    backoff_idx = 0;
                }
                let wait = BACKOFF_STEPS_SEC[backoff_idx.min(BACKOFF_STEPS_SEC.len() - 1)];
                backoff_idx += 1;
                for m in members.iter() {
                    set_state(
                        &m.status,
                        "reconnecting",
                        Some(format!("{reason} — retry in {wait}s")),
                    );
                }
                tracing::warn!(
                    target: "ws_stream",
                    watches = members.len(),
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
    if !failed {
        for m in members.iter() {
            set_state(&m.status, "stopped", None);
        }
    }
    tracing::info!(target: "ws_stream", "ws connection closed");
}

/// Hand a realtime payload to every registration it belongs to. On a shared socket one frame can
/// be nobody's, one watch's, or several — routing decides, and each watch decodes with its own
/// declarations so a shared socket looks no different from a private one downstream.
fn deliver(
    members: &[Member],
    sink_getter: &Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync>,
    kind: &str,
    frame: &serde_json::Value,
    decorate: bool,
) {
    let Some(sink) = sink_getter() else { return };
    for m in members {
        if !m.spec.realtime_match.is_empty() && m.spec.realtime_match != kind {
            continue;
        }
        let Some(mine) = route_frame(frame, &m.spec) else {
            continue;
        };
        {
            let mut s = m.status.lock().unwrap_or_else(|p| p.into_inner());
            s.last_event_ms = Some(now_ms());
            s.event_count += 1;
        }
        let payload = if decorate {
            decorate_realtime_frame(&m.spec, mine)
        } else {
            mine
        };
        sink(&m.spec, payload);
    }
}

/// Pending-forever when a connection takes no commands (the private case), so `select!` can hold
/// the branch without a second code path.
async fn recv_cmd(
    rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<ConnCmd>>,
) -> Option<ConnCmd> {
    match rx.as_mut() {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

enum SessionEnd {
    Cancelled,
    Dropped(String),
}

async fn run_session(
    members: &mut Vec<Member>,
    cmd_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<ConnCmd>>,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    token_provider: &Option<Arc<OAuthTokenProvider>>,
    vault: &Option<Arc<dyn firebat_core::ports::IVaultPort>>,
    token_spec_slot: &mut Option<(String, OAuthSpec, u64)>,
    sink_getter: &Arc<dyn Fn() -> Option<WsStreamSink> + Send + Sync>,
    force_token: bool,
) -> SessionEnd {
    // Connection-level settings (endpoint, login, keepalive, wire format) belong to the socket, not
    // to any one registration - sharing requires them to agree, which the connection key ensures.
    let conn_spec = members[0].spec.clone();
    let spec = &conn_spec;
    let token_spec = &*token_spec_slot;
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
        match tp.ensure_fresh(name, oauth, *life, spec.mock, force_token, spec.account.as_deref()).await {
            Ok(t) => Some(t),
            Err(e) => return SessionEnd::Dropped(format!("token refresh failed: {e}")),
        }
    } else {
        None
    };

    // Handshake headers, when the venue authenticates there rather than with a frame. Built
    // before connecting because a signed token is one of them: Upbit reads `Authorization` on the
    // upgrade request and closes the socket without it.
    let mut request = match spec.endpoint.clone().into_client_request() {
        Ok(r) => r,
        Err(e) => return SessionEnd::Dropped(format!("endpoint is not a websocket url: {e}")),
    };
    if let Some(headers) = spec.login.as_ref().and_then(|l| l.headers.as_ref()) {
        let jwt = match spec.login.as_ref().and_then(|l| l.jwt.as_ref()) {
            Some(js) => {
                let Some(v) = vault.as_ref() else {
                    return SessionEnd::Dropped("vault not wired for signed handshake".to_string());
                };
                match sign_ws_jwt(js, v.as_ref()) {
                    Ok(t) => Some(t),
                    Err(e) => return SessionEnd::Dropped(format!("handshake auth: {e}")),
                }
            }
            None => None,
        };
        for (name, template) in headers {
            let value = template
                .replace("{TOKEN}", token.as_deref().unwrap_or(""))
                .replace("{JWT}", jwt.as_deref().unwrap_or(""));
            let (Ok(hn), Ok(hv)) = (
                tungstenite::http::header::HeaderName::try_from(name.as_str()),
                tungstenite::http::HeaderValue::from_str(&value),
            ) else {
                return SessionEnd::Dropped(format!("handshake header '{name}' is not valid"));
            };
            request.headers_mut().insert(hn, hv);
        }
    }

    let connect = tokio::time::timeout(
        STEP_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await;
    let mut ws = match connect {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => return SessionEnd::Dropped(format!("connect failed: {e}")),
        Err(_) => return SessionEnd::Dropped("connect timeout".to_string()),
    };

    // Login → preFrames → subscribe (each with a step budget).
    if let Some((login, login_frame)) = spec
        .login
        .as_ref()
        .and_then(|l| l.frame.as_ref().map(|f| (l, f)))
    {
        let frame = fill_token(login_frame, token.as_deref());
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
    // One subscribe frame per registration. A rejection is the provider refusing *those* args, so
    // it removes that watch alone - its neighbours on the socket keep their ticks.
    // Korea Investment carries its approval key in the subscribe frame header via a token
    // placeholder; kiwoom has none there, so filling it is a no-op.
    let mut decrypt_keys: Option<(String, String)> = None;
    let mut drop_ids: Vec<String> = Vec::new();
    for idx in 0..members.len() {
        let msp = members[idx].spec.clone();
        let frame = fill_token(&msp.subscribe_frame, token.as_deref());
        if let Err(e) = send(&mut ws, &frame).await {
            return SessionEnd::Dropped(e);
        }
        if msp.subscribe_match.is_empty() {
            continue;
        }
        match exchange(&mut ws, &msp, &msp.subscribe_match).await {
            Ok(resp) => {
                if let Some(rule) = &msp.subscribe_success {
                    if !field_eq(&resp, rule) {
                        let reason = format!("subscribe rejected: {}", frame_error(&resp, &msp));
                        let m = &mut members[idx];
                        m.rejects += 1;
                        // A first attempt is reported to start() and abandoned: the args are wrong
                        // and retrying cannot fix them. A watch that used to work gets a few
                        // reconnects before being given up on.
                        let give_up = m.first.is_some() || m.rejects >= MAX_SUBSCRIBE_REJECTS;
                        if let Some(tx) = m.first.take() {
                            let _ = tx.send(Err(reason.clone()));
                        }
                        if give_up {
                            set_state(&m.status, "failed", Some(reason.clone()));
                            drop_ids.push(msp.watch_id.clone());
                            tracing::error!(
                                target: "ws_stream", watch_id = %msp.watch_id,
                                reason = %reason, attempts = m.rejects,
                                "ws stream giving up - subscribe rejected (fix the watch args and restart it)"
                            );
                        }
                        continue;
                    }
                }
                members[idx].rejects = 0;
                // KIS ack carries the AES iv/key - capture it, never forward it: that is a secret.
                if let Some(dec) = &msp.decrypt {
                    decrypt_keys = capture_decrypt_keys(&resp, dec);
                    if decrypt_keys.is_none() {
                        tracing::warn!(
                            target: "ws_stream",
                            watch_id = %msp.watch_id,
                            "encrypted stream but subscribe ack had no iv/key - flag-1 frames will be skipped"
                        );
                    }
                }
                // For JSON providers the ack often carries the initial snapshot - forward it so
                // consumers start from full state. For KisPipe the ack is a control message
                // (and may hold the decrypt key), so it is never forwarded.
                if msp.frame_format == WsFrameFormat::Json {
                    if let Some(sink) = sink_getter() {
                        sink(&msp, resp);
                    }
                }
            }
            Err(e) => return SessionEnd::Dropped(format!("subscribe: {e}")),
        }
    }
    members.retain(|m| !drop_ids.contains(&m.spec.watch_id));
    if members.is_empty() {
        let _ = ws.close(None).await;
        return SessionEnd::Cancelled;
    }

    for m in members.iter_mut() {
        set_state(&m.status, "live", None);
        // First successful subscribe - release start() (registration confirmed good).
        if let Some(tx) = m.first.take() {
            let _ = tx.send(Ok(()));
        }
    }
    tracing::info!(
        target: "ws_stream",
        watch_id = %spec.watch_id,
        module = %spec.module,
        stream = %spec.stream,
        "ws stream live"
    );

    // Skipped-frame shapes seen on this connection, capped per kind. We log only `frame_kind`
    // today, which is exactly why a live watch that delivered ZERO ticks could not be diagnosed:
    // kiwoom quotes stayed connected and every frame was skipped as `SYSTEM`, and with no body we
    // cannot tell whether that is a notice frame or misclassified tick data (2026-07-28 실측 —
    // 삼성 1분봉 페이지의 라이브 배지가 죽어 있던 원인). Preview the first few per kind so the next
    // market session answers it; capped so a burst cannot flood the journal.
    let mut skipped_seen: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    // Liveness proof. Without this, "the loop is alive and nothing arrives" and "the loop is stuck"
    // look the same in the journal — both are simply no log lines (2026-07-29 실측: subscribe acked,
    // connection open, zero frames for minutes). A periodic line separates them, and after a healthy
    // session it also shows the arrival rate.
    let mut frames_seen: u64 = 0;
    // Frame count at the previous beat — a beat is only worth INFO when nothing arrived since.
    let mut frames_at_last_beat: u64 = 0;
    let mut hb = tokio::time::interval(std::time::Duration::from_secs(60));
    hb.tick().await; // fire immediately once, then every 60s

    // Realtime loop — cancel-aware.
    loop {
        tokio::select! {
            _ = hb.tick() => {
                // A healthy beat says nothing new, and one line per minute per socket is not free:
                // measured 2026-07-31, heartbeats alone were a third of the 20,000-line admin ring.
                // So the loud beat is the one where NOTHING arrived — that is the case worth seeing,
                // and it is what distinguishes "alive but silent" from "stuck". A beat that carries
                // frames stays at debug, where the arrival rate is still there when asked for.
                let arrived = frames_seen.saturating_sub(frames_at_last_beat);
                if arrived == 0 {
                    tracing::info!(
                        target: "ws_stream",
                        watches = members.len(),
                        frames_seen,
                        "ws heartbeat — no frames in the last minute"
                    );
                } else {
                    tracing::debug!(
                        target: "ws_stream",
                        watches = members.len(),
                        frames_seen,
                        arrived,
                        "ws heartbeat"
                    );
                }
                frames_at_last_beat = frames_seen;
            }
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    // Every registration gets its own unsubscribe. The token must be filled here
                    // too: Korea Investment carries its approval key in every frame header, so an
                    // unsubscribe is rejected, and best-effort means that failure is silent -
                    // which is exactly how it went unnoticed.
                    for m in members.iter() {
                        if let Some(unsub) = &m.spec.unsubscribe_frame {
                            let frame = fill_token(unsub, token.as_deref());
                            let _ = send(&mut ws, &frame).await;
                        }
                    }
                    let _ = ws.close(None).await;
                    return SessionEnd::Cancelled;
                }
            }
            // Registrations arriving or leaving while the socket is up. Reconnecting to add a
            // symbol is not an option: the provider caps sessions per token, so a fresh socket
            // would evict this one and every watch on it.
            cmd = recv_cmd(cmd_rx) => {
                match cmd {
                    None => return SessionEnd::Cancelled,
                    Some(ConnCmd::Add(m, ts)) => {
                        if token_spec_slot.is_none() {
                            *token_spec_slot = ts;
                        }
                        let frame = fill_token(&m.spec.subscribe_frame, token.as_deref());
                        let wid = m.spec.watch_id.clone();
                        members.push(m);
                        if let Err(e) = send(&mut ws, &frame).await {
                            return SessionEnd::Dropped(e);
                        }
                        tracing::info!(
                            target: "ws_stream", watch_id = %wid, watches = members.len(),
                            "ws registration added to the live socket"
                        );
                        // The ack is picked up by the frame loop below rather than waited for
                        // inline: a blocking wait would swallow the realtime frames that arrive
                        // in between, and those are the ones we exist to deliver.
                    }
                    Some(ConnCmd::Remove(watch_id)) => {
                        if let Some(pos) = members.iter().position(|m| m.spec.watch_id == watch_id) {
                            let gone = members.remove(pos);
                            if let Some(unsub) = &gone.spec.unsubscribe_frame {
                                let frame = fill_token(unsub, token.as_deref());
                                let _ = send(&mut ws, &frame).await;
                            }
                            set_state(&gone.status, "stopped", None);
                        }
                        if members.is_empty() {
                            let _ = ws.close(None).await;
                            return SessionEnd::Cancelled;
                        }
                    }
                }
            }
            msg = ws.next() => {
                let msg = match msg {
                    None => return SessionEnd::Dropped("server closed".to_string()),
                    Some(Err(e)) => return SessionEnd::Dropped(format!("read failed: {e}")),
                    Some(Ok(m)) => m,
                };
                frames_seen += 1;
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => return SessionEnd::Dropped("server closed".to_string()),
                    // Third silent path: Binary / Ping / Pong were dropped with no log at all, so a
                    // broker pushing binary payloads looked identical to a broker pushing nothing
                    // (2026-07-29: both brokers silent, zero log lines of any kind). Name the type.
                    other => {
                        let kind = match other {
                            Message::Binary(_) => "binary",
                            Message::Ping(_) => "ping",
                            Message::Pong(_) => "pong",
                            _ => "other",
                        };
                        let seen = skipped_seen.entry(format!("<{kind}>")).or_insert(0);
                        *seen += 1;
                        if *seen <= 3 {
                            tracing::info!(
                                target: "ws_stream", watch_id = %spec.watch_id,
                                msg_kind = kind, seen = *seen,
                                "frame dropped: not a text message"
                            );
                        }
                        continue;
                    }
                };

                // 한투 positional realtime frame: `flag|TR_ID|count|f1^f2^…` (flag 1 = AES256).
                if spec.frame_format == WsFrameFormat::KisPipe && is_positional(&text) {
                    match decode_positional(&text, spec, &decrypt_keys) {
                        Some((tr_id, value)) => {
                            // One watch subscribes one TR — guard against a stray other-TR frame.
                            if !spec.realtime_match.is_empty() && tr_id != spec.realtime_match {
                                continue;
                            }
                            deliver(members, sink_getter, &tr_id, &value, false);
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
                // **소리 없이 버리던 두 경로** — JSON 파싱 실패, match_field 부재. 로그가 없어서
                // "프레임이 안 온다"와 "와도 우리가 못 읽는다"를 구분할 수 없었다(2026-07-29 장중:
                // 구독 성공 후 ws_stream 로그가 0줄인데 틱도 0개). 앞 몇 건만 본문과 함께 남긴다.
                let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
                    let seen = skipped_seen.entry("<non-json>".to_string()).or_insert(0);
                    *seen += 1;
                    if *seen <= 3 {
                        tracing::info!(
                            target: "ws_stream", watch_id = %spec.watch_id, seen = *seen,
                            body = %text.chars().take(400).collect::<String>(),
                            "frame dropped: not JSON"
                        );
                    }
                    continue;
                };
                let Some(kind) = frame_get(&frame, &spec.match_field).and_then(|v| v.as_str()) else {
                    let seen = skipped_seen.entry("<no-match-field>".to_string()).or_insert(0);
                    *seen += 1;
                    if *seen <= 3 {
                        tracing::info!(
                            target: "ws_stream", watch_id = %spec.watch_id, seen = *seen,
                            match_field = %spec.match_field,
                            body = %text.chars().take(400).collect::<String>(),
                            "frame dropped: no match field"
                        );
                    }
                    continue;
                };
                if spec.echo_values.iter().any(|e| e == kind) {
                    let _ = ws.send(Message::Text(text)).await;
                    continue;
                }
                if members.iter().any(|m| m.spec.realtime_match == kind) {
                    deliver(members, sink_getter, kind, &frame, true);
                    continue;
                }
                // Ack for a registration added mid-session (see the Add command above). Resolving
                // it here keeps the frame loop running while we wait.
                if members.iter().any(|m| m.spec.subscribe_match == kind) {
                    let rule = members
                        .iter()
                        .find(|m| m.spec.subscribe_match == kind)
                        .and_then(|m| m.spec.subscribe_success.clone());
                    let ok = rule.map(|r| field_eq(&frame, &r)).unwrap_or(true);
                    let reason = if ok {
                        None
                    } else {
                        Some(format!("subscribe rejected: {}", frame_error(&frame, spec)))
                    };
                    let pending: Vec<String> = members
                        .iter()
                        .filter(|m| m.first.is_some())
                        .map(|m| m.spec.watch_id.clone())
                        .collect();
                    for m in members.iter_mut().filter(|m| m.first.is_some()) {
                        if let Some(tx) = m.first.take() {
                            let _ = tx.send(match &reason {
                                None => Ok(()),
                                Some(r) => Err(r.clone()),
                            });
                        }
                        set_state(&m.status, if ok { "live" } else { "failed" }, reason.clone());
                    }
                    // A rejected registration must come off the socket: it will never receive a
                    // frame, and leaving it in place would route ticks to a dead watch.
                    if !ok {
                        members.retain(|m| !pending.contains(&m.spec.watch_id));
                        if members.is_empty() {
                            let _ = ws.close(None).await;
                            return SessionEnd::Cancelled;
                        }
                    }
                    continue;
                }
                let seen = skipped_seen.entry(kind.to_string()).or_insert(0);
                *seen += 1;
                if *seen <= 3 {
                    tracing::info!(
                        target: "ws_stream",
                        watch_id = %spec.watch_id,
                        frame_kind = %kind,
                        expected = %spec.realtime_match,
                        seen = *seen,
                        body = %text.chars().take(400).collect::<String>(),
                        "skip unrelated stream frame"
                    );
                } else if *seen == 4 {
                    tracing::info!(
                        target: "ws_stream",
                        watch_id = %spec.watch_id,
                        frame_kind = %kind,
                        "skip unrelated stream frame (further ones suppressed)"
                    );
                }
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
/// Declarative realtime-frame decode (config `fieldLabels` / `chartField`) — kiwoom REAL
/// values are fid-code keyed ("10": "+333000"), unreadable in the live feed and unguessable
/// for live_chart's valueField dot-path (2026-07-13 실측: 피드 = raw JSON, 차트 = 영영 틱
/// 대기). Attach per-item `labeled` maps and a top-level numeric `value` (live_chart's
/// DEFAULT valueField). Raw values stay untouched; specs without the config are pass-through.
fn decorate_realtime_frame(
    spec: &WsStreamSpec,
    mut frame: serde_json::Value,
) -> serde_json::Value {
    if spec.field_labels.is_empty()
        && spec.chart_field.is_none()
        && spec.chart_volume_field.is_none()
        && spec.chart_change_field.is_none()
        && spec.chart_session_field.is_none()
        && spec.chart_time_field.is_none()
        && spec.chart_day_volume_field.is_none()
    {
        return frame;
    }
    let mut chart_value: Option<f64> = None;
    // Per-tick traded quantity summed across the frame's records — one REAL frame can carry
    // several fills, and dropping the extras would undercount the bar.
    let mut vol_tick: Option<f64> = None;
    let mut change: Option<f64> = None;
    let mut change_rate: Option<f64> = None;
    // Regular session or not, per the exchange's own marker. None when the frame omits it — an
    // unknown session must not silently drop ticks, so consumers treat absence as "chart it".
    let mut regular_session: Option<bool> = None;
    // The exchange's clock for this print: HHmmss, with the trading date alongside it when the
    // type carries one (a US session spans midnight KST, so the date cannot be assumed).
    let mut tick_time: Option<String> = None;
    // Cumulative volume for the session, straight from the exchange.
    let mut day_volume: Option<f64> = None;
    if let Some(items) = frame.get_mut("data").and_then(|d| d.as_array_mut()) {
        for item in items.iter_mut() {
            let Some(values) = item.get("values").and_then(|v| v.as_object()).cloned() else {
                continue;
            };
            if let Some(cf) = &spec.chart_field {
                if chart_value.is_none() {
                    if let Some(raw) = values.get(cf.as_str()).and_then(|v| v.as_str()) {
                        let cleaned: String = raw
                            .chars()
                            .filter(|c| c.is_ascii_digit() || *c == '-' || *c == '.')
                            .collect();
                        if let Ok(n) = cleaned.parse::<f64>() {
                            // kiwoom price sign = 등락 방향, not a negative price.
                            chart_value = Some(if spec.chart_abs { n.abs() } else { n });
                        }
                    }
                }
            }
            if let Some(df) = &spec.chart_day_volume_field {
                if day_volume.is_none() {
                    if let Some(raw) = values.get(df.as_str()).and_then(|v| v.as_str()) {
                        let cleaned: String =
                            raw.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
                        if let Ok(n) = cleaned.parse::<f64>() {
                            day_volume = Some(n);
                        }
                    }
                }
            }
            if let Some(tf) = &spec.chart_time_field {
                if tick_time.is_none() {
                    if let Some(t) = values.get(tf.as_str()).and_then(|v| v.as_str()) {
                        let t = t.trim();
                        if t.len() >= 6 && t.chars().all(|c| c.is_ascii_digit()) {
                            let date = spec
                                .chart_date_field
                                .as_ref()
                                .and_then(|df| values.get(df.as_str()))
                                .and_then(|v| v.as_str())
                                .map(|d| d.trim())
                                .filter(|d| d.len() == 8 && d.chars().all(|c| c.is_ascii_digit()));
                            tick_time = Some(match date {
                                Some(d) => format!("{d}{t}"),
                                None => t.to_string(),
                            });
                        }
                    }
                }
            }
            if let Some(sf) = &spec.chart_session_field {
                if regular_session.is_none() {
                    if let Some(raw) = values.get(sf.as_str()).and_then(|v| v.as_str()) {
                        let code = raw.trim();
                        if !code.is_empty() {
                            regular_session =
                                Some(spec.chart_session_regular.iter().any(|r| r == code));
                        }
                    }
                }
            }
            if let Some(vf) = &spec.chart_volume_field {
                if let Some(raw) = values.get(vf.as_str()).and_then(|v| v.as_str()) {
                    let cleaned: String = raw
                        .chars()
                        .filter(|c| c.is_ascii_digit() || *c == '.')
                        .collect();
                    if let Ok(n) = cleaned.parse::<f64>() {
                        // Sign on kiwoom quantities marks 매수/매도 방향, not a negative count.
                        *vol_tick.get_or_insert(0.0) += n;
                    }
                }
            }
            // 전일대비·등락율은 **부호가 의미**라 절대값을 취하지 않는다(가격과 반대).
            for (fieldopt, slot) in [
                (&spec.chart_change_field, &mut change),
                (&spec.chart_change_rate_field, &mut change_rate),
            ] {
                if slot.is_some() {
                    continue;
                }
                if let Some(f) = fieldopt {
                    if let Some(raw) = values.get(f.as_str()).and_then(|v| v.as_str()) {
                        let cleaned: String = raw
                            .chars()
                            .filter(|c| c.is_ascii_digit() || *c == '-' || *c == '+' || *c == '.')
                            .collect();
                        if let Ok(n) = cleaned.trim_start_matches('+').parse::<f64>() {
                            *slot = Some(n);
                        }
                    }
                }
            }
            if !spec.field_labels.is_empty() {
                let mut labeled = serde_json::Map::new();
                for (code, label) in &spec.field_labels {
                    if let Some(v) = values.get(code.as_str()) {
                        labeled.insert(label.clone(), v.clone());
                    }
                }
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("labeled".into(), serde_json::Value::Object(labeled));
                }
            }
        }
    }
    if let Some(obj) = frame.as_object_mut() {
        if let Some(n) = chart_value {
            obj.insert("value".into(), serde_json::json!(n));
        }
        if let Some(v) = vol_tick {
            obj.insert("volumeTick".into(), serde_json::json!(v));
        }
        if let Some(v) = day_volume {
            obj.insert("dayVolume".into(), serde_json::json!(v));
        }
        if let Some(v) = &tick_time {
            obj.insert("tickTime".into(), serde_json::json!(v));
        }
        if let Some(v) = regular_session {
            obj.insert("regularSession".into(), serde_json::json!(v));
        }
        if let Some(v) = change {
            obj.insert("change".into(), serde_json::json!(v));
        }
        if let Some(v) = change_rate {
            obj.insert("changeRate".into(), serde_json::json!(v));
        }
    }
    frame
}

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
    if values.is_empty() {
        return None;
    }
    // Record width comes from the FRAME (`건수`), never from `field_order.len()`. The vendor doc's
    // field table drifts from the wire in both directions (실측: 국내주식 호가 responseBody 62 vs
    // 예시 59 / 국내지수 예상체결 30 vs 15 / 야간선물 호가 38 vs 46). Chunking by the doc's field
    // count would then mis-split records — a silently corrupted feed. Deriving the width from the
    // frame keeps record boundaries exact; names are applied positionally as far as they go, and
    // any surplus value is preserved under `field_<i>` instead of being dropped.
    let per = if count > 0 && values.len() % count == 0 {
        values.len() / count
    } else {
        values.len() // 건수 가 프레임과 안 맞으면 통째로 한 레코드 (경계 날조 금지)
    };
    let names = &spec.field_order;
    if !names.is_empty() && per != names.len() {
        tracing::warn!(
            target: "ws_stream",
            watch_id = %spec.watch_id,
            tr_id = %tr_id,
            frame_width = per,
            doc_fields = names.len(),
            "positional field-count drift — mapping by frame width (doc `_ws_apis.json` responseBody is stale)"
        );
    }
    let recs: Vec<serde_json::Value> = values
        .chunks(per)
        .map(|chunk| {
            let mut obj = serde_json::Map::new();
            for (i, v) in chunk.iter().enumerate() {
                let key = match names.get(i) {
                    Some(n) => n.clone(),
                    None => format!("field_{i}"),
                };
                obj.insert(key, serde_json::Value::String((*v).to_string()));
            }
            serde_json::Value::Object(obj)
        })
        .collect();

    Some((
        tr_id.clone(),
        serde_json::json!({ "trId": tr_id, "count": count, "records": serde_json::Value::Array(recs) }),
    ))
}

fn frame_error(frame: &serde_json::Value, spec: &WsStreamSpec) -> String {
    if let Some(field) = &spec.error_msg_field {
        // dot-path — 한투 declares `body.msg1`; a plain `.get()` never resolved it, so a rejected
        // subscribe surfaced as a raw frame dump instead of "SUBSCRIBE FAIL <reason>".
        if let Some(msg) = frame_get(frame, field).and_then(|v| v.as_str()) {
            if !msg.trim().is_empty() {
                return msg.to_string();
            }
        }
    }
    coerce(frame).chars().take(300).collect()
}

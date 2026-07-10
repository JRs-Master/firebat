//! ModuleManager — 시스템 / 사용자 모듈 목록 + 실행 + 설정.
//!
//! 옛 TS ModuleManager (`core/managers/module-manager.ts`) Rust 재구현 (Phase B core 부분).
//! 책임:
//!  - listSystem / listUserModules — Storage scan
//!  - run / execute — Sandbox spawn
//!  - getModuleConfig — config.json 직접 파싱
//!  - getSettings / setSettings / isEnabled / setEnabled — Vault
//!
//! 옛 TS 의 getCmsSettings (design tokens / cms layout) 영역은 별도 phase — 메인 cms 영역
//! 에서 처리. Phase B-8 minimum 은 위 5 책임만.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ports::{
    ISandboxPort, IStoragePort, IVaultPort, IWsApiPort, IWsStreamPort, InfraResult, ModuleOutput,
    PackageStatus, SandboxExecuteOpts, WsApiCall, WsDecryptSpec, WsFieldEq, WsFrameFormat,
    WsLoginSpec, WsPreFrame, WsStreamSpec,
};
use crate::vault_keys::VK_SYSTEM_WS_WATCHES;
use std::collections::HashMap;
use std::sync::Mutex;
use crate::vault_keys::vk_module_settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemEntry {
    pub name: String,
    pub description: String,
    pub runtime: String,
    #[serde(rename = "type")]
    pub entry_type: String, // 'service' | 'module'
    pub scope: String,      // 'system' | 'user'
    pub enabled: bool,
}

const ENTRY_FILES: &[&str] = &["main.py", "index.js", "index.mjs", "main.php", "main.sh"];

fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

pub struct ModuleManager {
    sandbox: Arc<dyn ISandboxPort>,
    storage: Arc<dyn IStoragePort>,
    vault: Arc<dyn IVaultPort>,
    /// WS-only actions transport (config.json `ws` declarative) — None = not wired (tests).
    ws_api: Option<Arc<dyn IWsApiPort>>,
    /// Persistent realtime subscriptions (config.json `ws.streams` declarative).
    ws_stream: Option<Arc<dyn IWsStreamPort>>,
    /// Active watches meta — persisted to the vault so watches survive restarts.
    stream_watches: Mutex<HashMap<String, StreamWatchMeta>>,
}

/// One registered realtime watch (user intent) — the transport status lives in the port.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamWatchMeta {
    pub watch_id: String,
    pub topic: String,
    pub module: String,
    pub stream: String,
    #[serde(default)]
    pub args: serde_json::Value,
    /// Notification channel on realtime events — currently "telegram" or absent (SSE only).
    #[serde(default)]
    pub notify: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub mock: bool,
    pub created_ms: i64,
}

impl ModuleManager {
    pub fn new(
        sandbox: Arc<dyn ISandboxPort>,
        storage: Arc<dyn IStoragePort>,
        vault: Arc<dyn IVaultPort>,
    ) -> Self {
        Self {
            sandbox,
            storage,
            vault,
            ws_api: None,
            ws_stream: None,
            stream_watches: Mutex::new(HashMap::new()),
        }
    }

    /// WS API transport — modules whose config.json declares `ws.actions` route those
    /// actions here instead of the sandbox (WebSocket-only APIs like 조건검색).
    pub fn with_ws_api(mut self, ws_api: Arc<dyn IWsApiPort>) -> Self {
        self.ws_api = Some(ws_api);
        self
    }

    /// Persistent realtime subscription transport (config.json `ws.streams`).
    pub fn with_ws_stream(mut self, ws_stream: Arc<dyn IWsStreamPort>) -> Self {
        self.ws_stream = Some(ws_stream);
        self
    }

    /// Vault 직접 접근 — 시크릿 fallback chain (CMS settings 가 비었을 때 모듈 시크릿) 같은
    /// 패턴에서 사용. 일반 모듈 흐름은 sandbox 가 자동 주입.
    pub fn vault(&self) -> &Arc<dyn IVaultPort> {
        &self.vault
    }

    /// 직접 경로 실행 (EXECUTE / 파이프라인 등).
    pub async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        self.sandbox.execute(target_path, input_data, opts).await
    }

    /// 모듈명으로 실행 — entry 자동 탐색.
    /// 옛 TS `run(name, input)` 1:1 — listDir 실패 시 한국어 에러 명시.
    ///
    /// Track A6 (2026-05-07): config.json 의 input schema 설정되어 있으면 sandbox spawn 전 validation.
    /// 실패 시 InfraResult error — 모듈이 받지 못함 (silent corruption 방어).
    pub async fn run(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> InfraResult<ModuleOutput> {
        if !is_safe_name(module_name) {
            return Err(crate::i18n::t("core.error.module.invalid_name", None, &[]));
        }
        // 전역 비활성 모듈은 **어느 실행 경로**(FC dispatch / cron / 파이프라인 / MCP)로 들어와도 차단 —
        // 단일 choke point. 옛엔 MCP handler 만 is_enabled 체크해 FC·cron·파이프라인이 꺼진 모듈(telegram 등)을
        // 그대로 실행하던 갭. 사용자가 끈 모듈은 어떤 경로든 돌지 않아야 한다.
        if !self.is_enabled(module_name) {
            return Err(crate::i18n::t(
                "core.error.module.disabled",
                None,
                &[("name", module_name)],
            ));
        }
        // user / system 모두 검색 — sysmod 도구는 system/modules/ 에 있음.
        let (scope, dir_path, files) = {
            let user_dir = format!("user/modules/{}", module_name);
            let system_dir = format!("system/modules/{}", module_name);
            let user_entries = self.storage.list_dir(&user_dir).await.ok();
            let system_entries = self.storage.list_dir(&system_dir).await.ok();
            let pick = |entries: Vec<crate::ports::DirEntry>| -> Vec<String> {
                entries
                    .iter()
                    .filter(|e| !e.is_directory)
                    .map(|e| e.name.clone())
                    .collect()
            };
            if let Some(e) = user_entries {
                ("user", user_dir, pick(e))
            } else if let Some(e) = system_entries {
                ("system", system_dir, pick(e))
            } else {
                return Err(crate::i18n::t(
                    "core.error.module.not_found",
                    None,
                    &[("name", module_name)],
                ));
            }
        };
        let entry = ENTRY_FILES
            .iter()
            .find(|f| files.contains(&f.to_string()))
            .ok_or_else(|| {
                crate::i18n::t(
                    "core.error.module.entry_missing",
                    None,
                    &[("name", module_name)],
                )
            })?;

        // Config once — input validation + ws routing + output validation all read it
        // (was fetched twice: once per validation pass).
        let config = self.get_module_config(scope, module_name).await;

        // Pre-spawn input validation — against config.json's input schema (this is L4 of the
        // uniform tool procedure). The error hint = next-step pointer: every module is now
        // discoverable (explicit actionCatalog OR derived from the input schema), so the hint
        // uniformly points back to search_module_actions → get_action_schema.
        if let Some(config) = &config {
            if let Some(input_schema) = config.get("input") {
                let for_val = coerce_for_validation(&input_for_validation(input_data), input_schema);
                validate_value(&for_val, input_schema).map_err(|e| {
                    crate::i18n::t(
                        "core.error.module.input_validation_failed_catalog",
                        None,
                        &[("name", module_name), ("detail", &e)],
                    )
                })?;
            }
        }

        // WS-only actions (config.json `ws` declarative) — route to the WS transport instead of
        // the sandbox. Common infra + per-module config data = no per-provider WS code in modules
        // (TokenProvider pattern). Undeclared actions fall through to the sandbox as before.
        let ws_result = if let Some(ws_decl) = config.as_ref().and_then(|c| c.get("ws")) {
            self.try_ws_route(module_name, scope, &dir_path, ws_decl, input_data)
                .await?
        } else {
            None
        };

        let result = match ws_result {
            Some(r) => r,
            None => {
                let target = format!("{}/{}", dir_path, entry);
                // 시계열 영구 store 선언 (config `timeseries`) — 스펙은 core 가 데이터로 파싱,
                // 갭 축소·병합·서빙은 sandbox choke-point (rows 실물이 있는 곳). 미선언·범위
                // 비명시·limit 호출 = None (기존 30분 ephemeral 경로 그대로).
                let mut exec_opts = SandboxExecuteOpts::default();
                if let Some(ts_cfg) = config.as_ref().and_then(|c| c.get("timeseries")) {
                    let action = input_data
                        .get("action")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    exec_opts.timeseries = crate::utils::timeseries::parse_ts_spec(
                        ts_cfg,
                        module_name,
                        action,
                        input_data,
                    );
                }
                self.sandbox.execute(&target, input_data, &exec_opts).await?
            }
        };

        // Post-spawn output validation — config.json 의 output schema 설정되어 있으면 검사 (선택).
        // success:false 응답 (outErr 호출 경로) = envelope `{success:false, errorKey, errorParams}`
        // 형태라 `data` field 가 없음 → sandbox.rs 에서 result.data = Value::Null 로 설정됨.
        // output schema 검증 = success 인 정상 응답의 data 만 검증하는 게 정공.
        // success:false 응답까지 검증하던 것 = 옛 kma-weather (API key 미설정) 에서
        // "null is not of type object" warning 이 나던 root cause.
        if result.success {
            if let Some(config) = &config {
                if let Some(output_schema) = config.get("output") {
                    if let Err(e) = validate_value(&result.data, output_schema) {
                        tracing::warn!(
                            module = module_name,
                            error = %e,
                            "[ModuleManager] output schema violation — module stdout does not match config.output"
                        );
                    }
                }
            }
        }

        Ok(result)
    }

    /// config.json `ws` declaration → build a WsApiCall for this action, or None when the
    /// action isn't WS-declared (sandbox handles it). Errors: WS-only-unsupported actions
    /// (declared list, e.g. realtime variants) and missing transport wiring.
    async fn try_ws_route(
        &self,
        module_name: &str,
        scope: &str,
        dir_path: &str,
        ws: &serde_json::Value,
        input_data: &serde_json::Value,
    ) -> InfraResult<Option<ModuleOutput>> {
        let action = input_data
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if action.is_empty() {
            return Ok(None);
        }
        // Declared-but-unsupported (e.g. realtime variants needing a persistent connection) —
        // clear message instead of the provider's opaque REST rejection.
        let unsupported = ws
            .get("unsupportedActions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .any(|s| s == action)
            })
            .unwrap_or(false);
        if unsupported {
            return Err(crate::i18n::t(
                "core.error.module.ws_only_unsupported",
                None,
                &[("name", module_name), ("action", action)],
            ));
        }
        let Some(action_decl) = ws.get("actions").and_then(|a| a.get(action)) else {
            return Ok(None);
        };
        // The one-shot WS transport (`WsApiAdapter`) speaks JSON only. A positional dialect
        // (KisPipe) would be parsed as JSON, match nothing, and surface as a mysterious response
        // timeout — fail fast with the real reason instead. (Realtime push uses `ws.streams`,
        // which does implement the dialect.)
        if ws_frame_format(action_decl, ws) != WsFrameFormat::Json {
            return Err(format!(
                "[{module_name}] ws.actions.{action}: frameFormat 'kis-pipe' is only supported by \
                 ws.streams (persistent subscriptions), not by one-shot ws.actions"
            ));
        }
        let Some(ws_api) = &self.ws_api else {
            return Err(crate::i18n::t(
                "core.error.module.ws_not_wired",
                None,
                &[("name", module_name)],
            ));
        };

        let mock = input_data
            .get("mock")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let endpoint = ws_endpoint(ws, mock)
            .ok_or_else(|| format!("[{module_name}] ws.endpoint missing in config.json"))?;
        let args_view = ws_args_view(ws, input_data);
        // Prerequisite frames (same-session ordering some providers require) — substituted
        // with the same args view; failures use the same validation error surface.
        let pre_frames = parse_ws_pre_frames(action_decl, &args_view).map_err(|e| {
            crate::i18n::t(
                "core.error.module.input_validation_failed",
                None,
                &[("name", module_name), ("detail", &e)],
            )
        })?;

        let request_frame = substitute_ws_frame(
            action_decl
                .get("frame")
                .ok_or_else(|| format!("[{module_name}] ws.actions.{action}.frame missing"))?,
            &args_view,
        )
        .map_err(|e| {
            crate::i18n::t(
                "core.error.module.input_validation_failed",
                None,
                &[("name", module_name), ("detail", &e)],
            )
        })?;

        let call = WsApiCall {
            module: module_name.to_string(),
            action: action.to_string(),
            module_dir: dir_path.to_string(),
            endpoint,
            match_field: ws_match_field(ws),
            echo_values: ws_echo_values(ws),
            login: parse_ws_login(ws),
            pre_frames,
            request_frame,
            response_match: action_decl
                .get("match")
                .and_then(|v| v.as_str())
                .unwrap_or(action)
                .to_string(),
            success_when: parse_ws_field_eq(action_decl.get("successWhen")),
            error_msg_field: ws
                .get("errorMsgField")
                .and_then(|v| v.as_str())
                .map(String::from),
            mock,
            timeout_ms: action_decl
                .get("timeoutMs")
                .or_else(|| ws.get("timeoutMs"))
                .and_then(|v| v.as_u64())
                .unwrap_or(15_000),
        };
        let _ = scope; // scope already encoded in dir_path; kept for signature clarity
        Ok(Some(ws_api.call(&call).await?))
    }

    // ── Persistent realtime streams (config.json `ws.streams` declarative) ──────────────

    /// Start a realtime watch. Idempotent on (module, stream, args) — an identical active
    /// watch is returned instead of duplicated. Persists to the vault (restart survival).
    pub async fn start_stream(
        &self,
        module_name: &str,
        stream_key: &str,
        args: &serde_json::Value,
        notify: Option<String>,
        label: Option<String>,
        mock: bool,
    ) -> InfraResult<serde_json::Value> {
        if !is_safe_name(module_name) {
            return Err(crate::i18n::t("core.error.module.invalid_name", None, &[]));
        }
        if !self.is_enabled(module_name) {
            return Err(crate::i18n::t(
                "core.error.module.disabled",
                None,
                &[("name", module_name)],
            ));
        }
        // Idempotency — same intent returns the existing watch.
        let args_norm = serde_json::to_string(args).unwrap_or_default();
        {
            let watches = self.stream_watches.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(existing) = watches.values().find(|m| {
                m.module == module_name
                    && m.stream == stream_key
                    && serde_json::to_string(&m.args).unwrap_or_default() == args_norm
            }) {
                return Ok(serde_json::json!({
                    "watchId": existing.watch_id,
                    "topic": existing.topic,
                    "created": false,
                }));
            }
        }
        let watch_id = format!(
            "ws-{}-{}-{}",
            module_name,
            stream_key,
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let meta = StreamWatchMeta {
            topic: format!("ws-stream:{watch_id}"),
            watch_id,
            module: module_name.to_string(),
            stream: stream_key.to_string(),
            args: args.clone(),
            notify,
            label,
            mock,
            created_ms: chrono::Utc::now().timestamp_millis(),
        };
        self.launch_stream(meta.clone()).await?;
        self.persist_watches();
        Ok(serde_json::json!({
            "watchId": meta.watch_id,
            "topic": meta.topic,
            "created": true,
        }))
    }

    /// Stop + forget a watch (best-effort unsubscribe happens in the transport).
    pub async fn stop_stream(&self, watch_id: &str) -> InfraResult<bool> {
        if let Some(port) = &self.ws_stream {
            port.stop(watch_id).await?;
        }
        let removed = self
            .stream_watches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(watch_id)
            .is_some();
        self.persist_watches();
        Ok(removed)
    }

    /// Watch meta lookup — the event sink uses it for notify routing.
    pub fn stream_watch_meta(&self, watch_id: &str) -> Option<StreamWatchMeta> {
        self.stream_watches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(watch_id)
            .cloned()
    }

    /// Registered watches merged with live transport status.
    pub fn list_streams(&self) -> Vec<serde_json::Value> {
        let statuses: HashMap<String, crate::ports::WsStreamStatus> = self
            .ws_stream
            .as_ref()
            .map(|p| p.list().into_iter().map(|s| (s.watch_id.clone(), s)).collect())
            .unwrap_or_default();
        let watches = self.stream_watches.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<serde_json::Value> = watches
            .values()
            .map(|m| {
                let mut v = serde_json::to_value(m).unwrap_or_default();
                if let Some(obj) = v.as_object_mut() {
                    match statuses.get(&m.watch_id) {
                        Some(s) => {
                            obj.insert("state".into(), serde_json::json!(s.state));
                            obj.insert("detail".into(), serde_json::json!(s.detail));
                            obj.insert("lastEventMs".into(), serde_json::json!(s.last_event_ms));
                            obj.insert("eventCount".into(), serde_json::json!(s.event_count));
                        }
                        None => {
                            obj.insert("state".into(), serde_json::json!("stopped"));
                        }
                    }
                }
                v
            })
            .collect();
        out.sort_by_key(|v| -(v.get("createdMs").and_then(|c| c.as_i64()).unwrap_or(0)));
        out
    }

    /// Boot-time restore of persisted watches — failures are logged and skipped (the watch
    /// stays registered so a later manual restart can pick it up).
    pub async fn restore_streams(&self) -> usize {
        let Some(raw) = self.vault.get_secret(VK_SYSTEM_WS_WATCHES) else {
            return 0;
        };
        let metas: Vec<StreamWatchMeta> = serde_json::from_str(&raw).unwrap_or_default();
        let mut ok = 0usize;
        for meta in metas {
            let id = meta.watch_id.clone();
            match self.launch_stream(meta).await {
                Ok(()) => ok += 1,
                Err(e) => {
                    tracing::warn!(target: "ws_stream", watch_id = %id, error = %e, "watch restore failed");
                }
            }
        }
        ok
    }

    /// Build the spec from config and hand it to the transport; register the meta.
    async fn launch_stream(&self, meta: StreamWatchMeta) -> InfraResult<()> {
        let Some(port) = &self.ws_stream else {
            return Err(crate::i18n::t(
                "core.error.module.ws_not_wired",
                None,
                &[("name", &meta.module)],
            ));
        };
        let (module_dir, config) = self.stream_config(&meta.module).await?;
        let ws = config
            .get("ws")
            .ok_or_else(|| format!("[{}] config.json has no ws block", meta.module))?;
        let decl = ws
            .get("streams")
            .and_then(|s| s.get(&meta.stream))
            .ok_or_else(|| {
                format!("[{}] ws.streams.{} not declared", meta.module, meta.stream)
            })?;

        let args_view = ws_args_view(ws, &meta.args);
        let subscribe = decl
            .get("subscribe")
            .ok_or_else(|| format!("[{}] ws.streams.{}.subscribe missing", meta.module, meta.stream))?;
        let subscribe_frame = substitute_ws_frame(
            subscribe
                .get("frame")
                .ok_or_else(|| format!("[{}] subscribe.frame missing", meta.module))?,
            &args_view,
        )?;
        let unsubscribe_frame = match decl.get("unsubscribe").and_then(|u| u.get("frame")) {
            Some(tpl) => Some(substitute_ws_frame(tpl, &args_view)?),
            None => None,
        };
        // 한투 positional realtime (KisPipe): field order from the module's `_ws_apis.json`
        // responseBody, keyed by the stream's trId. kiwoom (Json) leaves field_order empty.
        let frame_format = ws_frame_format(decl, ws);
        let field_order = if frame_format == WsFrameFormat::KisPipe {
            let tr_id = decl.get("trId").and_then(|v| v.as_str()).unwrap_or_default();
            let spec_file = decl
                .get("fieldsFrom")
                .and_then(|v| v.as_str())
                .unwrap_or("_ws_apis.json");
            let scope = if module_dir.starts_with("user/") {
                "user"
            } else {
                "system"
            };
            match self.read_module_file(scope, &meta.module, spec_file).await {
                Some(raw) => extract_field_order(&raw, tr_id),
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };
        let spec = WsStreamSpec {
            watch_id: meta.watch_id.clone(),
            topic: meta.topic.clone(),
            module: meta.module.clone(),
            stream: meta.stream.clone(),
            module_dir,
            // Per-stream endpoint override (decl.endpoint/endpointMock) → module-level fallback.
            // 같은 provider 가 스트림별로 다른 WS 경로를 쓸 때(예: 키움 국내 /api/dostk/websocket vs
            // 미국주식 /api/us/websocket, 같은 호스트 다른 path). 선언 없으면 기존 module-level.
            endpoint: ws_endpoint(decl, meta.mock)
                .or_else(|| ws_endpoint(ws, meta.mock))
                .ok_or_else(|| format!("[{}] ws.endpoint missing", meta.module))?,
            match_field: ws_match_field(ws),
            echo_values: ws_echo_values(ws),
            login: parse_ws_login(ws),
            error_msg_field: ws
                .get("errorMsgField")
                .and_then(|v| v.as_str())
                .map(String::from),
            pre_frames: parse_ws_pre_frames(decl, &args_view)?,
            subscribe_match: subscribe
                .get("match")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            subscribe_success: parse_ws_field_eq(subscribe.get("successWhen")),
            subscribe_frame,
            unsubscribe_frame,
            realtime_match: decl
                .get("realtimeMatch")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!("[{}] ws.streams.{}.realtimeMatch missing", meta.module, meta.stream)
                })?
                .to_string(),
            frame_format,
            field_order,
            decrypt: parse_ws_decrypt(decl),
            // Spec-level token secret — 한투 approval_key rides in the subscribe frame (no LOGIN).
            token_secret: ws
                .get("tokenSecret")
                .and_then(|v| v.as_str())
                .map(String::from),
            mock: meta.mock,
        };
        port.start(spec).await?;
        self.stream_watches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(meta.watch_id.clone(), meta);
        Ok(())
    }

    /// Streams are config-only (no entry file needed) — locate config across scopes.
    async fn stream_config(&self, module_name: &str) -> InfraResult<(String, serde_json::Value)> {
        for (scope, dir) in [
            ("user", format!("user/modules/{module_name}")),
            ("system", format!("system/modules/{module_name}")),
        ] {
            if let Some(cfg) = self.get_module_config(scope, module_name).await {
                return Ok((dir, cfg));
            }
        }
        Err(crate::i18n::t(
            "core.error.module.not_found",
            None,
            &[("name", module_name)],
        ))
    }

    fn persist_watches(&self) {
        let metas: Vec<StreamWatchMeta> = self
            .stream_watches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        if let Ok(raw) = serde_json::to_string(&metas) {
            self.vault.set_secret(VK_SYSTEM_WS_WATCHES, &raw);
        }
    }

    /// system/modules/ 시스템 모듈 list.
    pub async fn list_system_modules(&self) -> Vec<SystemEntry> {
        self.scan_dir("system/modules", "module", "system").await
    }

    /// system/services/ 시스템 서비스 list.
    pub async fn list_system_services(&self) -> Vec<SystemEntry> {
        self.scan_dir("system/services", "service", "system").await
    }

    /// 시스템 modules + services 통합.
    pub async fn list_system(&self) -> Vec<SystemEntry> {
        let mut services = self.list_system_services().await;
        let modules = self.list_system_modules().await;
        services.extend(modules);
        services
    }

    /// user/modules/ 사용자 모듈 list.
    pub async fn list_user_modules(&self) -> Vec<SystemEntry> {
        self.scan_dir("user/modules", "module", "user").await
    }

    /// scope + name 으로 config.json 직접 파싱.
    pub async fn get_module_config(
        &self,
        scope: &str,
        name: &str,
    ) -> Option<serde_json::Value> {
        if !is_safe_name(name) {
            return None;
        }
        let candidates: Vec<String> = if scope == "user" {
            vec![format!("user/modules/{}/config.json", name)]
        } else {
            vec![
                format!("system/modules/{}/config.json", name),
                format!("system/services/{}/config.json", name),
            ]
        };
        for path in candidates {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return Some(parsed);
                }
            }
        }
        None
    }

    /// 모듈 dir 안 선언 파일 read (config `actionCatalog.file` 등) — 파일명만 허용 (path traversal 차단).
    pub async fn read_module_file(&self, scope: &str, name: &str, file: &str) -> Option<String> {
        if !is_safe_name(name) {
            return None;
        }
        // 파일명 화이트리스트 — 영숫자/대시/언더스코어 + .json 확장자만 (경로 구분자 차단).
        if !file
            .strip_suffix(".json")
            .is_some_and(|stem| !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        {
            return None;
        }
        let candidates: Vec<String> = if scope == "user" {
            vec![format!("user/modules/{}/{}", name, file)]
        } else {
            vec![
                format!("system/modules/{}/{}", name, file),
                format!("system/services/{}/{}", name, file),
            ]
        };
        for path in candidates {
            if let Ok(content) = self.storage.read(&path).await {
                return Some(content);
            }
        }
        None
    }

    /// `getConfig(name)` 옛 TS 1:1 — scope 무관 system/modules → system/services → user/modules 순서로 첫 hit 반환.
    /// `/api/settings/modules?name=xxx` 같이 호출자가 scope 를 모를 때 사용. 옛 TS `ModuleManager.getConfig` 1:1.
    pub async fn get_config_any_scope(&self, name: &str) -> Option<serde_json::Value> {
        if !is_safe_name(name) {
            return None;
        }
        for path in [
            format!("system/modules/{}/config.json", name),
            format!("system/services/{}/config.json", name),
            format!("user/modules/{}/config.json", name),
        ] {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return Some(parsed);
                }
            }
        }
        None
    }

    /// 모듈의 lang/{lang}.json 직접 파싱 — scope 무관 (system/modules → system/services → user/modules 순서).
    /// 활성 lang 파일 미존재 시 영어 → 한국어 순으로 fallback. 모두 미존재 시 빈 object.
    ///
    /// 옵션 C 분리 패턴 (2026-05-16) — config.json 의 `settings_fields[].i18n` inline 영역을
    /// 별도 파일로 분리. settings.{field_key}.{label,description,placeholder,group,options[]} 구조.
    pub async fn get_module_lang(&self, name: &str, lang: &str) -> serde_json::Value {
        if !is_safe_name(name) {
            return serde_json::json!({});
        }
        // 안전 lang 만 허용 (path traversal 차단). 옛 i18n.tsx 와 동일 패턴.
        let safe_lang = match lang {
            "ko" | "en" => lang,
            _ => "en",
        };
        let candidates = [
            format!("system/modules/{}/lang/{}.json", name, safe_lang),
            format!("system/services/{}/lang/{}.json", name, safe_lang),
            format!("user/modules/{}/lang/{}.json", name, safe_lang),
            // fallback: 활성 lang 파일 없으면 영어 시도 → 그 후 한국어
            format!("system/modules/{}/lang/en.json", name),
            format!("system/services/{}/lang/en.json", name),
            format!("user/modules/{}/lang/en.json", name),
            format!("system/modules/{}/lang/ko.json", name),
            format!("system/services/{}/lang/ko.json", name),
            format!("user/modules/{}/lang/ko.json", name),
        ];
        for path in candidates {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return parsed;
                }
            }
        }
        serde_json::json!({})
    }

    /// 모듈 settings (Vault). 미존재 또는 파싱 실패 시 빈 object.
    pub fn get_settings(&self, module_name: &str) -> serde_json::Value {
        crate::utils::vault_json::vault_get_json::<serde_json::Value>(
            &*self.vault,
            &vk_module_settings(module_name),
        )
    }

    pub fn set_settings(&self, module_name: &str, settings: &serde_json::Value) -> bool {
        crate::utils::vault_json::vault_set_json(
            &*self.vault,
            &vk_module_settings(module_name),
            settings,
        )
        .is_ok()
    }

    /// 활성화 여부 — settings.enabled (default true).
    pub fn is_enabled(&self, module_name: &str) -> bool {
        let settings = self.get_settings(module_name);
        settings
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_enabled(&self, module_name: &str, enabled: bool) -> bool {
        let mut settings = self.get_settings(module_name);
        if !settings.is_object() {
            settings = serde_json::json!({});
        }
        settings["enabled"] = serde_json::Value::Bool(enabled);
        self.set_settings(module_name, &settings)
    }

    /// 모듈 이름 → 디스크 디렉토리 (system/modules → system/services → user/modules 순 첫 hit).
    /// 매 install / status 호출자가 공유.
    async fn resolve_module_dir(&self, module_name: &str) -> Option<String> {
        if !is_safe_name(module_name) {
            return None;
        }
        for candidate in [
            format!("system/modules/{}", module_name),
            format!("system/services/{}", module_name),
            format!("user/modules/{}", module_name),
        ] {
            if self.storage.list_dir(&candidate).await.is_ok() {
                return Some(candidate);
            }
        }
        None
    }

    /// config.json `packages` 배열 → background install. `upgrade=true` 시 `pip install --upgrade`.
    /// 반환값: spawn 한 StatusManager job_id 목록 (이미 설치 / 진행 중 패키지 제외).
    pub async fn install_packages(
        &self,
        module_name: &str,
        upgrade: bool,
    ) -> InfraResult<Vec<String>> {
        let dir = self.resolve_module_dir(module_name).await.ok_or_else(|| {
            crate::i18n::t(
                "core.error.module.not_found",
                None,
                &[("name", module_name)],
            )
        })?;
        self.sandbox.install_packages(&dir, upgrade).await
    }

    /// 매 패키지 status — 설정 화면 polling 입력.
    pub async fn get_package_status(
        &self,
        module_name: &str,
    ) -> InfraResult<Vec<PackageStatus>> {
        let dir = self.resolve_module_dir(module_name).await.ok_or_else(|| {
            crate::i18n::t(
                "core.error.module.not_found",
                None,
                &[("name", module_name)],
            )
        })?;
        self.sandbox.get_package_status(&dir).await
    }

    // ─── private helpers ───

    /// 디렉토리 스캔 — config.json 설정된 하위 디렉토리 → SystemEntry list.
    /// 옛 TS `scanDir(dir, defaultType, defaultScope)` 1:1:
    ///   - config.json 의 `type` / `scope` 설정되어 있으면 우선 (인자 default 는 fallback)
    ///   - config.json 안 설정된 디렉토리는 skip
    /// 정렬 — 옛 TS 는 자연 디렉토리 순서. Rust 도 sort 하지 않음 (silent behavior 차이 fix).
    async fn scan_dir(
        &self,
        dir: &str,
        default_type: &str,
        default_scope: &str,
    ) -> Vec<SystemEntry> {
        let Ok(entries) = self.storage.list_dir(dir).await else {
            return vec![];
        };
        let mut result = Vec::new();
        for entry in entries {
            if !entry.is_directory {
                continue;
            }
            let path = format!("{}/{}/config.json", dir, entry.name);
            let Ok(content) = self.storage.read(&path).await else { continue };
            let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content) else {
                continue
            };
            let name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.name)
                .to_string();
            let description = parsed
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let runtime = parsed
                .get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // 옛 TS `parsed.type || defaultType` / `parsed.scope || defaultScope` 1:1
            // (config.json 의 type / scope 가 우선 — 호출자 인자는 fallback)
            let entry_type = parsed
                .get("type")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(default_type)
                .to_string();
            let scope = parsed
                .get("scope")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(default_scope)
                .to_string();
            let enabled = self.is_enabled(&name);
            result.push(SystemEntry {
                name,
                description,
                runtime,
                entry_type,
                scope,
                enabled,
            });
        }
        result
    }
}


// ─── JSON Schema validation (Track A6, 2026-05-07) ──────────────────────────
//
// 시니어 audit 결과 설정된 module I/O contract 강제. config.json 의 input/output schema
// 형태가 JSON Schema 와 호환 (type/properties/required/enum/etc) 이므로 jsonschema
// crate 로 검증. 실패 시 명시 에러 (silent corruption 방어).

/// hub 프레임워크가 도구 호출 args 에 자동 주입하는 예약 메타 키 (owner/hubOwner/_hubScope/project).
/// 모듈 본체는 이 키들(특히 `_hubScope` = 데이터 디렉토리 hub-scope 분기)을 받아 쓰지만, config.json 의
/// input 스키마는 선언하지 않으므로(additionalProperties:false) **입력 검증에서만** 제거한다.
/// 검증 통과 후 모듈에는 원본(메타 포함)이 그대로 전달돼 `_hubScope` scope 분기가 정상 동작한다.
const RESERVED_HUB_META_KEYS: &[&str] = &["owner", "hubOwner", "_hubScope", "project"];

/// 입력값에 예약 메타 키가 있으면 제거한 사본을 반환 (검증 전용). 없으면 원본 차용 (clone 회피).
/// endpoint / endpointMock pick (mock falls back to the real endpoint when absent).
fn ws_endpoint(ws: &serde_json::Value, mock: bool) -> Option<String> {
    let v = if mock {
        ws.get("endpointMock").or_else(|| ws.get("endpoint"))
    } else {
        ws.get("endpoint")
    };
    v.and_then(|v| v.as_str()).map(String::from)
}

fn ws_match_field(ws: &serde_json::Value) -> String {
    ws.get("matchField")
        .and_then(|v| v.as_str())
        .unwrap_or("trnm")
        .to_string()
}

fn ws_echo_values(ws: &serde_json::Value) -> Vec<String> {
    ws.get("echoValues")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn parse_ws_login(ws: &serde_json::Value) -> Option<WsLoginSpec> {
    ws.get("login").map(|l| WsLoginSpec {
        frame: l.get("frame").cloned().unwrap_or(serde_json::Value::Null),
        response_match: l
            .get("match")
            .and_then(|v| v.as_str())
            .unwrap_or("LOGIN")
            .to_string(),
        success_when: parse_ws_field_eq(l.get("successWhen")),
        token_secret: l
            .get("tokenSecret")
            .and_then(|v| v.as_str())
            .map(String::from),
    })
}

/// Module arg-container convention — some modules nest API params under a field
/// (e.g. kiwoom `{action, params:{…}}`, declared as ws.argsField). Overlay the nested
/// object over the root so templates resolve from either level (nested wins).
fn ws_args_view(ws: &serde_json::Value, input: &serde_json::Value) -> serde_json::Value {
    match ws
        .get("argsField")
        .and_then(|v| v.as_str())
        .and_then(|f| input.get(f))
        .and_then(|v| v.as_object())
    {
        Some(nested) => {
            let mut merged = input.as_object().cloned().unwrap_or_default();
            for (k, v) in nested {
                merged.insert(k.clone(), v.clone());
            }
            serde_json::Value::Object(merged)
        }
        None => input.clone(),
    }
}

/// `preFrames: [{frame, match, successWhen}]` on an action/stream declaration.
fn parse_ws_pre_frames(
    decl: &serde_json::Value,
    args_view: &serde_json::Value,
) -> Result<Vec<WsPreFrame>, String> {
    let mut out = Vec::new();
    if let Some(pres) = decl.get("preFrames").and_then(|v| v.as_array()) {
        for p in pres {
            let Some(frame_tpl) = p.get("frame") else { continue };
            out.push(WsPreFrame {
                frame: substitute_ws_frame(frame_tpl, args_view)?,
                response_match: p
                    .get("match")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                success_when: parse_ws_field_eq(p.get("successWhen")),
            });
        }
    }
    Ok(out)
}

/// `{field, equals}` config object → WsFieldEq (None when absent/malformed).
fn parse_ws_field_eq(v: Option<&serde_json::Value>) -> Option<WsFieldEq> {
    let v = v?;
    Some(WsFieldEq {
        field: v.get("field")?.as_str()?.to_string(),
        equals: v.get("equals")?.clone(),
    })
}

/// Realtime wire format — `"kis-pipe"` (한투 positional) vs default Json (kiwoom). Stream-level
/// override falls back to the module-level `ws.frameFormat`.
fn ws_frame_format(decl: &serde_json::Value, ws: &serde_json::Value) -> WsFrameFormat {
    let s = decl
        .get("frameFormat")
        .or_else(|| ws.get("frameFormat"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match s {
        "kis-pipe" => WsFrameFormat::KisPipe,
        _ => WsFrameFormat::Json,
    }
}

/// `decrypt: {ivField, keyField}` on a stream decl → WsDecryptSpec (KIS 체결통보 AES256).
fn parse_ws_decrypt(decl: &serde_json::Value) -> Option<WsDecryptSpec> {
    let d = decl.get("decrypt")?;
    Some(WsDecryptSpec {
        iv_field: d.get("ivField")?.as_str()?.to_string(),
        key_field: d.get("keyField")?.as_str()?.to_string(),
    })
}

/// Positional field order for a 한투 realtime TR — the responseBody name list from the module's
/// `_ws_apis.json`. Empty when the file/entry is missing.
///
/// `trIdReal` is matched first and must be unique; a mock id is only consulted when no real id
/// matches (a mock id can collide with another API's real id). Two entries sharing a real trId
/// means the spec file is corrupt — an earlier extractor trusted the vendor's list sheet, whose
/// TR_ID column has typos, and silently gave two different APIs the same id. Warn loudly rather
/// than pick one at random: the wrong field order corrupts every frame of that stream.
fn extract_field_order(raw: &str, tr_id: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(apis) = json.get("apis").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let names = |api: &serde_json::Value| -> Vec<String> {
        api.get("responseBody")
            .and_then(|v| v.as_array())
            .map(|rb| {
                rb.iter()
                    .filter_map(|f| f.get("name").and_then(|v| v.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    let real: Vec<&serde_json::Value> = apis
        .iter()
        .filter(|a| a.get("trIdReal").and_then(|v| v.as_str()) == Some(tr_id))
        .collect();
    if real.len() > 1 {
        tracing::warn!(
            target: "ws_stream",
            tr_id = tr_id,
            entries = real.len(),
            "duplicate trIdReal in _ws_apis.json — field order is ambiguous, re-run scripts/extract-ws-apis.mjs"
        );
    }
    if let Some(api) = real.first() {
        return names(api);
    }
    apis.iter()
        .find(|a| a.get("trIdMock").and_then(|v| v.as_str()) == Some(tr_id))
        .map(names)
        .unwrap_or_default()
}

/// WS frame template substitution — generic, zero provider knowledge.
/// String values of the exact form `"{param}"` / `"{param:default}"` are replaced with the
/// input arg (coerced to string); `"{param}"` with no default and no arg = error (required).
/// `"{TOKEN}"` is left as-is — the transport adapter fills it after the token fetch.
fn substitute_ws_frame(
    template: &serde_json::Value,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    fn walk(v: &serde_json::Value, input: &serde_json::Value) -> Result<serde_json::Value, String> {
        match v {
            serde_json::Value::String(s) => {
                let Some(inner) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')) else {
                    return Ok(v.clone());
                };
                if inner == "TOKEN" {
                    return Ok(v.clone());
                }
                let (param, default) = match inner.split_once(':') {
                    Some((p, d)) => (p, Some(d)),
                    None => (inner, None),
                };
                if param.is_empty() || !param.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Ok(v.clone()); // not a placeholder (e.g. literal JSON-ish string)
                }
                match input.get(param) {
                    Some(serde_json::Value::String(s)) => Ok(serde_json::Value::String(s.clone())),
                    Some(serde_json::Value::Number(n)) => {
                        Ok(serde_json::Value::String(n.to_string()))
                    }
                    Some(serde_json::Value::Bool(b)) => {
                        Ok(serde_json::Value::String(b.to_string()))
                    }
                    _ => match default {
                        Some(d) => Ok(serde_json::Value::String(d.to_string())),
                        None => Err(format!("required param missing: {param}")),
                    },
                }
            }
            serde_json::Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (k, val) in map {
                    out.insert(k.clone(), walk(val, input)?);
                }
                Ok(serde_json::Value::Object(out))
            }
            serde_json::Value::Array(items) => Ok(serde_json::Value::Array(
                items
                    .iter()
                    .map(|i| walk(i, input))
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            other => Ok(other.clone()),
        }
    }
    walk(template, input)
}

fn input_for_validation(input_data: &serde_json::Value) -> std::borrow::Cow<'_, serde_json::Value> {
    match input_data.as_object() {
        Some(obj) if RESERVED_HUB_META_KEYS.iter().any(|k| obj.contains_key(*k)) => {
            let mut cleaned = obj.clone();
            for k in RESERVED_HUB_META_KEYS {
                cleaned.remove(*k);
            }
            std::borrow::Cow::Owned(serde_json::Value::Object(cleaned))
        }
        _ => std::borrow::Cow::Borrowed(input_data),
    }
}

/// Validation-only scalar coercion — the model got the judgment right (correct action + param)
/// but the JSON type wrong: a numeric string ("37.5665") where the schema declares number/integer.
/// The Node/Python module runtime coerces such strings in arithmetic, so only the jsonschema gate
/// rejected the call. Coerce numeric strings to numbers *for validation only* (the sandbox still
/// receives the original input). Schema-driven, no per-module hardcoding — "LLM judges, framework
/// tolerates the type".
fn coerce_for_validation(
    value: &serde_json::Value,
    schema: &serde_json::Value,
) -> serde_json::Value {
    let (Some(obj), Some(props)) = (
        value.as_object(),
        schema.get("properties").and_then(|p| p.as_object()),
    ) else {
        return value.clone();
    };
    let mut out = obj.clone();
    for (k, v) in obj {
        let Some(s) = v.as_str() else { continue };
        let Some(ty) = props.get(k).and_then(|p| p.get("type")).and_then(|t| t.as_str()) else {
            continue;
        };
        match ty {
            "integer" => {
                if let Ok(n) = s.trim().parse::<i64>() {
                    out.insert(k.clone(), serde_json::json!(n));
                }
            }
            "number" => {
                if let Ok(n) = s.trim().parse::<f64>() {
                    if let Some(num) = serde_json::Number::from_f64(n) {
                        out.insert(k.clone(), serde_json::Value::Number(num));
                    }
                }
            }
            _ => {}
        }
    }
    serde_json::Value::Object(out)
}

/// JSON Schema 기준 단일 value 검증. 첫 에러만 사용자에게 노출 (스키마 전체 dump 회피).
pub fn validate_value(
    value: &serde_json::Value,
    schema: &serde_json::Value,
) -> Result<(), String> {
    let compiled = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .compile(schema)
        .map_err(|e| {
            crate::i18n::t(
                "core.error.module.schema_format",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
    if let Err(errors) = compiled.validate(value) {
        let first = errors
            .into_iter()
            .next()
            .map(|e| format!("{} (path: {})", e, e.instance_path))
            .unwrap_or_else(|| {
                crate::i18n::t("core.error.module.unknown_validation", None, &[])
            });
        // 거대 enum 오류 캡 — "is not one of [275개 전체]" 가 도구 결과로 그대로 가면
        // 컨텍스트 폭탄 + 약한 모델이 목록에서 아무거나 집는 유도(2026-07-06 실측: 한투 275
        // 액션 덤프를 보고 주문 API 를 시세용으로 선택). 앞부분만 남기고 char-경계 안전 절단.
        const MAX_ERR_CHARS: usize = 400;
        if first.chars().count() > MAX_ERR_CHARS {
            let capped: String = first.chars().take(MAX_ERR_CHARS).collect();
            return Err(format!("{capped}… (truncated)"));
        }
        return Err(first);
    }
    Ok(())
}

/// 모듈 config 자체 well-formedness 검증 — 등록 시점 (또는 dry-run) 호출용.
/// 실 실행 X — schema 컴파일만 시도해 형식 오류 즉시 catch.
pub fn validate_module_definition(config: &serde_json::Value) -> Result<(), String> {
    if let Some(input_schema) = config.get("input") {
        jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .compile(input_schema)
            .map_err(|e| {
                crate::i18n::t(
                    "core.error.module.input_schema_format",
                    None,
                    &[("detail", &e.to_string())],
                )
            })?;
    }
    if let Some(output_schema) = config.get("output") {
        jsonschema::JSONSchema::options()
            .with_draft(jsonschema::Draft::Draft7)
            .compile(output_schema)
            .map_err(|e| {
                crate::i18n::t(
                    "core.error.module.output_schema_format",
                    None,
                    &[("detail", &e.to_string())],
                )
            })?;
    }
    Ok(())
}

impl ModuleManager {
    /// Dry-run: 모듈 호출 시뮬레이션 — sandbox spawn 안 함.
    /// config.json 의 well-formedness + input schema 검증만. pipeline 등록 시점 호출 권장.
    pub async fn dry_run(
        &self,
        scope: &str,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> Result<(), String> {
        if !is_safe_name(module_name) {
            return Err(crate::i18n::t("core.error.module.invalid_name", None, &[]));
        }
        let config = self.get_module_config(scope, module_name).await.ok_or_else(|| {
            crate::i18n::t(
                "core.error.module.config_missing",
                None,
                &[("scope", scope), ("name", module_name)],
            )
        })?;
        validate_module_definition(&config)?;
        if let Some(input_schema) = config.get("input") {
            validate_value(&input_for_validation(input_data), input_schema).map_err(|e| {
                crate::i18n::t(
                    "core.error.module.input_validation_failed_scoped",
                    None,
                    &[("scope", scope), ("name", module_name), ("detail", &e)],
                )
            })?;
        }
        Ok(())
    }
}


// Tests 이관 — `infra/tests/module_manager_test.rs` (integration test).

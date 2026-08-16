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
    IMemoryFacadePort, ISandboxPort, IStoragePort, IVaultPort, IWsApiPort, IWsStreamPort,
    InfraResult, ModuleOutput,
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

/// `_mediaImport.path` confinement — workspace-relative, under `data/` or `user/` only.
/// Returns the normalized (forward-slash) path, or None for anything that points elsewhere.
fn media_export_path(path: &str) -> Option<String> {
    let norm = path.replace('\\', "/");
    let ok = !norm.is_empty()
        && !norm.starts_with('/')
        && !norm.contains(':')
        && !norm.split('/').any(|seg| seg == "..")
        && (norm.starts_with("data/") || norm.starts_with("user/"));
    ok.then_some(norm)
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
    /// Result cache — lets a declared array parameter arrive as a `<param>CacheKey` instead of the
    /// rows themselves. None = not wired (tests); a key then errors rather than silently vanishing.
    sysmod_cache: Option<Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>>,
    /// Where a module's `remember` block lands. A port rather than a manager handle — the same
    /// shape consolidation uses to reach recall without one leaf calling another. None = not
    /// wired (tests), and a declaration then reports that it went nowhere instead of vanishing.
    recall: Option<Arc<dyn IMemoryFacadePort>>,
    /// Where a module's `_mediaImport` file lands — the media store, through the same gated save
    /// uploads use. Mutex-held because MediaManager is constructed after this manager in main.rs
    /// (set_media_intake, not a builder). None = not wired (tests); the declaration then reports
    /// it went nowhere.
    media_intake: Mutex<Option<Arc<dyn crate::managers::media::IMediaIntakePort>>>,
    /// Per-module `action id → call` rows, keyed `scope:name` and validated against the module
    /// directory's own fingerprint.
    ///
    /// A call is for one action, so a module should be handed one action's row — not a table of
    /// everyone else's. korea-invest shipped a generated 62KB table its dialect parsed on every
    /// spawn (a module runs as a fresh process per step) to read five fields off a single entry.
    /// Reading the declaration here instead would move that parse onto the dispatch path, hence
    /// the cache; the fingerprint comes from the `list_dir` dispatch already performs, so keeping
    /// it honest costs no extra I/O.
    action_calls: Mutex<HashMap<String, CachedCalls>>,
}

/// One module's `_call` rows and the directory state they were read from.
struct CachedCalls {
    /// `name:size:mtime` over the module directory — the same signal the action catalog uses,
    /// scoped to one module. An edit to `actions.json` changes it; five quiet minutes do not.
    fingerprint: String,
    /// Empty when the module declares no `_call` anywhere, which is most of them. Cached all the
    /// same: "this module has nothing to inject" is an answer worth not re-deriving per call.
    calls: Arc<HashMap<String, serde_json::Value>>,
}

/// Alias length cap. The alias is the account's name everywhere it appears — settings rows,
/// order tickets, autotrade tables — so it has to fit a column, not just a vault key.
const ALIAS_MAX_CHARS: usize = 20;

/// One registered realtime watch (user intent) — the transport status lives in the port.
/// Where a watch's frames go once they are off the wire.
///
/// One value rather than four adjacent parameters: three of them are `Option<String>`, so a caller
/// could swap two and the compiler would agree.
#[derive(Debug, Clone, Default)]
pub struct StreamNotify {
    /// `"telegram"` for a chat message, `"module:<name>"` to run a module. None = SSE only.
    pub to: Option<String>,
    /// Action name for a `module:` sink (default `on_stream_event`).
    pub action: Option<String>,
    /// Floor between two sink runs for this watch.
    pub min_interval_ms: Option<u64>,
    /// Cron job fired right after the sink runs — how an event reaches the order path.
    pub job: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamWatchMeta {
    pub watch_id: String,
    pub topic: String,
    pub module: String,
    pub stream: String,
    #[serde(default)]
    pub args: serde_json::Value,
    /// Where realtime frames go besides the event bus: `"telegram"` for a chat message, or
    /// `"module:<name>"` to run a module on them. Absent = SSE only.
    #[serde(default)]
    pub notify: Option<String>,
    /// Action name for a `module:` sink (default `on_stream_event`).
    #[serde(default)]
    pub notify_action: Option<String>,
    /// Floor between two sink runs for this watch. Ticks arrive faster than a process can start,
    /// so frames in between are coalesced into the next run rather than spawning per frame.
    #[serde(default)]
    pub notify_min_interval_ms: Option<u64>,
    /// A cron job to fire the moment the sink has finished with a batch of frames.
    ///
    /// The sink can start a module but has nowhere to send what it returns, so a module can
    /// record a frame and not act on it. Waking a registered job closes that without building a
    /// second order path: the pipeline that already places orders runs immediately instead of at
    /// its next scheduled minute. It runs under the cron context like any scheduled fire, which
    /// is what a trade started by an event should be.
    #[serde(default)]
    pub notify_job: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub mock: bool,
    /// The stream's `tick1s` declaration, resolved from config at registration — the event sink
    /// feeds matching frames to the 1-second aggregator (core collects; a module-private tick
    /// sqlite would be the fourth one). None = this watch collects nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick1s: Option<serde_json::Value>,
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
            sysmod_cache: None,
            recall: None,
            media_intake: Mutex::new(None),
            action_calls: Mutex::new(HashMap::new()),
        }
    }

    /// WS API transport — modules whose config.json declares `ws.actions` route those
    /// actions here instead of the sandbox (WebSocket-only APIs like 조건검색).
    /// Wire the result cache so `<param>CacheKey` inputs can be expanded (see `utils::cache_inputs`).
    pub fn with_sysmod_cache(
        mut self,
        cache: Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>,
    ) -> Self {
        self.sysmod_cache = Some(cache);
        self
    }

    /// Wire the store a module's `remember` block writes to.
    pub fn with_recall(mut self, recall: Arc<dyn IMemoryFacadePort>) -> Self {
        self.recall = Some(recall);
        self
    }

    /// Wire the media store a module's `_mediaImport` output file is carried into.
    /// Post-construction (`&self`) because MediaManager is built after this manager.
    pub fn set_media_intake(&self, intake: Arc<dyn crate::managers::media::IMediaIntakePort>) {
        *self.media_intake.lock().unwrap() = Some(intake);
    }

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

    /// The module a `user/modules/<name>` path addresses, when it addresses one.
    ///
    /// `execute` takes a path and `run` takes a name, and for a user module they mean the same
    /// thing — which is why the path form must not be a second way in. A deeper path (a script
    /// inside the module) is not a module call and stays on the raw path.
    pub fn module_name_of_user_path(target_path: &str) -> Option<&str> {
        let rest = target_path
            .trim_end_matches('/')
            .strip_prefix("user/modules/")?;
        (!rest.is_empty() && !rest.contains('/') && is_safe_name(rest)).then_some(rest)
    }

    /// `execute(path)` for a user module — the same rung `run` uses.
    ///
    /// `execute` went straight to the sandbox, so a user module skipped every one of them:
    /// `is_enabled` (a module the owner switched off still ran), the pre-spawn input validation
    /// this file calls the defence against silent corruption, auto-cache (a large result landed
    /// whole in the context instead of behind a key), the declared timeout, and the timeseries
    /// store. Its declarations were read by nothing. A user module is a module — one rung, and the
    /// path form resolves to it (2026-08-16: `모듈이 안 돌면 모듈에서 고칠 수 있어야 한다` —
    /// a declaration that no path reads is a declaration the author cannot fix anything with).
    pub async fn execute_module_path(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        match Self::module_name_of_user_path(target_path) {
            Some(name) => self.run(name, input_data).await,
            None => self.execute(target_path, input_data, opts).await,
        }
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
        self.run_impl(module_name, input_data, false).await
    }

    /// Human-UI run — [`run`] 과 동일하되 auto-cache 인라인 truncation 을 끔.
    /// gRPC ModuleService(= 프론트 라우트 /api/module/run · hub sysmod 패널 경로) 전용:
    /// 패널은 풀 데이터를 렌더해야 하는데 auto-cache 가 배열 ≥30 을 5행 프리뷰로 잘라
    /// 캘린더 실행기록 등이 조용히 굶던 것 fix. 모델 경로(FC/MCP/cron/파이프라인)는 [`run`].
    /// (WS 라우트 액션은 패널에서 호출하지 않아 스코프 밖 — ws_api 쪽 auto-cache 는 그대로.)
    pub async fn run_raw(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> InfraResult<ModuleOutput> {
        self.run_impl(module_name, input_data, true).await
    }

    /// Pipeline run — cache attached, rows kept whole.
    ///
    /// A step's output is read by the next step, not by a model, so the five-row preview that
    /// protects context is pure data loss here and a silent one: the step succeeds and the next
    /// step quietly works on a fraction (2026-08-01: 120 planned sweep runs became 5). The key is
    /// still attached, because a later step may prefer to pass it on.
    pub async fn run_for_pipeline(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> InfraResult<ModuleOutput> {
        self.run_impl_opts(module_name, input_data, false, true).await
    }

    async fn run_impl(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
        skip_auto_cache: bool,
    ) -> InfraResult<ModuleOutput> {
        self.run_impl_opts(module_name, input_data, skip_auto_cache, false)
            .await
    }

    async fn run_impl_opts(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
        skip_auto_cache: bool,
        keep_full_rows: bool,
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
        let (scope, dir_path, files, dir_fp) = {
            let user_dir = format!("user/modules/{}", module_name);
            let system_dir = format!("system/modules/{}", module_name);
            let user_entries = self.storage.list_dir(&user_dir).await.ok();
            let system_entries = self.storage.list_dir(&system_dir).await.ok();
            // Names for the entry-point search, and a fingerprint of the same listing so the
            // declaration cache can tell an edited directory from an untouched one. Both out of
            // one `list_dir` — the walk is already happening, and asking the filesystem twice for
            // what it just said is how a hot path grows a second cost nobody notices.
            let pick = |entries: Vec<crate::ports::DirEntry>| -> (Vec<String>, String) {
                let mut names = Vec::new();
                let mut parts = Vec::new();
                for e in entries.iter().filter(|e| !e.is_directory) {
                    names.push(e.name.clone());
                    parts.push(format!(
                        "{}:{}:{}",
                        e.name,
                        e.size.unwrap_or(0),
                        e.modified_ms.unwrap_or(0)
                    ));
                }
                parts.sort();
                (names, parts.join("\n"))
            };
            if let Some(e) = user_entries {
                let (names, fp) = pick(e);
                ("user", user_dir, names, fp)
            } else if let Some(e) = system_entries {
                let (names, fp) = pick(e);
                ("system", system_dir, names, fp)
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

        // Pipeline-dialect absorber — models (and plan-compiled steps) reuse the PIPELINE step
        // vocabulary `inputData` for the module envelope ({action, inputData:{...}}), which the
        // input schema rejects as an unknown property (12차 실측: 플랜이 inputData 봉투를 굳혀
        // 실행 턴이 검증 실패 반복으로 라운드를 소진 — 의도는 명백한데 어휘만 파이프라인 것).
        // Intent is unambiguous → absorb instead of teach: move `inputData`'s fields into
        // `params` when the schema declares params, else spread them flat. Never applied when
        // the schema itself defines `inputData` (a legitimate module field must not be shadowed).
        let normalized: Option<serde_json::Value> = (|| {
            let obj = input_data.as_object()?;
            let inner = obj.get("inputData")?.as_object()?.clone();
            let schema_props = config.as_ref()?.get("input")?.get("properties")?.as_object()?;
            if schema_props.contains_key("inputData") {
                return None;
            }
            let mut out = obj.clone();
            out.remove("inputData");
            if schema_props.contains_key("params") {
                let params = out
                    .entry("params".to_string())
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(p) = params.as_object_mut() {
                    for (k, v) in inner {
                        if !p.contains_key(&k) {
                            p.insert(k, v);
                        }
                    }
                }
            } else {
                for (k, v) in inner {
                    if !out.contains_key(&k) {
                        out.insert(k, v);
                    }
                }
            }
            Some(serde_json::Value::Object(out))
        })();
        if normalized.is_some() {
            dialect_absorbed(module_name, "envelope", "inputData wrapper spread to the top level");
        }
        let input_data: &serde_json::Value = normalized.as_ref().unwrap_or(input_data);

        // Undeclared-envelope absorber — the model wraps every argument in `params` (or `args` /
        // `input` / `arguments`) even when the schema is flat, and the wrapper is often a JSON
        // *string*. Measured 2026-08-09 (the BTC turn): technical-analysis takes flat
        // `{action, bars|barsCacheKey, …}`, the model sent `{action, params:"{\"barsCacheKey\":…}"}`,
        // so the cache key was invisible to the expander and validation refused on the missing
        // `bars`. Four refusals, then the per-turn cap, then the model gave up on the tool and did
        // the analysis in its head. Intent is unambiguous → absorb. Guarded: only when the schema
        // does NOT declare that key (a module with a real `params` field is untouched) and only
        // for fields the wrapper's owner has not already set at the top level.
        const ENVELOPE_KEYS: [&str; 4] = ["params", "args", "input", "arguments"];
        let unwrapped: Option<serde_json::Value> = (|| {
            let obj = input_data.as_object()?;
            let schema_props = config.as_ref()?.get("input")?.get("properties")?.as_object()?;
            let mut out: Option<serde_json::Map<String, serde_json::Value>> = None;
            for key in ENVELOPE_KEYS {
                if schema_props.contains_key(key) {
                    continue; // a declared field of that name is the module's own
                }
                let Some(raw) = obj.get(key) else { continue };
                let inner = match raw {
                    serde_json::Value::Object(m) => m.clone(),
                    serde_json::Value::String(s) => {
                        let t = s.trim();
                        if !t.starts_with('{') {
                            continue;
                        }
                        match serde_json::from_str::<serde_json::Value>(t) {
                            Ok(serde_json::Value::Object(m)) => m,
                            _ => continue,
                        }
                    }
                    _ => continue,
                };
                let target = out.get_or_insert_with(|| obj.clone());
                target.remove(key);
                for (k, v) in inner {
                    target.entry(k).or_insert(v);
                }
            }
            out.map(serde_json::Value::Object)
        })();
        if let Some(v) = &unwrapped {
            let keys: Vec<&str> = ENVELOPE_KEYS
                .iter()
                .copied()
                .filter(|k| input_data.get(*k).is_some() && v.get(*k).is_none())
                .collect();
            dialect_absorbed(
                module_name,
                "envelope",
                &format!("undeclared wrapper {:?} spread to the top level", keys),
            );
        }
        let input_data: &serde_json::Value = unwrapped.as_ref().unwrap_or(input_data);

        // Stringified-JSON dialect absorber — models sometimes send a nested field as a JSON
        // *string* ({"params": "{\"stk_cd\": ...}"}) instead of an object (2026-07-13 실측:
        // Claude CLI/MCP 경로 kiwoom 호출). Schema-guarded: only when the schema declares the
        // field as object/array AND the string strictly parses to that shape. Must mutate the
        // real input (not a validation copy) — the sandbox needs the parsed value too.
        let unstrung: Option<serde_json::Value> = (|| {
            let obj = input_data.as_object()?;
            let schema_props = config.as_ref()?.get("input")?.get("properties")?.as_object()?;
            let mut out: Option<serde_json::Map<String, serde_json::Value>> = None;
            for (k, v) in obj {
                let Some(s) = v.as_str() else { continue };
                let Some(ty) = schema_props
                    .get(k)
                    .and_then(|p| p.get("type"))
                    .and_then(|t| t.as_str())
                else {
                    continue;
                };
                let trimmed = s.trim();
                let shape_ok = match ty {
                    "object" => trimmed.starts_with('{'),
                    "array" => trimmed.starts_with('['),
                    _ => false,
                };
                if !shape_ok {
                    continue;
                }
                let Ok(parsed) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                    continue;
                };
                if (ty == "object" && parsed.is_object()) || (ty == "array" && parsed.is_array()) {
                    out.get_or_insert_with(|| obj.clone()).insert(k.clone(), parsed);
                }
            }
            out.map(serde_json::Value::Object)
        })();
        if let Some(v) = &unstrung {
            let keys: Vec<&String> = v
                .as_object()
                .map(|o| o.keys().filter(|k| input_data.get(*k).map(|x| x.is_string()).unwrap_or(false)
                        && !v.get(*k).map(|x| x.is_string()).unwrap_or(true)).collect())
                .unwrap_or_default();
            dialect_absorbed(
                module_name,
                "stringified-json",
                &format!("fields parsed from JSON text: {:?}", keys),
            );
        }
        let input_data: &serde_json::Value = unstrung.as_ref().unwrap_or(input_data);

        // Which registered account this call runs as (config `accounts`). Resolved once, here, so
        // the sandbox, the WS transport and the token provider all receive a concrete id — and so
        // an alias the user never registered fails with the registered ones listed instead of an
        // authentication error from the broker. `mock` follows the account rather than the caller:
        // a mock app key is rejected outright on the live domain (kiwoom 8030), so the two must
        // not be able to contradict each other.
        // A module can also run *as* an account it does not own. The trading module names the
        // broker and the alias per trade — the registry belongs to the broker — so nothing was
        // resolving them and `mock` never arrived. The fallback then read the strategy's own mode
        // instead of the account's, which meant a practice account was booked as live: caps for
        // real money applied to it, and the promotion ladder would have counted practice results
        // as evidence, which is the one thing the ladder exists to prevent (measured 2026-08-03).
        //
        // `accountFrom` names the input field holding the owning module. Only the same two fields
        // are injected, and only when the schema declares them, so this hands over the account's
        // *nature* and never its credentials — those are env, from `secrets`, unchanged.
        let borrowed_owner = config
            .as_ref()
            .filter(|c| c.get("accounts").is_none())
            .and_then(|c| c.get("accountFrom").and_then(|v| v.as_str()))
            .and_then(|field| input_data.get(field).and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|owner| !owner.is_empty() && is_safe_name(owner))
            .map(str::to_string);
        let borrowed: Option<serde_json::Value> = match (
            &borrowed_owner,
            config.as_ref(),
            input_data.as_object(),
        ) {
            (Some(owner), Some(cfg), Some(obj)) => {
                let reg = self.account_registry_effective(owner).await;
                let requested = input_data.get("account").and_then(|v| v.as_str());
                // A miss is not fatal here: this module is not the one about to authenticate, and
                // the broker call that follows raises the specific error. Saying nothing leaves
                // `mock` absent, which the module reads as "unknown" rather than as "real".
                match reg.resolve(requested) {
                    Ok(Some(entry)) => {
                        // A market the account was not registered for is not a miss — the alias
                        // resolved, it is simply for somewhere else. Say so here rather than let
                        // the cycle run its remaining steps and hand the venue an order it will
                        // refuse: this is the first step, so refusing costs one call. Whether
                        // markets mean anything is the *owner's* declaration, not this module's.
                        let owner_markets = self
                            .module_config(owner)
                            .await
                            .map(|c| crate::utils::account_secrets::declared_markets(&c))
                            .unwrap_or_default();
                        if let Some(detail) = crate::utils::account_secrets::market_refusal(
                            entry,
                            &owner_markets,
                            input_data.get("market").and_then(|v| v.as_str()),
                        ) {
                            return Err(crate::i18n::t(
                                "core.error.module.input_validation_failed",
                                None,
                                &[("name", module_name), ("detail", &detail)],
                            ));
                        }
                        let mut out = obj.clone();
                        if cfg.pointer("/input/properties/mock").is_some() {
                            out.insert("mock".to_string(), serde_json::json!(entry.is_mock()));
                        }
                        if cfg.pointer("/input/properties/accountNo").is_some() {
                            let digits = entry.digits();
                            if !digits.is_empty() {
                                out.insert("accountNo".to_string(), serde_json::json!(digits));
                            }
                        }
                        // The market too, when the account settles it — one registered market
                        // means no ambiguity, so the account decides (same rule as `mock`). A
                        // call naming no market used to fall to the module's own guess: a
                        // KR-registered mock account's balance read went out on the US endpoint
                        // and answered "no holdings" (2026-08-06 실측).
                        if cfg.pointer("/input/properties/market").is_some()
                            && obj
                                .get("market")
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|m| !m.is_empty())
                                .is_none()
                            && entry.markets.len() == 1
                        {
                            out.insert(
                                "market".to_string(),
                                serde_json::json!(entry.markets[0].clone()),
                            );
                        }
                        Some(serde_json::Value::Object(out))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        let input_data: &serde_json::Value = borrowed.as_ref().unwrap_or(input_data);

        let account_scoped: Option<serde_json::Value> = match config
            .as_ref()
            .filter(|c| c.get("accounts").is_some())
        {
            Some(cfg) => {
                // Its own accounts, plus the primary inherited from the base module a split
                // broker declares — the relationship is registered once and the trading half
                // adds the accounts orders go to.
                let reg = crate::utils::account_secrets::AccountRegistry::load_with_base(
                    self.vault.as_ref(),
                    module_name,
                    crate::utils::account_secrets::credential_scope(cfg).as_deref(),
                );
                let requested = input_data.get("account").and_then(|v| v.as_str());
                let entry = reg
                    .resolve(requested)
                    .map_err(|detail| {
                        crate::i18n::t(
                            "core.error.module.input_validation_failed",
                            None,
                            &[("name", module_name), ("detail", &detail)],
                        )
                    })?
                    .cloned();
                // A module that declares accounts has no credentials of its own — "none registered"
                // is a setup step, not a reason to try the call and let the broker refuse it.
                let entry = match entry {
                    Some(e) => e,
                    None => {
                        let known: Vec<String> =
                            reg.accounts.iter().map(|a| a.id.clone()).collect();
                        let detail = if known.is_empty() {
                            "no account is registered for this module — register one (app key + secret) in the module settings first.".to_string()
                        } else {
                            format!(
                                "no primary account is designated — pass `account` as one of: {}.",
                                known.join(", ")
                            )
                        };
                        return Err(crate::i18n::t(
                            "core.error.module.input_validation_failed",
                            None,
                            &[("name", module_name), ("detail", &detail)],
                        ));
                    }
                };
                // The account and the market are named in two different places — the registry and
                // the call — and until this they could disagree forever. Checked before the
                // credential slots so the message names the real problem: an empty slot on an
                // account that was never the right one reads as a registration you still have to do.
                if let Some(detail) = crate::utils::account_secrets::market_refusal(
                    &entry,
                    &crate::utils::account_secrets::declared_markets(cfg),
                    input_data.get("market").and_then(|v| v.as_str()),
                ) {
                    return Err(crate::i18n::t(
                        "core.error.module.input_validation_failed",
                        None,
                        &[("name", module_name), ("detail", &detail)],
                    ));
                }
                match (Some(entry), input_data.as_object()) {
                    (Some(e), Some(obj)) => {
                        // Credentials do not fall back to the module-wide values: running a mock
                        // account on the live app key looks like it worked until the broker says
                        // otherwise. Say which slot is empty instead.
                        let (declared, _) = Self::declared_secret_names(cfg);
                        let missing: Vec<&str> = declared
                            .iter()
                            .filter(|name| {
                                self.vault
                                    .get_secret(&crate::utils::account_secrets::secret_key(
                                        name,
                                        Some(&e.id),
                                        false,
                                    ))
                                    .is_none()
                            })
                            .map(|s| s.as_str())
                            .collect();
                        if !missing.is_empty() {
                            return Err(crate::i18n::t(
                                "core.error.module.input_validation_failed",
                                None,
                                &[
                                    ("name", module_name),
                                    (
                                        "detail",
                                        &format!(
                                            "account '{}' has no {} stored — register it in the module settings.",
                                            e.id,
                                            missing.join(", ")
                                        ),
                                    ),
                                ],
                            ));
                        }
                        let mut out = obj.clone();
                        out.insert("account".to_string(), serde_json::json!(e.id));
                        // Only when the module actually has a mock notion — nothing else may
                        // learn a field its schema never declared.
                        if cfg
                            .pointer("/input/properties/mock")
                            .is_some()
                        {
                            out.insert("mock".to_string(), serde_json::json!(e.is_mock()));
                        }
                        // The number, for brokers whose request body carries it. Kiwoom does not
                        // need it — the credential IS the account there — but Korea Investment
                        // splits the same digits into CANO + ACNT_PRDT_CD on every order and
                        // balance call, and the registry is the only place it is written down.
                        // Same rule as `mock`: injected only where the schema says the module
                        // reads it, so nothing learns a field it never declared.
                        if cfg.pointer("/input/properties/accountNo").is_some() {
                            let digits = e.digits();
                            if !digits.is_empty() {
                                out.insert("accountNo".to_string(), serde_json::json!(digits));
                            }
                        }
                        // Same as the borrow path above: one registered market = the account
                        // decides; without this a market-less call fell to the module's guess.
                        if cfg.pointer("/input/properties/market").is_some()
                            && obj
                                .get("market")
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|m| !m.is_empty())
                                .is_none()
                            && e.markets.len() == 1
                        {
                            out.insert(
                                "market".to_string(),
                                serde_json::json!(e.markets[0].clone()),
                            );
                        }
                        tracing::info!(
                            target: "module",
                            module = %module_name,
                            account = %e.id,
                            mock = e.is_mock(),
                            "running as registered account"
                        );
                        Some(serde_json::Value::Object(out))
                    }
                    _ => None,
                }
            }
            None => None,
        };
        let input_data: &serde_json::Value = account_scoped.as_ref().unwrap_or(input_data);

        // Scalar coercion used to be validation-only — "the module runtime coerces strings in
        // arithmetic" — and that assumption failed the first module that checks its types instead
        // of doing arithmetic on them: kma-weather reads `typeof lat === 'number'`, so a
        // "37.5665" that PASSED validation as a number arrived as a string, the grid conversion
        // silently skipped, and a caller who did send coordinates was told to send coordinates
        // (measured 2026-08-08 over MCP, where the reduced discovery schema makes string-typed
        // numbers routine). If validation needed the coerced value to pass, the module receives
        // the coerced value: the declared type is the contract, not a hint.
        let repaired = repair_input(
            module_name,
            config.as_ref(),
            input_data,
            self.sysmod_cache.as_ref(),
        )?;
        let input_data: &serde_json::Value = repaired.as_ref().unwrap_or(input_data);

        // Pre-spawn input validation — against config.json's input schema (this is L4 of the
        // uniform tool procedure). The error hint = next-step pointer: every module is now
        // discoverable (explicit actionCatalog OR derived from the input schema), so the hint
        // uniformly points back to search_module_actions → get_action_schema.
        if let Some(config) = &config {
            if let Some(input_schema) = config.get("input") {
                let for_val = input_for_validation(input_data, input_schema);
                if let Err(detail) = validate_value(&for_val, input_schema) {
                    // 도구↔액션 짝 어긋남이면 소유 모듈을 짚어준다 — 실측 2026-07-27:
                    // `("kakao_map","v1_국내주식-008")` 처럼 한 라운드에 여러 도구를 병렬 호출하다
                    // 짝이 엇갈렸다. sysmod 도구는 발견 강제를 위해 파라미터가 숨겨져 있어 어느
                    // 도구든 임의 action 문자열을 받으므로 이 검증이 유일한 그물이다. 기존 힌트는
                    // "다시 search→schema 하라" 라 라운드를 하나 더 쓰는데, 인자는 이미 맞으므로
                    // 옳은 도구 이름만 알려주면 바로 성공한다("각 계단이 다음 수를 스스로 말해야").
                    if let Some(action) = input_data.get("action").and_then(|v| v.as_str()) {
                        if !schema_declares_action(input_schema, action) {
                            if let Some(owner) = self.find_action_owner(action, module_name).await {
                                return Err(crate::i18n::t(
                                    "core.error.module.input_validation_failed_wrong_module",
                                    None,
                                    &[
                                        ("name", module_name),
                                        ("detail", &detail),
                                        ("action", action),
                                        ("owner", &owner),
                                    ],
                                ));
                            }
                        }
                    }
                    let mut msg = crate::i18n::t(
                        "core.error.module.input_validation_failed_catalog",
                        None,
                        &[("name", module_name), ("detail", &detail)],
                    );
                    // A failing cacheInputs param gets its cheapest correct next step named:
                    // pass the producing call's key. Turn 34 (2026-08-11) hand-reassembled DART
                    // rows via cache_grep for seven rounds and broke the JSON mid-retype, while
                    // the live statementsCacheKey sat unused — the generic "search→schema" hint
                    // sends the model back up the ladder when the fix is one field rename.
                    for param in crate::utils::cache_inputs::declared(config) {
                        if detail.contains(&format!("/{param}")) || detail.contains(&format!("'{param}'")) {
                            // Say WHERE the key goes, not just that it is accepted. "`statements`
                            // accepts `statementsCacheKey`" reads as "put it inside statements",
                            // and that is exactly how it was read: turn 49 (2026-08-13) tried
                            // `{"_cacheKey": …}`, `[{"_cacheKey": …}]` and
                            // `[{"statementsCacheKey": …}]` in the value slot over four rounds,
                            // reasoning each time that the description "suggests" a sibling it
                            // could not see. A hint that names the slot ends that guessing.
                            msg.push_str(&format!(
                                " Send `{param}CacheKey`: \"<the producing call's _cacheKey>\" as its OWN top-level parameter — a sibling of `{param}`, not a value inside it — and omit `{param}` entirely; the server fills it. Several keys may go in a list (`[\"key1\",\"key2\"]`) and their rows are concatenated. For part of the table add `{param}Limit`:N (most-recent N) or `{param}Range`:{{from,to}} beside the key."
                            ));
                            break;
                        }
                    }
                    // A JSON-LOOKING string that does not parse is almost always a hand-typed
                    // serialization broken mid-stream (escape slip or output truncation) — the
                    // generic "search→schema" hint sends the model back up the ladder when the
                    // real fix is "resend the actual value" (2026-08-12: a giant `sheets` string
                    // died this way; turn 34's statements rows before it). Valid strings never
                    // reach here — coercion already parses those.
                    if let Some(in_obj) = input_data.as_object() {
                        for (k, v) in in_obj {
                            if !(detail.contains(&format!("/{k}"))
                                || detail.contains(&format!("'{k}'")))
                            {
                                continue;
                            }
                            if let Some(hint) = broken_json_string_hint(k, v) {
                                msg.push_str(&hint);
                                break;
                            }
                        }
                    }
                    return Err(msg);
                }
            }
        }

        // What this module learned before, handed back to the actions that asked for it.
        //
        // Injected *after* validation and under a framework-owned key, so a module does not have
        // to declare a property it never sends and an `additionalProperties: false` schema does
        // not reject the framework's own addition. A module cannot read the store any more than
        // it can write to it; this is the read half of the same arrangement.
        let with_recall = self.inject_recall(module_name, config.as_ref(), input_data).await;
        let input_data: &serde_json::Value = with_recall.as_ref().unwrap_or(input_data);

        // The action's own declaration, handed over so the module does not carry everyone else's.
        // Before the WS route as well as the sandbox: both are ways of issuing the same declared
        // action, and a transport that had to be told separately is a transport that gets missed.
        let with_call = self
            .inject_action_call(scope, module_name, &dir_fp, config.as_ref(), input_data)
            .await;
        let input_data: &serde_json::Value = with_call.as_ref().unwrap_or(input_data);

        // WS-only actions (config.json `ws` declarative) — route to the WS transport instead of
        // the sandbox. Common infra + per-module config data = no per-provider WS code in modules
        // (TokenProvider pattern). Undeclared actions fall through to the sandbox as before.
        let ws_result = if let Some(ws_decl) = config.as_ref().and_then(|c| c.get("ws")) {
            self.try_ws_route(module_name, scope, &dir_path, ws_decl, input_data)
                .await?
        } else {
            None
        };

        let mut result = match ws_result {
            Some(r) => r,
            None => {
                let target = format!("{}/{}", dir_path, entry);
                // 시계열 영구 store 선언 (config `timeseries`) — 스펙은 core 가 데이터로 파싱,
                // 갭 축소·병합·서빙은 sandbox choke-point (rows 실물이 있는 곳). 미선언·범위
                // 비명시·limit 호출 = None (기존 30분 ephemeral 경로 그대로).
                // Declared whole-object caching — `autoCacheWhole` marks actions whose
                // response is one structured datum (multi-section, output1..output4 style)
                // rather than a rows table. Two declaration forms:
                //   ["<action>", …]              — cache whole, generic note
                //   {"<action>": "<note>", …}    — cache whole, and the note NAMES the
                //                                  consumer. The generic "pass this key to a
                //                                  <param>CacheKey input" note was ignored in
                //                                  the field: the model hand-decoded the
                //                                  unlabeled KIS rows again and shipped YoY
                //                                  percentages labeled 영업이익 (turn 39,
                //                                  2026-08-12). A note that says exactly
                //                                  where the key goes leaves nothing to
                //                                  improvise.
                let act = input_data
                    .get("action")
                    .and_then(|a| a.as_str())
                    .unwrap_or("");
                let (cache_whole, cache_whole_note) = match config
                    .as_ref()
                    .and_then(|c| c.get("autoCacheWhole"))
                {
                    Some(serde_json::Value::Array(list)) => (
                        list.iter().filter_map(|v| v.as_str()).any(|a| a == act),
                        None,
                    ),
                    Some(serde_json::Value::Object(map)) => match map.get(act) {
                        Some(n) => (true, n.as_str().map(String::from)),
                        None => (false, None),
                    },
                    _ => (false, None),
                };
                let mut exec_opts = SandboxExecuteOpts {
                    skip_auto_cache,
                    keep_full_rows,
                    cache_whole,
                    cache_whole_note,
                    ..SandboxExecuteOpts::default()
                };
                // Whether a person is waiting on the other end. A module that can spend money
                // needs to know: a scheduled run was authorised when it was scheduled, a chat
                // message was not, and the same call must not mean the same thing in both.
                //
                // The autotrade module has read this since it was written and nothing ever set
                // it, so every scheduled cycle looked interactive, demoted itself to paper, and
                // booked fills nobody placed — the exchange had no record of a single order
                // while the ledger showed two (2026-08-02).
                // ...unless a person is the one waiting. The cron flag is process-wide, so a
                // screen action confirmed while any scheduled pipeline happened to be mid-flight
                // was handed FIREBAT_UNATTENDED=1 and refused with "스케줄에서는 동작하지
                // 않습니다" — measured 2026-08-07 by a probe that collided with the 5-minute
                // autotrade cron. The person-only actions would have refused a real click perhaps
                // one time in five, and the message would have named the wrong reason.
                if crate::utils::cron_context::is_cron_context_active()
                    && !crate::utils::pending_tools::ui_confirmed()
                {
                    exec_opts
                        .env
                        .insert("FIREBAT_UNATTENDED".to_string(), "1".to_string());
                }
                // Per-call timeout — a module that composes others holds its process open while
                // each callee runs, so the 60s default is the caller's whole budget rather than
                // one API round trip.
                if let Some(ms) = config
                    .as_ref()
                    .and_then(|c| c.get("timeoutMs"))
                    .and_then(|v| v.as_u64())
                {
                    exec_opts.timeout_ms = Some(ms.clamp(1_000, 600_000));
                }
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

        // The answer names the account it is for. The registry resolves an unnamed call to the
        // designated primary — a deliberate convenience — but a caller reasoning about one account
        // can then read another's numbers without any visible seam: measured 2026-08-06, a
        // "close the mock-KR account" turn read the primary (real) account's empty stock list and
        // concluded there was nothing to sell. The injected input already knows the resolution;
        // stamping it on the reply lets the reader see the mismatch instead of trusting the
        // question it asked.
        if let Some(scoped) = account_scoped.as_ref() {
            if let Some(data) = result.data.as_object_mut() {
                if !data.contains_key("account") {
                    if let Some(alias) = scoped.get("account") {
                        data.insert("account".to_string(), alias.clone());
                    }
                    if let Some(mock) = scoped.get("mock") {
                        data.entry("mock".to_string()).or_insert_with(|| mock.clone());
                    }
                }
            }
        }

        // Approval-gated actions get their response logged in full, once, here.
        //
        // Order acknowledgement schemas are not documented anywhere we can trust, and the two
        // places a response would otherwise survive both lose it: the sandbox log keeps a 156-char
        // preview, and the result cache expires in thirty minutes. Without this line, "collect the
        // shapes from the logs later" is not a plan — there is nothing in the log to collect. The
        // volume is self-limiting: these are orders, not queries.
        if let Some(cfg) = &config {
            let action = input_data.get("action").and_then(|v| v.as_str()).unwrap_or("");
            if !action.is_empty()
                && crate::utils::pending_tools::requires_approval_value(
                    cfg.get("requiresApproval").unwrap_or(&serde_json::Value::Null),
                    action,
                )
            {
                tracing::info!(
                    target: "module_order",
                    module = %module_name,
                    action = %action,
                    success = result.success,
                    request = %serde_json::to_string(input_data).unwrap_or_default(),
                    response = %serde_json::to_string(&result.data).unwrap_or_default(),
                    "approval-gated action response"
                );
            }
        }

        // An errorKey is an ID, not an explanation. The MCP handler resolved it downstream, but
        // the FC handler serializes ModuleOutput verbatim — so the model received the bare key
        // ("error.period_required") while the lang file's sentence naming the exact params sat
        // unread, and it brute-forced param combinations for six rounds (2026-08-11 turn 33).
        // Resolve once here, the choke point both surfaces share; MCP's own resolver reads the
        // same key and lands on the same sentence, so nothing drifts.
        if !result.success && result.error.is_none() {
            if let Some(key) = &result.error_key {
                let owned: Vec<(String, String)> = result
                    .error_params
                    .as_ref()
                    .and_then(|v| v.as_object())
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
                result.error = Some(crate::i18n::t(
                    &format!("module.{}.{}", module_name, key),
                    None,
                    &refs,
                ));
            }
        }

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

        // Anything the module asked to be remembered, written under the module's own scope.
        // After the output check, because a module whose data failed validation has not earned
        // the right to teach anybody anything.
        if result.success {
            self.remember_declared(module_name, &result).await;
        }

        // A file the module made walks OUT through the media door — same gated save uploads
        // walk in through, so a lying extension is refused here too. The module stays dumb:
        // it writes to its own data/ scratch and declares `_mediaImport`; the framework carries.
        if result.success {
            self.export_declared_media(module_name, &mut result).await;
        }

        Ok(result)
    }

    /// `data._mediaImport = {path, contentType?, filenameHint?}` → media store → `data.media`.
    ///
    /// Failure never fails the module run — the work product exists on disk either way — but it
    /// is never silent: the declaration is replaced by `data.mediaExportError` and a WARN. The
    /// source file is removed after a successful import only when it sits in `data/` (module
    /// scratch); anything under `user/` is the user's and stays.
    async fn export_declared_media(&self, module_name: &str, result: &mut ModuleOutput) {
        let Some(obj) = result.data.as_object_mut() else { return };
        let Some(decl) = obj.remove("_mediaImport") else { return };

        let fail = |obj: &mut serde_json::Map<String, serde_json::Value>, msg: String| {
            tracing::warn!(module = module_name, error = %msg, "[ModuleManager] media export failed");
            obj.insert("mediaExportError".to_string(), serde_json::Value::String(msg));
        };

        let path = decl.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let Some(norm) = media_export_path(&path) else {
            return fail(obj, format!(
                "_mediaImport.path must be workspace-relative under data/ or user/ (got {path:?})"
            ));
        };
        let Some(intake) = self.media_intake.lock().unwrap().clone() else {
            return fail(obj, "_mediaImport declared but no media store is wired".to_string());
        };

        let bin = match self.storage.read_binary(&norm).await {
            Ok(b) => b,
            Err(e) => return fail(obj, format!("_mediaImport read failed for {norm}: {e}")),
        };
        const MAX_EXPORT_BYTES: usize = 50 * 1024 * 1024;
        if bin.size > MAX_EXPORT_BYTES {
            return fail(obj, format!(
                "_mediaImport file too large ({} bytes > {MAX_EXPORT_BYTES})", bin.size
            ));
        }
        use base64::Engine as _;
        let binary = match base64::engine::general_purpose::STANDARD.decode(&bin.base64) {
            Ok(b) => b,
            Err(e) => return fail(obj, format!("_mediaImport decode failed: {e}")),
        };

        // The declared type wins; the storage adapter's sniff is the fallback. Either way the
        // media gate re-verifies the bytes, so a wrong claim is refused, not stored.
        let content_type = decl
            .get("contentType")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or(bin.mime_type);
        let filename_hint = decl
            .get("filenameHint")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| {
                norm.rsplit('/').next().and_then(|f| f.rsplit_once('.')).map(|(stem, _)| stem.to_string())
            });
        let opts = crate::ports::MediaSaveOptions {
            filename_hint: filename_hint.clone(),
            source: Some(format!("module:{module_name}")),
            ..Default::default()
        };
        match intake.intake(binary, &content_type, opts).await {
            Ok(saved) => {
                if norm.starts_with("data/") {
                    let _ = self.storage.delete(&norm).await;
                }
                // The one name this file should be called everywhere: the module's hint plus the
                // real extension, falling back to the address when there is no hint.
                let ext = saved.url.rsplit('.').next().unwrap_or("").to_string();
                let link_text = match (&filename_hint, ext.is_empty()) {
                    (Some(h), false) => format!("{h}.{ext}"),
                    (Some(h), true) => h.clone(),
                    (None, _) => saved.url.rsplit('/').next().unwrap_or(&saved.url).to_string(),
                };
                let url_for_note = saved.url.clone();
                obj.insert(
                    "media".to_string(),
                    serde_json::json!({
                        "slug": saved.slug,
                        "url": saved.url,
                        "bytes": bin.size,
                        "contentType": content_type,
                        // The human name the module chose, echoed back. The media record keeps it
                        // and the gallery shows it, but the response carried only the slug — so a
                        // produced-file card downloaded "2026-08-12-…-76ca.xlsx" while the gallery
                        // offered "SK하이닉스-…-대시보드.xlsx": one file, two names (2026-08-12
                        // 사용자 보고). The produced-file detector already prefers this field.
                        "filenameHint": filename_hint,
                        // Consumption-point guidance — nothing anywhere told the model what to
                        // DO with this url, so it improvised an Image block around an .xlsx and
                        // the UI spun on "generating image" forever (2026-08-12 실측). The note
                        // arrives exactly when the model holds the url; zero resident prompt.
                        // The link TEXT is dictated, not left to the model, because that text is
                        // the file's name in three places at once: the card label, the browser's
                        // download name (the card sets `download` from it), and the only name the
                        // NEXT turn can see — history carries the answer's prose, not this
                        // record. Left free, the model typed the slug: the user downloaded
                        // "…-f834.xlsx" while the gallery showed the real name (2026-08-13 실측).
                        "note": format!(
                            "Attach this in your answer as exactly this markdown link — [{}]({}) \
                             — it renders as a downloadable file card, and that link text is the \
                             filename the user gets. Do not substitute the url or the slug for \
                             the text. Never put a document url in an Image/image block (images \
                             only).",
                            link_text, url_for_note
                        ),
                    }),
                );
            }
            Err(e) => fail(obj, format!("media import refused: {e}")),
        }
    }

    /// The module's own record, for an action its config named in `recall.actions`.
    ///
    /// Returns None when nothing is declared, nothing is stored, or the store is not wired — in
    /// each case the module runs exactly as it did before, which is what makes this safe to add
    /// to a module that has never heard of it.
    /// This module's `action id → call` rows, re-read only when its directory changed.
    ///
    /// The fingerprint is the listing dispatch already performed, so an unchanged module costs a
    /// map lookup and a changed one costs the read it would have cost anyway. Whole-tree
    /// fingerprinting — what the action catalog uses — would be wrong here: it walks forty
    /// directories to answer a question about one, on a path that runs per call.
    async fn action_calls_for(
        &self,
        scope: &str,
        module_name: &str,
        dir_fp: &str,
        config: &serde_json::Value,
    ) -> Arc<HashMap<String, serde_json::Value>> {
        let key = format!("{}:{}", scope, module_name);
        if let Ok(cache) = self.action_calls.lock() {
            if let Some(hit) = cache.get(&key).filter(|c| c.fingerprint == dir_fp) {
                return hit.calls.clone();
            }
        }
        let rows = match crate::utils::action_decl::catalog_file(config) {
            Some(file) => self
                .read_module_file(scope, module_name, file)
                .await
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| crate::utils::action_decl::catalog_rows(&v))
                .unwrap_or_default(),
            None => crate::utils::action_decl::inline_catalog_rows(config).unwrap_or_default(),
        };
        let calls = Arc::new(crate::utils::action_decl::action_calls(&rows));
        if let Ok(mut cache) = self.action_calls.lock() {
            cache.insert(
                key,
                CachedCalls {
                    fingerprint: dir_fp.to_string(),
                    calls: calls.clone(),
                },
            );
        }
        calls
    }

    /// Hand the module the row for the action it was asked to run, as `_call`.
    ///
    /// A call is for one action. Before this, a module that needed its endpoint carried every
    /// action's — korea-invest shipped a generated 62KB table and parsed it on every spawn to
    /// read five fields off one entry, and the table had to be regenerated, deployed and kept in
    /// step with the declaration it was already a projection of. The declaration is here; the
    /// module is one process away; the row can simply travel.
    ///
    /// `None` when the module declares no `_call` for this action, which leaves the input exactly
    /// as it was — every module that resolves its own endpoints keeps doing so.
    async fn inject_action_call(
        &self,
        scope: &str,
        module_name: &str,
        dir_fp: &str,
        config: Option<&serde_json::Value>,
        input_data: &serde_json::Value,
    ) -> Option<serde_json::Value> {
        let action = input_data.get("action").and_then(|v| v.as_str())?;
        let calls = self
            .action_calls_for(scope, module_name, dir_fp, config?)
            .await;
        let call = calls.get(action)?;
        let mut obj = input_data.as_object()?.clone();
        obj.insert("_call".to_string(), call.clone());
        Some(serde_json::Value::Object(obj))
    }

    async fn inject_recall(
        &self,
        module_name: &str,
        config: Option<&serde_json::Value>,
        input_data: &serde_json::Value,
    ) -> Option<serde_json::Value> {
        let spec = crate::utils::module_memory::parse_recall_spec(config?)?;
        let action = input_data.get("action").and_then(|v| v.as_str()).unwrap_or("");
        if !spec.covers(action) {
            return None;
        }
        let recall = self.recall.as_ref()?;
        let owner = crate::utils::owner::for_module(None, module_name);
        let facts = recall.recent_facts(Some(&owner), spec.limit).await.ok()?;
        let lessons = crate::managers::memory_file::MemoryFileManager::new(self.storage.clone())
            .list(Some(&owner))
            .await
            .unwrap_or_default();
        if facts.is_empty() && lessons.is_empty() {
            return None;
        }
        let obj = input_data.as_object()?.clone();
        let mut obj = obj;
        obj.insert(
            "_recall".to_string(),
            serde_json::json!({
                "owner": owner,
                "facts": facts.iter().map(|f| serde_json::json!({
                    "content": f.content,
                    "factType": f.fact_type,
                    "createdAt": f.created_at,
                })).collect::<Vec<_>>(),
                "lessons": lessons.iter().map(|l| serde_json::json!({
                    "name": l.name,
                    "description": l.description,
                    "content": l.content,
                    "confidence": l.confidence,
                })).collect::<Vec<_>>(),
            }),
        );
        tracing::info!(
            target: "module_memory", module = %module_name, action = %action, owner = %owner,
            facts = facts.len(), lessons = lessons.len(),
            "recall: handed the module its own record"
        );
        Some(serde_json::Value::Object(obj))
    }

    /// Write a module's `remember` block into recall, scoped to that module.
    ///
    /// The module names what it learned; the framework decides where it goes and who it belongs
    /// to. A sandboxed process cannot reach the store and should not be able to claim someone
    /// else's scope, so the owner is derived here from the module that just ran.
    ///
    /// Measurements go in as explicit facts and lessons go in staged — the reasoning for the
    /// split is in `utils::module_memory`.
    async fn remember_declared(&self, module_name: &str, result: &ModuleOutput) {
        let Some(block) = result.remember.as_ref() else {
            return;
        };
        let declared =
            crate::utils::module_memory::parse(&serde_json::json!({ "remember": block }));
        if !declared.rejected.is_empty() {
            // Unreadable entries are named. A declaration that quietly goes nowhere is the same
            // failure as a config tag typed as a string — it looks like it works for weeks.
            tracing::warn!(
                target: "module_memory", module = %module_name,
                rejected = %declared.rejected.join("; "),
                "remember: entries could not be read and were not stored"
            );
        }
        if declared.is_empty() {
            return;
        }
        let owner = crate::utils::owner::for_module(None, module_name);
        let Some(recall) = self.recall.as_ref() else {
            tracing::warn!(
                target: "module_memory", module = %module_name,
                facts = declared.facts.len(), lessons = declared.lessons.len(),
                "remember: recall is not wired, so nothing was stored"
            );
            return;
        };

        let (mut facts, mut failed) = (0usize, 0usize);
        for fact in &declared.facts {
            let entity_id = match recall.find_entity_by_name(&fact.entity, Some(&owner)) {
                Ok(Some(rec)) => Some(rec.id),
                _ => recall
                    .save_entity(crate::utils::module_memory::entity_input(fact, &owner))
                    .await
                    .ok()
                    .map(|(id, _)| id),
            };
            let Some(entity_id) = entity_id else {
                failed += 1;
                continue;
            };
            match recall
                .save_fact(crate::utils::module_memory::fact_input(fact, entity_id, &owner))
                .await
            {
                Ok(_) => facts += 1,
                Err(_) => failed += 1,
            }
        }

        let mut lessons = 0usize;
        if !declared.lessons.is_empty() {
            // The lesson store is a thin layer over the storage port this manager already holds,
            // so it is built from that port rather than borrowed as another manager's handle.
            let files = crate::managers::memory_file::MemoryFileManager::new(self.storage.clone());
            for lesson in &declared.lessons {
                let entry = crate::managers::memory_file::MemoryEntry {
                    name: lesson.name.clone(),
                    category: lesson.category.clone(),
                    description: lesson.description.clone(),
                    content: lesson.content.clone(),
                    confidence: crate::utils::module_memory::LESSON_CONFIDENCE,
                };
                match files.save(Some(&owner), &entry).await {
                    Ok(()) => lessons += 1,
                    Err(_) => failed += 1,
                }
            }
        }

        tracing::info!(
            target: "module_memory", module = %module_name, owner = %owner,
            facts, lessons, failed,
            "remember: stored what the module declared"
        );
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
            account: input_data
                .get("account")
                .and_then(|v| v.as_str())
                .map(String::from),
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
        notify: StreamNotify,
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
        // The id is DERIVED from the intent, not drawn fresh.
        //
        // A random suffix made the documented idempotency a half-truth: the same
        // module+stream+args returned the existing watch only while that watch was alive. Stop it
        // and start it again — a restart, a cleanup, a mistake — and the same intent produced a
        // NEW id, so the topic changed and every page that had baked the old topic into its spec
        // went silently dead (2026-08-10: two published Samsung pages, and nothing said so).
        // Hashing the intent makes the promise true across restarts, so a watch can be recreated
        // without hunting down its consumers.
        let watch_id = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            module_name.hash(&mut h);
            stream_key.hash(&mut h);
            args_norm.hash(&mut h);
            format!("ws-{}-{}-{:08x}", module_name, stream_key, h.finish() as u32)
        };
        // Collection is declared on the stream, not chosen by the caller — resolved once here so
        // the sink (a sync closure) reads it off the meta without touching config.
        let tick1s = self
            .module_config(module_name)
            .await
            .and_then(|c| c.pointer(&format!("/ws/streams/{stream_key}/tick1s")).cloned());
        let meta = StreamWatchMeta {
            topic: format!("ws-stream:{watch_id}"),
            watch_id,
            module: module_name.to_string(),
            stream: stream_key.to_string(),
            args: args.clone(),
            notify: notify.to,
            notify_action: notify.action,
            notify_min_interval_ms: notify.min_interval_ms,
            notify_job: notify.job,
            label,
            mock,
            tick1s,
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

    /// Relaunches this module's persisted watches that are not currently live.
    ///
    /// A watch whose restore failed is only logged, and nothing retries it — so a watch outlives
    /// the credentials it was created with. Keys get rotated, revoked, re-registered, or migrated
    /// (2026-07-31: moving kiwoom onto per-account keys dropped both quote watches at boot for
    /// want of an account that was registered six minutes later). Recovery used to mean restarting
    /// after the key was back. Registering credentials is the moment the missing thing appears, so
    /// that is where the retry belongs — no polling, and no restart to use a key the process holds.
    pub async fn relaunch_missing_streams(&self, module: &str) -> usize {
        let Some(raw) = self.vault.get_secret(VK_SYSTEM_WS_WATCHES) else {
            return 0;
        };
        let metas: Vec<StreamWatchMeta> = serde_json::from_str(&raw).unwrap_or_default();
        let live: std::collections::HashSet<String> = self
            .stream_watches
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .cloned()
            .collect();
        let mut ok = 0usize;
        for meta in metas
            .into_iter()
            .filter(|m| m.module == module && !live.contains(&m.watch_id))
        {
            let id = meta.watch_id.clone();
            match self.launch_stream(meta).await {
                Ok(()) => {
                    ok += 1;
                    tracing::info!(target: "ws_stream", watch_id = %id, "watch relaunched after credentials were registered");
                }
                Err(e) => {
                    tracing::warn!(target: "ws_stream", watch_id = %id, error = %e, "watch relaunch failed");
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

        // Declarative arg validation — when the stream declares a `typeCodes` map and the
        // caller passed a `type`, it must be one of the declared codes. Rejecting here gives
        // the model an instant, self-correcting error with the valid vocabulary instead of a
        // provider NACK loop (2026-07-11: type="0" watch — kiwoom rejects anything not in the map).
        if let Some(codes) = decl.get("typeCodes").and_then(|v| v.as_object()) {
            if let Some(t) = meta.args.get("type").and_then(|v| v.as_str()) {
                if !codes.contains_key(t) {
                    let vocab: Vec<String> = codes
                        .iter()
                        .map(|(k, v)| format!("{}={}", k, v.as_str().unwrap_or("")))
                        .collect();
                    return Err(format!(
                        "[{}] invalid realtime type '{}' for stream '{}'. Omit `type` to use the default, or pick one of: {}",
                        meta.module,
                        t,
                        meta.stream,
                        vocab.join(", ")
                    ));
                }
            }
        }

        let mut args_view = ws_args_view(ws, &meta.args);
        if let Some(o) = args_view.as_object_mut() {
            o.entry("grpNo".to_string())
                .or_insert_with(|| serde_json::Value::String(ws_group_no(&meta.watch_id)));
        }
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
        let frame_format = ws_frame_format(decl, ws);
        // Which account this socket authenticates as. Resolved at launch rather than at
        // registration, so a watch registered before any account existed — or before the primary
        // changed — picks up the right credentials the next time it connects instead of hunting
        // for a module-wide key that is no longer there.
        let (account, mock) = if config.get("accounts").is_some() {
            let reg = self.account_registry_effective(&meta.module).await;
            let requested = meta.args.get("account").and_then(|v| v.as_str());
            let entry = reg.resolve(requested)?.ok_or_else(|| {
                format!(
                    "[{}] no account to run this stream as — register one in the module settings.",
                    meta.module
                )
            })?;
            // A socket authenticates as the account too, so an incompletely registered one is no
            // more usable here than on a call. A stream names no market, which is precisely why
            // this has to refuse on the account rather than on what was asked for.
            if let Some(detail) = crate::utils::account_secrets::market_refusal(
                entry,
                &crate::utils::account_secrets::declared_markets(&config),
                None,
            ) {
                return Err(format!("[{}] {detail}", meta.module));
            }
            // Same rule as a call: the account is real or mock, so it picks the endpoint too.
            (Some(entry.id.clone()), entry.is_mock())
        } else {
            (
                meta.args
                    .get("account")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                meta.mock,
            )
        };
        let spec = WsStreamSpec {
            watch_id: meta.watch_id.clone(),
            account,
            topic: meta.topic.clone(),
            module: meta.module.clone(),
            stream: meta.stream.clone(),
            module_dir,
            // Per-stream endpoint override (decl.endpoint/endpointMock) → module-level fallback.
            // 같은 provider 가 스트림별로 다른 WS 경로를 쓸 때(예: 키움 국내 /api/dostk/websocket vs
            // 미국주식 /api/us/websocket, 같은 호스트 다른 path). 선언 없으면 기존 module-level.
            endpoint: ws_endpoint(decl, mock)
                .or_else(|| ws_endpoint(ws, mock))
                .ok_or_else(|| format!("[{}] ws.endpoint missing", meta.module))?,
            match_field: ws_match_field(ws),
            echo_values: ws_echo_values(ws),
            // Per-stream override first: what keeps a socket open is a property of the endpoint,
            // and a module can front more than one.
            keepalive: decl
                .get("keepalive")
                .or_else(|| ws.get("keepalive"))
                .cloned(),
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
            decrypt: parse_ws_decrypt(decl),
            // Spec-level token secret — 한투 approval_key rides in the subscribe frame (no LOGIN).
            token_secret: ws
                .get("tokenSecret")
                .and_then(|v| v.as_str())
                .map(String::from),
            // Declarative frame decode — fid code → label map + "the" chart value key.
            field_labels: decl
                .get("fieldLabels")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
            chart_volume_field: decl
                .get("chartVolumeField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_change_field: decl
                .get("chartChangeField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_change_rate_field: decl
                .get("chartChangeRateField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_field: decl
                .get("chartField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_abs: decl
                .get("chartAbs")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            chart_session_field: decl
                .get("chartSessionField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_session_regular: decl
                .get("chartSessionRegular")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            chart_day_volume_field: decl
                .get("chartDayVolumeField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_time_field: decl
                .get("chartTimeField")
                .and_then(|v| v.as_str())
                .map(String::from),
            chart_date_field: decl
                .get("chartDateField")
                .and_then(|v| v.as_str())
                .map(String::from),
            share_connection: ws
                .get("shareConnection")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            route_item_path: decl
                .get("routeItemPath")
                .and_then(|v| v.as_str())
                .map(String::from),
            route_type_path: decl
                .get("routeTypePath")
                .and_then(|v| v.as_str())
                .map(String::from),
            // What this watch actually subscribed, read from the args the subscribe frame was
            // built from — the rendered frame is provider-shaped, the args are not.
            subscribe_items: decl
                .get("routeItemArg")
                .and_then(|v| v.as_str())
                .map(|k| ws_str_list(args_view.get(k)))
                .unwrap_or_default(),
            subscribe_types: decl
                .get("routeTypeArg")
                .and_then(|v| v.as_str())
                .map(|k| ws_str_list(args_view.get(k)))
                .unwrap_or_default(),
            mock,
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

    /// 그 액션을 선언한 **다른** 모듈 이름 — 검증 실패가 도구↔액션 짝 어긋남일 때 다음 수 포인터.
    ///
    /// 소스 = 각 모듈 config 의 `input.properties.action.enum` — 검증이 쓰는 바로 그 데이터라
    /// 불일치가 생길 수 없다(별도 카탈로그를 참조하면 refresh 시점 차이로 어긋난다).
    /// 실패 경로에서만 도는 스캔이라 정상 호출 비용은 0.
    pub async fn find_action_owner(&self, action: &str, exclude: &str) -> Option<String> {
        let mut names: Vec<String> = self
            .list_system_modules()
            .await
            .into_iter()
            .chain(self.list_user_modules().await)
            .map(|e| e.name)
            .filter(|n| n != exclude)
            .collect();
        names.dedup();
        for name in names {
            let Some(config) = self.get_config_any_scope(&name).await else {
                continue;
            };
            if config
                .get("input")
                .map(|s| schema_declares_action(s, action))
                .unwrap_or(false)
            {
                return Some(name);
            }
        }
        None
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

    /// The schedule files this module declares — `"schedules": ["cron.upbit.json", ...]`.
    ///
    /// A module that runs on a timer should say so itself. Before this, the declarations shipped
    /// in the repo and nothing read them: installing the module and restarting produced no jobs,
    /// and the only route to a running schedule was for a person to retype the pipeline into the
    /// scheduler by hand.
    pub async fn declared_schedules(&self, name: &str) -> Vec<String> {
        let Some(cfg) = self.module_config(name).await else {
            return Vec::new();
        };
        let mut out: Vec<String> = Vec::new();
        let mut push = |f: &str, out: &mut Vec<String>| {
            if f.ends_with(".json") && !f.contains("..") && !f.contains('/') && !out.iter().any(|x| x == f) {
                out.push(f.to_string());
            }
        };
        for f in cfg.get("schedules").and_then(|v| v.as_array()).into_iter().flatten() {
            if let Some(s) = f.as_str() {
                push(s, &mut out);
            }
        }
        // Loops that follow what the module is set to do, rather than a second list somebody has
        // to keep in step with the first. autotrade declares one trade per running strategy and
        // a loop per (broker, market); the two were separate hand-written lists, so switching a
        // stock strategy on registered nothing — no error, no log, and the loop that would have
        // executed it simply was not on the clock.
        //
        // The row names its file. Deriving the NAME instead (`cron-{broker}-{market}.json`) would
        // need a table saying upbit-trade is "upbit" and korea-invest-trade is "kis", which is the
        // same hidden copy one level down.
        if let Some(spec) = cfg.get("schedulesFrom") {
            let sfield = |k: &str| spec.get(k).and_then(|v| v.as_str());
            if let (Some(setting), Some(field)) = (sfield("setting"), sfield("field")) {
                // The off switch is the row's own word, and it is not always a boolean —
                // autotrade's is `state: "off"` beside `"pauseEntries"`. So the declaration says
                // which field and which value mean off, rather than the framework assuming a
                // shape and quietly registering a loop for a trade somebody switched off.
                let skip = spec.get("skipWhen");
                let skip_field = skip.and_then(|w| w.get("field")).and_then(|v| v.as_str());
                let skip_value = skip.and_then(|w| w.get("equals"));
                for row in self.list_setting(name, &cfg, setting).await {
                    // Absent means on: a row that never had the field is a row the operator wrote
                    // before it existed, and reading that as "off" would silently stop a strategy.
                    if let (Some(k), Some(want)) = (skip_field, skip_value) {
                        if row.get(k) == Some(want) {
                            continue;
                        }
                    }
                    if let Some(f) = row.get(field).and_then(|v| v.as_str()) {
                        push(f, &mut out);
                    }
                }
            }
        }
        out
    }

    /// A list-shaped module setting, from wherever it is currently true.
    ///
    /// The vault holds it once the operator has pressed save; until then the config's
    /// `settings_fields[].defaultValue` is what runs, and for autotrade's strategies that is the
    /// normal state — they ship in the repo and reach the server by `git pull`. Reading only the
    /// vault would see nothing at all on a machine where nobody has opened the settings screen.
    async fn list_setting(
        &self,
        name: &str,
        cfg: &serde_json::Value,
        key: &str,
    ) -> Vec<serde_json::Value> {
        let as_rows = |v: &serde_json::Value| -> Option<Vec<serde_json::Value>> {
            match v {
                serde_json::Value::Array(a) => Some(a.clone()),
                // The editor stores a list field as a JSON string.
                serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(s)
                    .ok()
                    .and_then(|p| p.as_array().cloned()),
                _ => None,
            }
        };
        if let Some(rows) = self.get_settings(name).get(key).and_then(as_rows) {
            return rows;
        }
        cfg.get("settings_fields")
            .and_then(|v| v.as_array())
            .and_then(|fields| {
                fields
                    .iter()
                    .find(|f| f.get("key").and_then(|k| k.as_str()) == Some(key))
                    .and_then(|f| f.get("defaultValue"))
                    .and_then(as_rows)
            })
            .unwrap_or_default()
    }

    /// The module's declared schedules, read and understood — `(file, job)` per entry.
    ///
    /// Interpreting a module's own declaration is module-domain work, so it happens here rather
    /// than in whoever needs the result. Core coordinates the two managers; it does not learn
    /// what a module's config means on the way through.
    ///
    /// A file that is missing or unreadable is skipped with a warning rather than failing the
    /// batch — one bad declaration should not cost a module its other schedules.
    pub async fn declared_schedule_jobs(
        &self,
        name: &str,
    ) -> Vec<(String, crate::ports::CronScheduleOptions)> {
        let mut out = vec![];
        for file in self.declared_schedules(name).await {
            let raw = match self.read_module_file("system", name, &file).await {
                Some(r) => Some(r),
                None => self.read_module_file("user", name, &file).await,
            };
            let Some(raw) = raw else {
                tracing::warn!(target: "module_schedule", module = %name, file = %file,
                    "declared schedule file is missing");
                continue;
            };
            match serde_json::from_str::<crate::ports::CronScheduleOptions>(&raw) {
                // The file is the job: the same shape the scheduler already takes, so what
                // someone reads in the module folder is exactly what runs.
                Ok(job) => out.push((file, job)),
                Err(e) => tracing::warn!(target: "module_schedule", module = %name, file = %file,
                    error = %e, "declared schedule could not be read"),
            }
        }
        out
    }

    /// Which of this module's declared schedules have already been registered once.
    ///
    /// Kept so a job the owner deleted on purpose is not resurrected by the next restart, while a
    /// schedule added in a later version of the module still gets picked up.
    pub fn registered_schedules(&self, name: &str) -> Vec<String> {
        self.get_settings(name)
            .get("_registeredSchedules")
            .and_then(|v| v.as_array().cloned())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }

    pub fn set_registered_schedules(&self, name: &str, files: &[String]) -> bool {
        let mut settings = self.get_settings(name);
        if !settings.is_object() {
            settings = serde_json::json!({});
        }
        settings["_registeredSchedules"] = serde_json::json!(files);
        self.set_settings(name, &settings)
    }

    /// Config from whichever scope holds the module — for read paths that only know the name.
    pub async fn module_config(&self, name: &str) -> Option<serde_json::Value> {
        match self.get_module_config("system", name).await {
            Some(c) => Some(c),
            None => self.get_module_config("user", name).await,
        }
    }

    /// The module's declared `capability` — the gate resolves a capability allowlist through this.
    pub async fn capability_of(&self, module: &str) -> Option<String> {
        self.module_config(module)
            .await?
            .get("capability")?
            .as_str()
            .map(String::from)
    }

    /// Accounts registered for this module (the index, never the credentials).
    pub fn account_registry(&self, module: &str) -> crate::utils::account_secrets::AccountRegistry {
        crate::utils::account_secrets::AccountRegistry::load(self.vault.as_ref(), module)
    }

    /// Which module owns the account registry — itself, or the sibling it borrows credentials
    /// from.
    ///
    /// A broker split into a quote half and a trading half is one broker relationship: one set of
    /// app keys, one primary account. The registry therefore has one home, and `credentialScope`
    /// names it. Reading already followed that; the settings screen did not, so adding an account
    /// on the quote half wrote a second registry nothing reads — the list looked empty on one
    /// screen and complete on the other, and entering the primary on the wrong one did nothing
    /// (2026-08-03). Both screens are now two views of the same list, which is what a shared
    /// credential means.
    pub async fn account_home(&self, module: &str) -> String {
        self.module_config(module)
            .await
            .and_then(|c| crate::utils::account_secrets::credential_scope(&c))
            .filter(|home| !home.is_empty() && home != module)
            .unwrap_or_else(|| module.to_string())
    }

    /// The registry a call runs against — own accounts plus the base module's primary.
    pub async fn account_registry_effective(
        &self,
        module: &str,
    ) -> crate::utils::account_secrets::AccountRegistry {
        let base = self
            .module_config(module)
            .await
            .and_then(|c| crate::utils::account_secrets::credential_scope(&c));
        crate::utils::account_secrets::AccountRegistry::load_with_base(
            self.vault.as_ref(),
            module,
            base.as_deref(),
        )
    }

    pub fn save_account_registry(
        &self,
        module: &str,
        registry: &crate::utils::account_secrets::AccountRegistry,
    ) -> Result<(), String> {
        let raw = serde_json::to_string(registry).map_err(|e| e.to_string())?;
        let key = crate::utils::account_secrets::registry_key(module);
        if self.vault.set_secret(&key, &raw) {
            Ok(())
        } else {
            Err(format!("failed to write {key}"))
        }
    }

    /// How discovery surfaces describe the `account` parameter: one line naming every registered
    /// alias, so picking an account never needs a lookup round trip. None when the module declares
    /// no accounts, or declares them but has none registered yet (nothing to choose between).
    /// Every registered account, across every module that declares `accounts`.
    ///
    /// The per-module registry was reachable one broker at a time through `get_module_config`, so
    /// "what accounts do I have" could only be answered by knowing which modules to ask — and
    /// which modules those are is itself not something a caller can see. This answers it in one
    /// call, and filters on the attributes that actually decide which account a request means:
    /// nobody wants "모의국내" by name, they want the mock account that trades kr.
    ///
    /// Filtered rather than searched on purpose. The aliases are short opaque labels, not prose —
    /// `모의국내` and `모의해외` embed almost identically, so semantic search cannot separate the
    /// two things a caller is actually choosing between, while `mode` and `market` are enumerable
    /// and separate them exactly. No filter = all of them.
    pub async fn list_registered_accounts(
        &self,
        module: Option<&str>,
        mode: Option<&str>,
        market: Option<&str>,
    ) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        for entry in self.list_system_modules().await {
            if let Some(m) = module {
                if entry.name != m {
                    continue;
                }
            }
            let Some(config) = self.module_config(&entry.name).await else {
                continue;
            };
            if config.get("accounts").is_none() {
                continue;
            }
            let reg = self.account_registry_effective(&entry.name).await;
            let primary = reg.primary_entry().map(|p| p.id.clone());
            for a in &reg.accounts {
                if !a.matches(mode, market) {
                    continue;
                }
                out.push(serde_json::json!({
                    "module": entry.name,
                    "account": a.id,
                    "mode": a.mode,
                    "markets": a.markets,
                    "accountNo": a.digits(),
                    "isPrimary": primary.as_deref() == Some(a.id.as_str()),
                    "describe": a.describe(),
                }));
            }
        }
        out
    }

    pub async fn account_param_doc(&self, module: &str) -> Option<String> {
        let config = self.module_config(module).await?;
        config.get("accounts")?;
        let reg = self.account_registry(module);
        if reg.is_empty() {
            return None;
        }
        let choices: Vec<String> = reg
            .accounts
            .iter()
            .map(|a| format!("{} = {}", a.id, a.describe()))
            .collect();
        let default = match reg.primary_entry() {
            Some(p) => format!("omit to use the primary account ({})", p.id),
            None => "no primary is designated — name one".to_string(),
        };
        Some(format!(
            "Which registered account to run as — {default}. Choices: {}.",
            choices.join("; ")
        ))
    }

    /// Secret names the module declares, split into the credentials a person enters and the
    /// token slots the framework mints. Derived from `secrets` so the accounts UI can never drift
    /// from what the module actually reads (same join-from-declaration rule as requiresApproval).
    fn declared_secret_names(config: &serde_json::Value) -> (Vec<String>, Vec<String>) {
        let mut creds = Vec::new();
        let mut tokens = Vec::new();
        for entry in config
            .get("secrets")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let (name, kind) = match entry {
                serde_json::Value::String(s) => (s.as_str(), "key"),
                other => (
                    other.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                    other.get("type").and_then(|v| v.as_str()).unwrap_or("key"),
                ),
            };
            if name.is_empty() {
                continue;
            }
            if kind == "token" {
                tokens.push(name.to_string());
            } else {
                creds.push(name.to_string());
            }
        }
        (creds, tokens)
    }

    /// Everything the accounts UI needs: what the module supports, which accounts are registered,
    /// and which credentials each one actually holds. Values are never returned — only whether a
    /// slot is filled, so a screenshot of this screen leaks nothing.
    pub async fn account_overview(&self, module: &str) -> Option<serde_json::Value> {
        let config = self.module_config(module).await?;
        let decl = config.get("accounts")?.clone();
        let (credentials, _tokens) = Self::declared_secret_names(&config);
        let reg = self.account_registry_effective(module).await;
        let accounts: Vec<serde_json::Value> = reg
            .accounts
            .iter()
            .map(|a| {
                let filled: serde_json::Map<String, serde_json::Value> = credentials
                    .iter()
                    .map(|c| {
                        let has = self
                            .vault
                            .get_secret(&crate::utils::account_secrets::secret_key(
                                c,
                                Some(&a.id),
                                false,
                            ))
                            .is_some();
                        (c.clone(), serde_json::json!(has))
                    })
                    .collect();
                let mut row = serde_json::to_value(a).unwrap_or_default();
                row["credentials"] = serde_json::Value::Object(filled);
                row
            })
            .collect();
        Some(serde_json::json!({
            "module": module,
            "declared": decl,
            "credentials": credentials,
            "primary": reg.primary_entry().map(|p| p.id.clone()),
            "accounts": accounts,
        }))
    }

    /// Registers or updates one account. Credentials are optional on update — an empty value
    /// leaves the stored one alone, so re-saving a label never wipes an app key.
    pub async fn save_account(
        &self,
        module: &str,
        entry: crate::utils::account_secrets::AccountEntry,
        credentials: &serde_json::Map<String, serde_json::Value>,
        make_primary: bool,
    ) -> Result<(), String> {
        let id = entry.id.trim().to_string();
        // The alias IS the account's name, so it takes whatever the user calls the account —
        // Korean, spaces, punctuation. It only has to survive being part of a vault key (`@`
        // separates it) and being quoted back in an error, so those two are the whole rule.
        if id.is_empty()
            || id.chars().count() > ALIAS_MAX_CHARS
            || id.contains('@')
            || id.chars().any(char::is_control)
        {
            return Err(format!(
                "account alias must be non-empty, at most {ALIAS_MAX_CHARS} characters, and contain no '@'"
            ));
        }
        let config = self
            .module_config(module)
            .await
            .ok_or_else(|| format!("module {module} not found"))?;
        if config.get("accounts").is_none() {
            return Err(format!("module {module} does not declare accounts"));
        }
        let (declared, tokens) = Self::declared_secret_names(&config);
        let mut credential_written = false;
        for (name, value) in credentials {
            let Some(value) = value.as_str().map(str::trim).filter(|v| !v.is_empty()) else {
                continue;
            };
            if !declared.iter().any(|d| d == name) {
                return Err(format!("{name} is not a credential this module declares"));
            }
            let key = crate::utils::account_secrets::secret_key(name, Some(&id), false);
            if !self.vault.set_secret(&key, value) {
                return Err(format!("failed to store {name}"));
            }
            credential_written = true;
        }
        // A cached access token outlives the app key it was issued for, and both are keyed by the
        // alias — so putting a different key under an existing alias leaves a token that still
        // authenticates as the *previous* account. Measured 2026-08-04: after re-registering the
        // domestic app key under an alias, its stored token still answered as the other account,
        // which would have reproduced the same wrong-account rejections with the app key now
        // looking correct. A token is a cache; the moment its issuer changes it is stale.
        if credential_written {
            for name in &tokens {
                let key = crate::utils::account_secrets::secret_key(name, Some(&id), false);
                if self.vault.get_secret(&key).is_some() && self.vault.delete_secret(&key) {
                    tracing::info!(
                        target: "module",
                        module = %module,
                        account = %id,
                        secret = %name,
                        "credentials changed — dropped the token issued for the previous ones"
                    );
                }
            }
        }
        let home = self.account_home(module).await;
        let mut reg = self.account_registry(&home);
        let mut entry = entry;
        entry.id = id.clone();
        match reg.accounts.iter_mut().find(|a| a.id == id) {
            Some(existing) => *existing = entry,
            None => reg.accounts.push(entry),
        }
        if make_primary || reg.accounts.len() == 1 {
            reg.primary = Some(id);
        }
        self.save_account_registry(&home, &reg)
    }

    /// Removes an account and the credentials stored under it — a deleted account must not leave
    /// a usable app key behind in the vault.
    pub async fn delete_account(&self, module: &str, id: &str) -> Result<(), String> {
        let config = self
            .module_config(module)
            .await
            .ok_or_else(|| format!("module {module} not found"))?;
        let (creds, tokens) = Self::declared_secret_names(&config);
        for name in creds.iter().chain(tokens.iter()) {
            let key = crate::utils::account_secrets::secret_key(name, Some(id), false);
            self.vault.delete_secret(&key);
        }
        let home = self.account_home(module).await;
        let mut reg = self.account_registry(&home);
        reg.accounts.retain(|a| a.id != id);
        if reg.primary.as_deref() == Some(id) {
            reg.primary = None;
        }
        self.save_account_registry(&home, &reg)
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

    /// A fingerprint of every module directory's contents — file names, sizes and mtimes, with no
    /// file read and no JSON parse.
    ///
    /// The action catalog needs to tell an untouched five minutes from an edited one. Before this
    /// it could not, so it re-read and re-parsed forty configs on a timer and a module installed
    /// at runtime still had to wait out the clock. Whole directories rather than `config.json`
    /// alone, because a module's action catalog may live in a separate file the config only names;
    /// listing the directory covers both without this having to know which.
    ///
    /// A directory that cannot be listed contributes nothing, which is correct in both directions:
    /// it is also contributing nothing to `load()`, and it starts contributing the moment it
    /// appears.
    pub async fn module_dirs_fingerprint(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        for root in ["system/modules", "system/services", "user/modules"] {
            let Ok(dirs) = self.storage.list_dir(root).await else {
                continue;
            };
            for d in dirs.iter().filter(|d| d.is_directory) {
                let path = format!("{}/{}", root, d.name);
                let Ok(files) = self.storage.list_dir(&path).await else {
                    continue;
                };
                for f in files.iter().filter(|f| !f.is_directory) {
                    parts.push(format!(
                        "{}/{}:{}:{}",
                        path,
                        f.name,
                        f.size.unwrap_or(0),
                        f.modified_ms.unwrap_or(0)
                    ));
                }
            }
        }
        // Directory order is filesystem order, which is not stable across machines or rescans.
        parts.sort();
        use sha1::{Digest, Sha1};
        let mut hasher = Sha1::new();
        hasher.update(parts.join("\n").as_bytes());
        format!("{:x}", hasher.finalize())
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
        // A venue that authenticates the handshake sends no login frame at all, so its absence
        // is a shape rather than an omission.
        frame: l.get("frame").cloned().filter(|v| !v.is_null()),
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
        headers: l.get("headers").and_then(|h| h.as_object()).map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        }),
        jwt: l.get("jwt").and_then(parse_ws_jwt),
    })
}

fn parse_ws_jwt(j: &serde_json::Value) -> Option<crate::ports::WsJwtSpec> {
    let text = |k: &str| j.get(k).and_then(|v| v.as_str()).map(String::from);
    // Both key names are required: signing with a key we do not have produces a token the venue
    // rejects, and a declaration missing half of it should fail here rather than at the socket.
    Some(crate::ports::WsJwtSpec {
        algorithm: text("algorithm").unwrap_or_else(|| "HS512".to_string()),
        access_key_secret: text("accessKeySecret")?,
        secret_key_secret: text("secretKeySecret")?,
        access_claim: text("accessClaim").unwrap_or_else(|| "access_key".to_string()),
        nonce_claim: text("nonceClaim").unwrap_or_else(|| "nonce".to_string()),
    })
}

/// Module arg-container convention — some modules nest API params under a field
/// (e.g. kiwoom `{action, params:{…}}`, declared as ws.argsField). Overlay the nested
/// object over the root so templates resolve from either level (nested wins).
/// A declared arg that may be a single value or a list — normalized to a list of strings.
fn ws_str_list(v: Option<&serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| match x {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect(),
        Some(serde_json::Value::String(s)) if !s.is_empty() => vec![s.clone()],
        Some(serde_json::Value::Number(n)) => vec![n.to_string()],
        _ => Vec::new(),
    }
}

/// A registration group number unique to this watch, derived from its id so it survives restarts.
/// Sharing one socket makes this necessary: providers key unsubscribe by group, so watches sitting
/// on a hardcoded group would tear down each other's registrations.
fn ws_group_no(watch_id: &str) -> String {
    let mut h: u32 = 2166136261;
    for b in watch_id.as_bytes() {
        h = (h ^ *b as u32).wrapping_mul(16777619);
    }
    format!("{}", 1000 + (h % 9000))
}

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

/// Realtime wire format, as the module declares it. Stream-level `frame` falls back to the
/// module-level `ws.frame`.
///
/// ```jsonc
/// "frame": { "kind": "json" }
/// "frame": { "kind": "delimited", "recordSep": "|", "fieldSep": "^",
///            "layout": ["flag", "trId", "count", "body"], "encryptedWhen": "1" }
/// ```
///
/// An undeclared or unreadable `frame` is JSON, which is what a WebSocket carries unless someone
/// says otherwise — the default is a fact about the protocol, not a name for whatever the
/// incumbent module happened to do. `delimited` without a `body` slot is refused the same way:
/// half a description would decode into silently wrong records.
fn ws_frame_format(decl: &serde_json::Value, ws: &serde_json::Value) -> WsFrameFormat {
    let Some(f) = decl.get("frame").or_else(|| ws.get("frame")) else {
        return WsFrameFormat::Json;
    };
    if f.get("kind").and_then(|v| v.as_str()) != Some("delimited") {
        return WsFrameFormat::Json;
    }
    let text = |k: &str| f.get(k).and_then(|v| v.as_str()).map(String::from);
    let layout: Vec<String> = f
        .get("layout")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let (Some(record_sep), Some(field_sep)) = (text("recordSep"), text("fieldSep")) else {
        tracing::warn!(target: "ws_stream", "frame kind=delimited without recordSep/fieldSep — reading frames as JSON");
        return WsFrameFormat::Json;
    };
    if record_sep.is_empty() || field_sep.is_empty() || !layout.iter().any(|s| s == "body") {
        tracing::warn!(target: "ws_stream", "frame kind=delimited names no `body` slot — reading frames as JSON");
        return WsFrameFormat::Json;
    }
    WsFrameFormat::Delimited(crate::ports::WsDelimitedFrame {
        record_sep,
        field_sep,
        layout,
        encrypted_when: text("encryptedWhen"),
    })
}

/// `decrypt: {ivField, keyField}` on a stream decl → WsDecryptSpec (KIS 체결통보 AES256).
fn parse_ws_decrypt(decl: &serde_json::Value) -> Option<WsDecryptSpec> {
    let d = decl.get("decrypt")?;
    Some(WsDecryptSpec {
        iv_field: d.get("ivField")?.as_str()?.to_string(),
        key_field: d.get("keyField")?.as_str()?.to_string(),
    })
}


/// WS frame template substitution — generic, zero provider knowledge.
/// String values of the exact form `"{param}"` / `"{param:default}"` are replaced with the
/// input arg (coerced to string); `"{param}"` with no default and no arg = error (required).
/// `"{TOKEN}"` is left as-is — the transport adapter fills it after the token fetch.
/// The parameter of a value that is nothing but a placeholder - `{item}`, `{type:0B}`, `{item?}` -
/// used to tell "this slot IS the argument" from a string that merely contains one. The trailing
/// `?` marks an argument the provider does not require; the bool reports it.
fn lone_placeholder(v: &serde_json::Value) -> Option<(&str, bool)> {
    let s = v.as_str()?;
    let inner = s.strip_prefix('{')?.strip_suffix('}')?;
    if inner == "TOKEN" {
        return None;
    }
    let param = inner.split_once(':').map(|(p, _)| p).unwrap_or(inner);
    let optional = param.ends_with('?');
    let param = param.trim_end_matches('?');
    if param.is_empty() || !param.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((param, optional))
}

/// Whether a template slot is an optional argument that this call did not supply - in which case
/// the key it sits under is left out of the frame entirely rather than sent empty. Realtime types
/// scoped to the account, and the market-wide ones, ignore the subscription id; requiring it made
/// them impossible to register without inventing a value.
fn omit_optional(v: &serde_json::Value, input: &serde_json::Value) -> bool {
    let unresolved = |x: &serde_json::Value| match lone_placeholder(x) {
        Some((name, true)) => input.get(name).is_none(),
        _ => false,
    };
    match v {
        serde_json::Value::Array(a) => !a.is_empty() && a.iter().all(unresolved),
        other => unresolved(other),
    }
}

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
                let param = param.trim_end_matches('?');
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
                    // Structured values pass through untouched. Some providers want an object
                    // where others want a code - kiwoom's US realtime registration takes
                    // {jmcode, stex_tp} - and stringifying it would corrupt the frame.
                    Some(v @ serde_json::Value::Object(_)) => Ok(v.clone()),
                    Some(v @ serde_json::Value::Array(_)) => Ok(v.clone()),
                    _ => match default {
                        Some(d) => Ok(serde_json::Value::String(d.to_string())),
                        None => Err(format!("required param missing: {param}")),
                    },
                }
            }
            serde_json::Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for (k, val) in map {
                    if omit_optional(val, input) {
                        continue;
                    }
                    out.insert(k.clone(), walk(val, input)?);
                }
                Ok(serde_json::Value::Object(out))
            }
            serde_json::Value::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    // A lone placeholder in a list position expands into the list it names, so one
                    // declaration covers a single subscription and a batch of them alike. Without
                    // this, subscribing to two symbols would need two frames - and on a provider
                    // that caps sessions per token, two frames is the whole difficulty.
                    if let Some((name, _)) = lone_placeholder(item) {
                        if let Some(serde_json::Value::Array(vals)) = input.get(name) {
                            out.extend(vals.iter().cloned());
                            continue;
                        }
                    }
                    out.push(walk(item, input)?);
                }
                Ok(serde_json::Value::Array(out))
            }
            other => Ok(other.clone()),
        }
    }
    walk(template, input)
}

fn input_for_validation<'a>(
    input_data: &'a serde_json::Value,
    input_schema: &serde_json::Value,
) -> std::borrow::Cow<'a, serde_json::Value> {
    // `account` is infra-injected the same way (config `accounts` declares the capability, the
    // framework resolves the alias) — strip it unless the module declares the name itself.
    let declares = |k: &str| {
        input_schema
            .get("properties")
            .and_then(|p| p.get(k))
            .is_some()
    };
    let strip: Vec<&str> = RESERVED_HUB_META_KEYS
        .iter()
        .copied()
        .chain(std::iter::once("account").filter(|k| !declares(k)))
        .collect();
    match input_data.as_object() {
        Some(obj) if strip.iter().any(|k| obj.contains_key(*k)) => {
            let mut cleaned = obj.clone();
            for k in strip {
                cleaned.remove(k);
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
/// One door for every absorbed dialect — grep `target=dialect` to see what the models are
/// actually sending. Absorbing silently is how a dialect becomes permanent: the call succeeds,
/// nobody learns the shape was wrong, and the same class shows up again somewhere with no
/// absorber (2026-08-09, the operator asked for exactly this after four such fixes in a day).
fn dialect_absorbed(module: &str, kind: &str, detail: &str) {
    tracing::info!(target: "dialect", module = %module, kind = %kind, detail = %detail,
        "input dialect absorbed");
}

/// Make a value conform to its DECLARED schema wherever the conversion is lossless and has one
/// possible reading — recursively, so a nested object or an array item gets the same treatment.
///
/// This replaced a hand-enumerated match table. The table was the defect: `boolean` was simply
/// missing from it, so `"lastSessionOnly": "true"` was refused four times in a row and burned a
/// turn's tool budget (2026-08-09 실측). A table has to be extended per type-pair forever; a
/// schema walk closes the whole class.
///
/// Every change is recorded in `notes` (`path: from → to`) so the absorption is visible rather
/// than silent.
fn coerce_for_validation(
    value: &serde_json::Value,
    schema: &serde_json::Value,
    notes: &mut Vec<String>,
) -> serde_json::Value {
    coerce_node(value, schema, "", notes)
}

/// The dialect-repair pipeline, in the one order that works — and the ONLY place that order
/// lives. `run` calls it; the replay corpus (`core/tests/dialect_replay.rs`) calls it with
/// historical arguments, so a rule added here cannot quietly change what yesterday's calls mean.
///
/// Order is load-bearing, each step paid for in a measured failure:
///   1. **coerce** — parses containers the model serialized as strings. Must precede expansion:
///      nested `sheets.*.rows` cannot traverse a string, so a stringified `sheets` skipped
///      expansion, parsed later, and shipped an empty xlsx that reported success (2026-08-12).
///   2. **expand** — `<param>CacheKey` (+ the `<param>Limit`/`<param>Range` window) becomes real
///      rows, before validation, so `required` still means what it says.
///   3. **coerce again**, only if expansion changed something — cached rows get the same type
///      treatment as inline ones; a broker's stringified prices must not depend on the channel.
///   4. **relocate** — flat per-action params move into the single declared object container when
///      `additionalProperties:false` makes that the one reading that can succeed.
///
/// Returns `Ok(None)` when nothing needed repair (the common case, and it clones nothing).
pub fn repair_input(
    module_name: &str,
    config: Option<&serde_json::Value>,
    input: &serde_json::Value,
    cache: Option<&std::sync::Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>>,
) -> Result<Option<serde_json::Value>, String> {
    let mut notes: Vec<String> = Vec::new();
    let coerce = |v: &serde_json::Value, notes: &mut Vec<String>| -> Option<serde_json::Value> {
        config
            .and_then(|c| c.get("input"))
            .map(|schema| coerce_for_validation(v, schema, notes))
            .filter(|c| c != v)
    };
    let mut current: Option<serde_json::Value> = coerce(input, &mut notes);
    let view = |cur: &Option<serde_json::Value>| -> serde_json::Value {
        cur.clone().unwrap_or_else(|| input.clone())
    };

    if let Some(cfg) = config {
        let now = view(&current);
        if let Some(expanded) =
            crate::utils::cache_inputs::expand(module_name, cfg, &now, cache)?
        {
            let recoerced = coerce(&expanded, &mut notes);
            current = Some(recoerced.unwrap_or(expanded));
        }
    }
    if !notes.is_empty() {
        dialect_absorbed(module_name, "coerce", &notes.join(", "));
    }

    if let Some(schema) = config.and_then(|c| c.get("input")) {
        let now = view(&current);
        if let Some((moved_value, moved)) = relocate_unknowns_into_container(&now, schema) {
            dialect_absorbed(
                module_name,
                "container",
                &format!("flat keys moved into the container param: {moved}"),
            );
            current = Some(moved_value);
        }
    }
    Ok(current)
}

/// A JSON-looking string that does not parse — the hint says WHERE it broke.
///
/// Hand-serialized containers break mid-stream (escape slip, truncated output) and the model
/// cannot re-read its own bytes, so "resend it" alone leaves it hunting through thousands of
/// characters (2026-08-12: a 3.5KB `sheets` string broke at char 1828 and the turn rebuilt the
/// whole call from scratch). serde_json knows the offset; naming it with a small window around
/// it turns the error into an instruction. A value wrapped in a one-element array is accepted
/// too, so the diagnosis survives any path that wraps before validation.
fn broken_json_string_hint(key: &str, value: &serde_json::Value) -> Option<String> {
    let s = match value {
        serde_json::Value::String(s) => s.as_str(),
        serde_json::Value::Array(a) => match a.as_slice() {
            [serde_json::Value::String(s)] => s.as_str(),
            _ => return None,
        },
        _ => return None,
    };
    let t = s.trim();
    if !(t.starts_with('[') || t.starts_with('{')) {
        return None;
    }
    let err = serde_json::from_str::<serde_json::Value>(t).err()?;
    // serde_json counts the column in bytes; walk to the nearest char boundary so the excerpt
    // never splits a Korean codepoint.
    let chars: Vec<char> = t.chars().collect();
    let mut at = chars.len();
    let mut bytes = 0usize;
    for (i, c) in chars.iter().enumerate() {
        if bytes + 1 >= err.column() {
            at = i;
            break;
        }
        bytes += c.len_utf8();
    }
    let lo = at.saturating_sub(40);
    let hi = (at + 40).min(chars.len());
    let excerpt: String = chars[lo..hi].iter().collect();
    Some(format!(
        " `{key}` is a STRING whose JSON does not parse ({err}) — near: …{excerpt}… \
         Resend `{key}` as the actual array/object value, not a quoted string; if those rows \
         came from a tool, pass that call's `_cacheKey` instead of retyping them."
    ))
}

fn schema_type(schema: &serde_json::Value) -> Option<&str> {
    match schema.get("type") {
        Some(serde_json::Value::String(s)) => Some(s.as_str()),
        // ["number","null"] is the NULLABLE CONVENTION, not ambiguity — a non-null value has
        // exactly one legal reading, so it deserves the same coercion as a plain "number".
        // Treating every union as ambiguous refused fa's marketCap ("2092836983600" as a string)
        // FIVE times in one measured turn (2026-08-10) — the model even diagnosed the type
        // itself and still could not land the call, then did the math by hand and got the
        // market cap wrong by 10x. Only a union with two or more non-null readings is truly
        // ambiguous and left alone.
        Some(serde_json::Value::Array(arr)) => {
            let mut non_null = arr
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|s| *s != "null");
            match (non_null.next(), non_null.next()) {
                (Some(one), None) => Some(one),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Keys the FRAMEWORK owns at the top level, never the caller — so relocation must leave them
/// where they are even when the module's schema does not declare them.
///
/// `account` is the measured case (2026-08-12): account resolution injects a top-level `account`
/// unconditionally, and the infra sandbox reads it at the TOP level to pick account-scoped
/// credentials and the oauth token scope. kiwoom declares no `account` property and sets
/// `additionalProperties: false`, so relocation swept the injected key into `params` — the
/// credentials went unscoped and every call died with "KIWOOM_APP_KEY 미설정" on an account that
/// had its keys stored. Validation already tolerates the key (`input_for_validation` strips it
/// when undeclared), so there is nothing for relocation to rescue here.
const RELOCATION_RESERVED_KEYS: &[&str] = &["account"];

/// Moves undeclared top-level keys into the module's single declared object container.
///
/// Fires only when the schema says `additionalProperties: false` — the flat call WILL be
/// refused, so relocation is the one reading that can succeed — and when exactly one
/// object-typed property exists to receive the keys. Existing inner keys are never
/// overwritten. Returns the rewritten input plus the moved key list for the dialect log.
fn relocate_unknowns_into_container(
    input: &serde_json::Value,
    schema: &serde_json::Value,
) -> Option<(serde_json::Value, String)> {
    if schema.get("additionalProperties") != Some(&serde_json::Value::Bool(false)) {
        return None;
    }
    let props = schema.get("properties")?.as_object()?;
    let obj = input.as_object()?;
    let containers: Vec<&String> = props
        .iter()
        .filter(|(_, s)| matches!(schema_type(s), Some("object")))
        .map(|(k, _)| k)
        .collect();
    let [container] = containers.as_slice() else {
        return None;
    };
    let unknown: Vec<String> = obj
        .keys()
        .filter(|k| !props.contains_key(*k))
        .filter(|k| !RELOCATION_RESERVED_KEYS.contains(&k.as_str()))
        .cloned()
        .collect();
    if unknown.is_empty() {
        return None;
    }
    let mut out = obj.clone();
    let mut inner = out
        .get(container.as_str())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for k in &unknown {
        if let Some(v) = out.remove(k) {
            inner.entry(k.clone()).or_insert(v);
        }
    }
    out.insert(container.to_string(), serde_json::Value::Object(inner));
    Some((serde_json::Value::Object(out), unknown.join(", ")))
}

fn coerce_node(
    value: &serde_json::Value,
    schema: &serde_json::Value,
    path: &str,
    notes: &mut Vec<String>,
) -> serde_json::Value {
    use serde_json::Value as V;
    let ty = schema_type(schema);
    match (ty, value) {
        // A string that IS a JSON object where an object is declared — same class as the
        // array case below, same lossless reading.
        (Some("object"), V::String(s)) if s.trim_start().starts_with('{') => {
            match serde_json::from_str::<V>(s.trim()) {
                Ok(parsed @ V::Object(_)) => {
                    notes.push(format!("{path}: JSON string → object"));
                    coerce_node(&parsed, schema, path, notes)
                }
                _ => value.clone(),
            }
        }
        // object → walk declared properties
        (Some("object"), V::Object(obj)) | (None, V::Object(obj)) => {
            let Some(props) = schema.get("properties").and_then(|p| p.as_object()) else {
                return value.clone();
            };
            let mut out = obj.clone();
            for (k, v) in obj {
                let Some(sub) = props.get(k) else { continue };
                let child = coerce_node(v, sub, &format!("{path}/{k}"), notes);
                if &child != v {
                    out.insert(k.clone(), child);
                }
            }
            V::Object(out)
        }
        // array → walk items
        (Some("array"), V::Array(arr)) => {
            let Some(items) = schema.get("items") else { return value.clone() };
            let out: Vec<V> = arr
                .iter()
                .enumerate()
                .map(|(i, v)| coerce_node(v, items, &format!("{path}[{i}]"), notes))
                .collect();
            V::Array(out)
        }
        // A scalar where a list is declared. A string that IS a JSON array parses first —
        // models serialize structured params as strings under load (measured 2026-08-10:
        // docs `blocks` arrived as "[{\"type\":\"header\",...}]" and was refused; the model
        // had the right value in the wrong channel). Parsing is lossless and unambiguous;
        // the parsed value then walks the same item coercion as a native array.
        // Otherwise: wrapping is lossless; splitting is a guess, so it happens ONLY when the
        // whole string fails the declared enum and every comma-part passes it (measured: ta
        // `which` arriving as "macd,rsi").
        (Some("array"), V::String(s)) => {
            let t = s.trim();
            if t.starts_with('[') || t.starts_with('{') {
                if let Ok(parsed @ V::Array(_)) = serde_json::from_str::<V>(t) {
                    notes.push(format!("{path}: JSON string → array"));
                    return coerce_node(&parsed, schema, path, notes);
                }
                // A hand-serialized OBJECT where a list is declared parses just as cleanly, and
                // reading it is just as lossless — the wrap into a one-item list is the scalar
                // rule, unchanged. Leaving it a string instead cost a whole exchange: turn 49
                // (2026-08-13) sent `"{\"_cacheKey\": \"…\"}"` to fa's `statements`, which the
                // cache-key carrier absorber would have taken, but the value never became an
                // object so the absorber never saw it and the error blamed the type.
                if let Ok(parsed @ V::Object(_)) = serde_json::from_str::<V>(t) {
                    notes.push(format!("{path}: JSON string → object"));
                    return coerce_node(&parsed, schema, path, notes);
                }
                // It MEANT to be JSON and the JSON is broken — wrapping it would bury that.
                // Measured 2026-08-12: a 3.5KB `sheets` string broke at char 1828, got wrapped
                // as a single-item list, and the error became "sheets[0] is not an object" —
                // a diagnosis pointing at a structure the model never wrote, while the true
                // fix (resend the value) went unsaid because the broken-string hint only
                // recognises a value that is still a string. Leave it alone: the honest type
                // error plus that hint say what actually happened.
                return value.clone();
            }
            let enum_vals: Vec<&str> = schema
                .get("items")
                .and_then(|i| i.get("enum"))
                .and_then(|e| e.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let whole_ok = enum_vals.is_empty() || enum_vals.contains(&s.trim());
            if !whole_ok && s.contains(',') {
                let parts: Vec<&str> = s.split(',').map(|p| p.trim()).collect();
                if parts.iter().all(|p| !p.is_empty() && enum_vals.contains(p)) {
                    notes.push(format!("{path}: \"{s}\" → list of {}", parts.len()));
                    return V::Array(parts.into_iter().map(|p| V::String(p.to_string())).collect());
                }
            }
            notes.push(format!("{path}: scalar → single-item list"));
            V::Array(vec![value.clone()])
        }
        (Some("integer"), V::String(s)) => match s.trim().parse::<i64>() {
            Ok(n) => { notes.push(format!("{path}: string → integer")); serde_json::json!(n) }
            Err(_) => value.clone(),
        },
        // 3.0 for an integer slot is the same number, not a different one.
        (Some("integer"), V::Number(n)) if n.is_f64() => match n.as_f64() {
            Some(f) if f.fract() == 0.0 => {
                notes.push(format!("{path}: float → integer"));
                serde_json::json!(f as i64)
            }
            _ => value.clone(),
        },
        (Some("number"), V::String(s)) => match s.trim().parse::<f64>() {
            Ok(f) => match serde_json::Number::from_f64(f) {
                Some(num) => { notes.push(format!("{path}: string → number")); V::Number(num) }
                None => value.clone(),
            },
            Err(_) => value.clone(),
        },
        // "true"/"false" in a boolean slot has exactly one reading. Any other string stays put so
        // validation refuses it honestly.
        (Some("boolean"), V::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => { notes.push(format!("{path}: string → boolean")); V::Bool(true) }
            "false" => { notes.push(format!("{path}: string → boolean")); V::Bool(false) }
            _ => value.clone(),
        },
        // 역방향 — 스키마가 string 인데 모델이 스칼라를 따옴표 없이 보낸 경우. 값 자체는 따옴표만
        // 붙는 것이라 손실 0이고, enum·pattern 제약은 뒤 검증이 그대로 잡는다.
        (Some("string"), V::Number(n)) => {
            notes.push(format!("{path}: number → string"));
            V::String(n.to_string())
        }
        (Some("string"), V::Bool(b)) => {
            notes.push(format!("{path}: boolean → string"));
            V::String(b.to_string())
        }
        _ => value.clone(),
    }
}

/// 컴파일 스키마 캐시 — validate_value 가 호출마다 재컴파일하던 것(키움 313-enum 급 스키마가
/// 도구 호출 hot path 에서 매번 파싱·컴파일). 키 = 스키마 직렬화 해시(내용 기반이라 config 편집
/// 시 새 키 = 무효화 문제 0). 캡 초과 시 전체 드롭(단순 — 모듈 수 유한이라 사실상 미발동).
fn compiled_schema_cached(
    schema: &serde_json::Value,
) -> Result<std::sync::Arc<jsonschema::JSONSchema>, String> {
    use std::collections::HashMap;
    use std::hash::{Hash, Hasher};
    use std::sync::{Arc, Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<u64, Arc<jsonschema::JSONSchema>>>> = OnceLock::new();
    const CACHE_CAP: usize = 128;

    let key = {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        schema.to_string().hash(&mut h);
        h.finish()
    };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let guard = cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = guard.get(&key) {
            return Ok(c.clone());
        }
    }
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
    let arc = Arc::new(compiled);
    let mut guard = cache.lock().unwrap_or_else(|p| p.into_inner());
    if guard.len() >= CACHE_CAP {
        guard.clear();
    }
    guard.insert(key, arc.clone());
    Ok(arc)
}

/// JSON Schema 기준 단일 value 검증. 첫 에러만 사용자에게 노출 (스키마 전체 dump 회피).
/// input 스키마의 `action` enum 에 그 값이 선언돼 있나. enum 이 없으면(단일 액션 모듈) false.
fn schema_declares_action(input_schema: &serde_json::Value, action: &str) -> bool {
    input_schema
        .get("properties")
        .and_then(|p| p.get("action"))
        .and_then(|a| a.get("enum"))
        .and_then(|e| e.as_array())
        .map(|arr| arr.iter().any(|v| v.as_str() == Some(action)))
        .unwrap_or(false)
}

pub fn validate_value(
    value: &serde_json::Value,
    schema: &serde_json::Value,
) -> Result<(), String> {
    // 거대 enum 오류 캡 — "is not one of [275개 전체]" 가 도구 결과로 그대로 가면
    // 컨텍스트 폭탄 + 약한 모델이 목록에서 아무거나 집는 유도(2026-07-06 실측: 한투 275
    // 액션 덤프를 보고 주문 API 를 시세용으로 선택). 앞부분만 남기고 char-경계 안전 절단.
    const MAX_ERR_CHARS: usize = 400;
    // How much of the offending VALUE may be echoed back. jsonschema's Display leads with the
    // whole instance, so a 50KB `blocks` array pushed the reason — the only actionable part —
    // past the downstream truncation and the model never learned WHY the call failed: four
    // rounds of guessing on make_xlsx (measured 2026-08-12). Reason and path lead; the value
    // follows as an excerpt.
    const MAX_VALUE_CHARS: usize = 200;

    let compiled = compiled_schema_cached(schema)?;
    if let Err(errors) = compiled.validate(value) {
        let mut suggestion: Option<String> = None;
        let mut excerpt: Option<String> = None;
        let mut accepted: Option<String> = None;
        let first = errors
            .into_iter()
            .next()
            .map(|e| {
                // A wrong enum value is usually a NEAR MISS of a right one — the model composed
                // "forecast_short" out of a domain word and the real "short" (measured
                // 2026-08-09), then spent three rounds on search→schema→retry. Naming the
                // nearest legal value turns that into one corrected retry. Only clear winners
                // are suggested; a vague guess would steer worse than the discovery ladder.
                if let jsonschema::error::ValidationErrorKind::Enum { options } = &e.kind {
                    let got = e
                        .instance
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| e.instance.to_string());
                    suggestion = options.as_array().and_then(|arr| nearest_enum_value(&got, arr));
                }
                // A refused EXTRA property is the same near-miss in the other direction: the
                // model asked for a real capability under a plausible generic name. Measured
                // 2026-08-13 (turn 56): law-search was called with `limit: "5"` and refused —
                // it declares `display`, and the message said only that `limit` was unexpected,
                // so the ask was dropped rather than renamed. Name the nearest declared property.
                if let jsonschema::error::ValidationErrorKind::AdditionalProperties { unexpected } =
                    &e.kind
                {
                    let declared: Vec<serde_json::Value> = schema
                        .get("properties")
                        .and_then(|p| p.as_object())
                        .map(|o| o.keys().map(|k| serde_json::json!(k)).collect())
                        .unwrap_or_default();
                    suggestion = unexpected
                        .first()
                        .and_then(|got| nearest_enum_value(got, &declared));
                    // A lexical near-miss only catches typos, and this was not one: `limit` and
                    // `display` mean the same thing and share no letters. So the message also
                    // NAMES what this action accepts — scoped by the `[action]` tag the
                    // descriptions already carry, because 47 params on one module is a list
                    // nobody reads.
                    accepted = accepted_property_list(schema, value);
                }
                // A big instance is lifted OUT of the reason and kept as an excerpt; a small one
                // stays inline, where jsonschema's own wording reads best ("\"forecast_short\" is
                // not one of […]"). `strip_prefix` is the whole test: the Display forms that lead
                // with the instance are exactly the ones worth rewriting, and the ones that do not
                // (required property, additional properties) are already reason-first.
                let instance = e.instance.to_string();
                let reason = if instance.chars().count() > MAX_VALUE_CHARS {
                    excerpt = Some(instance.chars().take(MAX_VALUE_CHARS).collect());
                    match e
                        .to_string()
                        .strip_prefix(instance.as_str())
                        .map(|rest| rest.trim_start().to_string())
                        .filter(|rest| !rest.is_empty())
                    {
                        Some(rest) => format!("value {rest}"),
                        None => e.to_string(),
                    }
                } else {
                    e.to_string()
                };
                // The path stays in `(path: …)`: the cacheInputs and broken-JSON hints downstream
                // find their parameter by substring-matching it.
                (reason, e.instance_path.to_string())
            })
            .unwrap_or_else(|| {
                (
                    crate::i18n::t("core.error.module.unknown_validation", None, &[]),
                    String::new(),
                )
            });
        // The cap applies to the REASON only — path, did-you-mean and the value excerpt are
        // appended afterwards so they always survive the truncation.
        let (reason, path) = first;
        let mut msg = if reason.chars().count() > MAX_ERR_CHARS {
            let capped: String = reason.chars().take(MAX_ERR_CHARS).collect();
            format!("{capped}… (truncated)")
        } else {
            reason
        };
        msg.push_str(&format!(" (path: {path})"));
        if let Some(s) = suggestion {
            msg.push_str(&format!(" — did you mean \"{s}\"?"));
        }
        if let Some(list) = accepted {
            msg.push_str(&format!(" — this action accepts: {list}."));
        }
        if let Some(v) = excerpt {
            msg.push_str(&format!(
                " offending value (first {MAX_VALUE_CHARS} chars): {v}…"
            ));
        }
        return Err(msg);
    }
    Ok(())
}

/// The properties this call may carry, as a readable list.
///
/// Scoped by the `[action]` tag convention the descriptions already use (`"[search] 결과 수"`), so
/// a 47-parameter module answers with the dozen that apply instead of everything it has. An
/// untagged property is module-wide and always listed. Capped, because a list too long to read is
/// the same dead end as no list at all.
fn accepted_property_list(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Option<String> {
    const MAX_NAMED: usize = 20;
    let props = schema.get("properties")?.as_object()?;
    let action = value.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let mut names: Vec<&String> = props
        .iter()
        .filter(|(name, sub)| {
            if name.as_str() == "action" {
                return false;
            }
            if action.is_empty() {
                return true;
            }
            let desc = sub.get("description").and_then(|d| d.as_str()).unwrap_or("");
            match desc.strip_prefix('[').and_then(|rest| rest.split_once(']')) {
                // A tag group counts only when it names actions at all; `[필수]` is not a scope.
                Some((tag, _)) if tag.contains(action) => true,
                Some((tag, _)) => !tag.chars().any(|c| c.is_ascii_alphabetic()),
                None => true,
            }
        })
        .map(|(name, _)| name)
        .collect();
    if names.is_empty() {
        return None;
    }
    names.sort();
    let more = names.len().saturating_sub(MAX_NAMED);
    let shown: Vec<&str> = names.iter().take(MAX_NAMED).map(|s| s.as_str()).collect();
    Some(if more > 0 {
        format!("{} (+{more} more)", shown.join(", "))
    } else {
        shown.join(", ")
    })
}

/// The closest legal enum value to a wrong one — only when it is a clear winner.
/// Containment ("forecast_short" ⊃ "short") wins outright; otherwise a small edit distance
/// relative to length. No match = no suggestion, and the discovery hint stands alone.
fn nearest_enum_value(got: &str, options: &[serde_json::Value]) -> Option<String> {
    fn norm(s: &str) -> String {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
            .to_ascii_lowercase()
    }
    fn edit_distance(a: &str, b: &str) -> usize {
        let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
        let mut prev: Vec<usize> = (0..=b.len()).collect();
        for (i, ca) in a.iter().enumerate() {
            let mut cur = vec![i + 1];
            for (j, cb) in b.iter().enumerate() {
                let cost = usize::from(ca != cb);
                cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
            }
            prev = cur;
        }
        prev[b.len()]
    }
    let g = norm(got);
    if g.len() < 2 {
        return None;
    }
    let mut best: Option<(usize, String)> = None;
    for opt in options {
        let Some(o) = opt.as_str() else { continue };
        let on = norm(o);
        if on.len() < 2 {
            continue;
        }
        // Containment either way is the strongest signal a compound guess carries.
        if (on.len() >= 3 && g.contains(&on)) || (g.len() >= 3 && on.contains(&g)) {
            return Some(o.to_string());
        }
        let d = edit_distance(&g, &on);
        if d <= (g.len().max(on.len()) / 3).max(1)
            && best.as_ref().map(|(bd, _)| d < *bd).unwrap_or(true)
        {
            best = Some((d, o.to_string()));
        }
    }
    best.map(|(_, s)| s)
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
            validate_value(&input_for_validation(input_data, input_schema), input_schema).map_err(
                |e| {
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

// 순수 함수 단위 테스트만 여기 — ModuleManager 통합 테스트는 위 주석의 integration 파일.
#[cfg(test)]
mod media_export_path_tests {
    use super::media_export_path;

    /// The export door only carries files a module could legitimately have written —
    /// its own data/ scratch or the user zone. Everything else is a refusal, not a fallback.
    #[test]
    fn only_workspace_data_and_user_paths_pass() {
        assert_eq!(media_export_path("data/docs/out.pptx"), Some("data/docs/out.pptx".into()));
        assert_eq!(media_export_path("user/media/x.wav"), Some("user/media/x.wav".into()));
        assert_eq!(media_export_path("data\\docs\\out.pptx"), Some("data/docs/out.pptx".into()));
        assert_eq!(media_export_path("/etc/passwd"), None);
        assert_eq!(media_export_path("data/../system/prompts/x.md"), None);
        assert_eq!(media_export_path("C:/windows/system32"), None);
        assert_eq!(media_export_path("system/modules/sing/main.py"), None);
        assert_eq!(media_export_path(""), None);
    }
}

#[cfg(test)]
mod coercion_tests {
    use super::*;

    /// A container the model serialized as a string, broken mid-stream, must stay a string.
    /// Regression 2026-08-12: wrapping it produced "sheets[0] is not an object" — a complaint
    /// about a structure nobody wrote — and silenced the hint that names the real fault.
    #[test]
    fn a_broken_json_container_string_is_not_wrapped() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": { "sheets": { "type": "array", "items": { "type": "object" } } }
        });
        let broken = r#"[{"name": "대시보드", "rows": [[1, 2] [3, 4]]}]"#; // missing comma
        let input = serde_json::json!({ "sheets": broken });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &sch, &mut notes);
        assert_eq!(out["sheets"], serde_json::json!(broken), "left as the string it is");
        assert!(
            !notes.iter().any(|n| n.contains("single-item list")),
            "a broken container must not be wrapped: {notes:?}"
        );
        // …and the hint that fires on it names where it broke.
        let hint = broken_json_string_hint("sheets", &input["sheets"]).expect("hint");
        assert!(hint.contains("does not parse"), "{hint}");
        assert!(hint.contains("near:"), "{hint}");
        // The same value wrapped by some other path is still diagnosed.
        let wrapped = serde_json::json!([broken]);
        assert!(broken_json_string_hint("sheets", &wrapped).is_some());
    }

    /// The absorber itself is untouched: valid JSON strings still parse, and a plain scalar
    /// still becomes a one-item list (the reading that has no alternative).
    #[test]
    fn valid_json_strings_parse_and_plain_scalars_still_wrap() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": {
                "sheets": { "type": "array", "items": { "type": "object" } },
                "which":  { "type": "array", "items": { "type": "string" } }
            }
        });
        let input = serde_json::json!({
            "sheets": r#"[{"name": "재무제표"}]"#,
            "which": "macd",
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &sch, &mut notes);
        assert_eq!(out["sheets"][0]["name"], "재무제표");
        assert_eq!(out["which"], serde_json::json!(["macd"]));
        assert!(broken_json_string_hint("sheets", &input["sheets"]).is_none(), "valid JSON = no hint");
    }

    fn schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "typhoonNo": { "type": "string" },
                "count":     { "type": "integer" },
                "ratio":     { "type": "number" },
                "flag":      { "type": "string" },
                "note":      { "type": "string" }
            }
        })
    }

    /// 모델의 JSON 스칼라 타입 흔들림은 양방향으로 나온다 — 양쪽 다 받아야 한다.
    /// 회귀 대상: `typhoonNo: 13` 이 400 나서 라운드를 낭비한 건(2026-07-27 실측).
    #[test]
    fn coerces_both_directions() {
        let input = serde_json::json!({
            "typhoonNo": 13,        // number → string (옛 구현이 놓치던 방향)
            "count": "7",           // string → integer
            "ratio": "1.5",         // string → number
            "flag": true,           // bool → string
            "note": "그대로"        // 이미 맞는 타입 = 무변
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &schema(), &mut notes);
        assert_eq!(out["typhoonNo"], serde_json::json!("13"));
        assert_eq!(out["count"], serde_json::json!(7));
        assert_eq!(out["ratio"], serde_json::json!(1.5));
        assert_eq!(out["flag"], serde_json::json!("true"));
        assert_eq!(out["note"], serde_json::json!("그대로"));
        // 강제 후에는 스키마를 통과해야 한다(이게 목적).
        assert!(validate_value(&out, &schema()).is_ok());
    }

    /// `execute` and `run_module_action` are two spellings of one call for a user module, so the
    /// path form has to resolve to a name — otherwise it is a second way in, and it was: no
    /// is_enabled, no input validation, no auto-cache.
    #[test]
    fn a_user_module_path_resolves_to_its_module_name() {
        assert_eq!(
            ModuleManager::module_name_of_user_path("user/modules/my-tool"),
            Some("my-tool")
        );
        assert_eq!(
            ModuleManager::module_name_of_user_path("user/modules/my-tool/"),
            Some("my-tool")
        );
    }

    /// Anything that is not a module directory stays on the raw path — a script inside a module,
    /// a system path, a traversal attempt.
    #[test]
    fn only_a_module_directory_resolves() {
        for path in [
            "user/modules/my-tool/main.py",
            "user/scripts/thing.py",
            "system/modules/yfinance",
            "user/modules/",
            "user/modules/../../etc",
        ] {
            assert_eq!(
                ModuleManager::module_name_of_user_path(path),
                None,
                "must not resolve: {path}"
            );
        }
    }

    /// Flat params relocate into the single declared object container — and ONLY under
    /// A refused extra property must leave the caller knowing what to send instead. `limit` and
    /// `display` mean the same thing and share no letters, so a lexical did-you-mean cannot save
    /// this one — the list can (2026-08-13, law-search).
    #[test]
    fn a_refused_extra_property_names_what_the_action_accepts() {
        let schema = serde_json::json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "action": {"type": "string", "enum": ["search", "detail"]},
                "query": {"type": "string", "description": "[search] 검색 키워드"},
                "display": {"type": "integer", "description": "[search] 결과 수 (최대 100)"},
                "ID": {"type": "string", "description": "[detail] 법령ID"},
                "target": {"type": "string", "description": "검색 대상"}
            }
        });
        let call = serde_json::json!({"action": "search", "query": "이혼", "limit": "5"});
        let err = validate_value(&call, &schema).unwrap_err();
        assert!(err.contains("this action accepts"), "{err}");
        assert!(err.contains("display"), "the capability it asked for, by its real name: {err}");
        assert!(err.contains("target"), "an untagged param applies to every action: {err}");
        assert!(!err.contains("ID"), "another action's params are noise here: {err}");
    }

    /// additionalProperties:false with exactly one container (2026-08-12: kiwoom opened
    /// three turns in a row with base_dt/stk_cd at the top level).
    #[test]
    fn flat_params_relocate_into_the_single_container() {
        let sch = serde_json::json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "action": {"type": "string"},
                "params": {"type": "object"},
                "mock": {"type": "boolean"}
            }
        });
        let input = serde_json::json!({
            "action": "ka10081", "base_dt": "20260812", "stk_cd": "005930"
        });
        let (out, moved) =
            relocate_unknowns_into_container(&input, &sch).expect("one legal reading");
        assert_eq!(out["params"]["base_dt"], "20260812");
        assert_eq!(out["params"]["stk_cd"], "005930");
        assert!(out.get("base_dt").is_none());
        assert_eq!(out["action"], "ka10081");
        assert!(moved.contains("base_dt") && moved.contains("stk_cd"));
        // An existing inner key is never overwritten.
        let input2 = serde_json::json!({
            "action": "a", "params": {"stk_cd": "111111"}, "stk_cd": "005930"
        });
        let (out2, _) = relocate_unknowns_into_container(&input2, &sch).unwrap();
        assert_eq!(out2["params"]["stk_cd"], "111111");
        // Two containers = ambiguous = untouched.
        let two = serde_json::json!({
            "type": "object", "additionalProperties": false,
            "properties": {"query": {"type": "object"}, "body": {"type": "object"}}
        });
        assert!(relocate_unknowns_into_container(&input, &two).is_none());
        // A permissive schema (no additionalProperties:false) = untouched.
        let open = serde_json::json!({
            "type": "object", "properties": {"params": {"type": "object"}}
        });
        assert!(relocate_unknowns_into_container(&input, &open).is_none());
    }

    /// The framework's own top-level keys are not the caller's flat params. Regression target:
    /// the injected `account` was swept into kiwoom's `params`, the infra sandbox read nothing at
    /// the top level, and every call died with "KIWOOM_APP_KEY 미설정" on an account whose keys
    /// were stored (measured 2026-08-12).
    #[test]
    fn framework_reserved_keys_never_relocate() {
        let sch = serde_json::json!({
            "type": "object", "additionalProperties": false,
            "properties": {"action": {"type": "string"}, "params": {"type": "object"}}
        });
        let input = serde_json::json!({
            "action": "ka10081", "account": "키움토스", "base_dt": "20260812"
        });
        let (out, moved) = relocate_unknowns_into_container(&input, &sch).unwrap();
        assert_eq!(out["account"], "키움토스", "account must stay at the top level");
        assert!(out["params"].get("account").is_none());
        assert_eq!(out["params"]["base_dt"], "20260812");
        assert_eq!(moved, "base_dt", "only the real flat params are reported moved");
        // `account` alone leaves nothing to relocate — no rewrite at all.
        let only_account = serde_json::json!({"action": "ka10081", "account": "키움토스"});
        assert!(relocate_unknowns_into_container(&only_account, &sch).is_none());
    }

    /// Pipeline order: coercion parses stringified containers, THEN cache expansion traverses
    /// them. Regression target 2026-08-12 — `sheets` arrived as a JSON *string* whose items
    /// carried `rowsCacheKey`; expansion could not traverse a string, coercion then parsed it
    /// into a valid but row-less array, and docs shipped a "successful" empty xlsx.
    #[test]
    fn stringified_container_is_parsed_before_cache_expansion() {
        let dir = tempfile::tempdir().unwrap();
        let cache = std::sync::Arc::new(
            crate::utils::sysmod_cache::SysmodCacheAdapter::new(dir.path().to_path_buf()).unwrap(),
        );
        let key = cache
            .data(
                "kiwoom",
                "ka10081:rows",
                serde_json::json!({}),
                vec![
                    serde_json::json!({"d": "2026-08-11", "close": 1}),
                    serde_json::json!({"d": "2026-08-12", "close": 2}),
                ],
                None,
            )
            .unwrap();
        let cfg = serde_json::json!({
            "cacheInputs": ["sheets.*.rows"],
            "input": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "sheets": {"type": "array", "items": {"type": "object"}}
                }
            }
        });
        let input = serde_json::json!({
            "action": "make_xlsx",
            "sheets": format!(
                r#"[{{"name":"일봉","headers":["d","close"],"rowsCacheKey":"{key}"}}]"#
            ),
        });
        // 1. coercion (what the run path does first)
        let mut notes = Vec::new();
        let coerced = coerce_for_validation(&input, cfg.get("input").unwrap(), &mut notes);
        assert!(coerced["sheets"].is_array(), "JSON string → array");
        // 2. cache expansion, which can now traverse the list
        let out = crate::utils::cache_inputs::expand("docs", &cfg, &coerced, Some(&cache))
            .unwrap()
            .expect("the nested key must expand");
        assert_eq!(out["sheets"][0]["rows"].as_array().unwrap().len(), 2);
        assert_eq!(out["sheets"][0]["rows"][1]["close"], 2);
        assert!(out["sheets"][0].get("rowsCacheKey").is_none());
        // The reverse order is exactly the bug: expansion sees a string and skips it.
        assert!(
            crate::utils::cache_inputs::expand("docs", &cfg, &input, Some(&cache))
                .unwrap()
                .is_none()
        );
    }

    /// A validation failure must say WHY before it says WHAT — the reason and the path lead, the
    /// offending value follows as a capped excerpt. Regression target 2026-08-12: the whole
    /// `blocks` array came first, the reason was truncated away downstream, and the model spent
    /// four rounds guessing.
    #[test]
    fn validation_error_leads_with_the_reason_and_caps_the_value() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": { "blocks": { "type": "array" } }
        });
        let huge: String = "x".repeat(5_000);
        let err = validate_value(&serde_json::json!({ "blocks": huge }), &sch).unwrap_err();
        assert!(err.starts_with("value is not of type"), "{err}");
        assert!(err.contains("(path: /blocks)"), "{err}");
        assert!(err.contains("offending value (first 200 chars):"), "{err}");
        assert!(err.chars().count() < 1_000, "the value must not be echoed whole: {}", err.len());
        // A small value still reads in jsonschema's own wording, with the path appended.
        let small = validate_value(&serde_json::json!({ "blocks": 7 }), &sch).unwrap_err();
        assert!(small.starts_with("7 is not of type"), "{small}");
        assert!(small.contains("(path: /blocks)"), "{small}");
        assert!(!small.contains("offending value"), "{small}");
    }

    /// 스키마에 없는 키·타입 미선언 키는 건드리지 않는다.
    #[test]
    fn leaves_undeclared_untouched() {
        let input = serde_json::json!({ "unknown": 5, "typhoonNo": "13" });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &schema(), &mut notes);
        assert_eq!(out["unknown"], serde_json::json!(5));
        assert_eq!(out["typhoonNo"], serde_json::json!("13"));
    }

    /// enum·pattern 제약은 강제 뒤 검증이 그대로 잡아야 한다(강제가 검증을 무르게 하면 안 됨).
    #[test]
    fn coercion_does_not_bypass_enum() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": { "action": { "type": "string", "enum": ["quote", "history"] } }
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&serde_json::json!({ "action": 7 }), &sch, &mut notes);
        assert_eq!(out["action"], serde_json::json!("7"));
        assert!(validate_value(&out, &sch).is_err(), "enum 밖 값은 여전히 거부");
    }

    /// The gap the hand-written table had: `boolean` was simply absent, so `"true"` was refused
    /// four times in a row and burned a turn's tool budget (2026-08-09 실측). A schema WALK has
    /// no per-pair table to forget, and it reaches nested values too.
    #[test]
    fn coerces_boolean_and_nested_values() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": {
                "lastSessionOnly": { "type": "boolean" },
                "opts": { "type": "object", "properties": { "depth": { "type": "integer" } } },
                "rows": { "type": "array", "items": { "type": "object",
                          "properties": { "qty": { "type": "number" } } } }
            }
        });
        let input = serde_json::json!({
            "lastSessionOnly": "true",
            "opts": { "depth": "3" },
            "rows": [{ "qty": "1.5" }]
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &sch, &mut notes);
        assert_eq!(out["lastSessionOnly"], serde_json::json!(true));
        assert_eq!(out["opts"]["depth"], serde_json::json!(3));
        assert_eq!(out["rows"][0]["qty"], serde_json::json!(1.5));
        assert!(validate_value(&out, &sch).is_ok());
        assert_eq!(notes.len(), 3, "every change is reported: {notes:?}");
    }

    /// ["number","null"] is the nullable convention every module config uses — a non-null value
    /// there has ONE legal reading and must coerce like a plain "number". Regression target:
    /// fa marketCap "2092836983600" refused five times in one turn (2026-08-10), after which the
    /// model did the arithmetic by hand and published a market cap 10x off.
    #[test]
    fn nullable_union_coerces_like_its_single_type() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": {
                "marketCap": { "type": ["number", "null"] },
                "shares":    { "type": ["number", "null"] },
                "label":     { "type": ["string", "null"] },
                "either":    { "type": ["string", "number"] }   // genuinely ambiguous — untouched
            }
        });
        let input = serde_json::json!({
            "marketCap": "2092836983600",
            "shares": serde_json::Value::Null,   // null side of the union stays null
            "label": 7,
            "either": "5"
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &sch, &mut notes);
        assert_eq!(out["marketCap"], serde_json::json!(2092836983600.0));
        assert_eq!(out["shares"], serde_json::Value::Null);
        assert_eq!(out["label"], serde_json::json!("7"));
        assert_eq!(out["either"], serde_json::json!("5"), "two non-null readings = left alone");
        assert!(validate_value(&out, &sch).is_ok());
    }

    /// A string that IS JSON parses into the declared array/object — models serialize
    /// structured params as strings under load. Regression target: docs `blocks` arriving as
    /// "[{\"type\":\"header\",...}]" was refused with the right value in hand (2026-08-10).
    #[test]
    fn json_strings_parse_into_declared_containers() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": {
                "blocks": { "type": ["array", "null"], "items": { "type": "object" } },
                "opts":   { "type": "object", "properties": { "depth": { "type": "integer" } } },
                "plain":  { "type": "string" }
            }
        });
        let input = serde_json::json!({
            "blocks": "[{\"type\": \"header\", \"props\": {\"level\": \"1\"}}]",
            "opts": "{\"depth\": \"3\"}",
            "plain": "[not json"
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(&input, &sch, &mut notes);
        assert_eq!(out["blocks"][0]["type"], serde_json::json!("header"));
        assert_eq!(out["opts"]["depth"], serde_json::json!(3), "nested coercion runs after parse");
        assert_eq!(out["plain"], serde_json::json!("[not json"), "string slots stay strings");
        assert!(validate_value(&out, &sch).is_ok());
    }

    /// A scalar in a list slot wraps (lossless). It only SPLITS when the whole string fails the
    /// declared enum and every comma-part passes it — otherwise a legitimate comma inside one
    /// value would be mangled.
    #[test]
    fn list_slot_wraps_but_splits_only_when_unambiguous() {
        let sch = serde_json::json!({
            "type": "object",
            "properties": { "which": { "type": "array",
                            "items": { "type": "string", "enum": ["macd", "rsi"] } },
                            "tags": { "type": "array", "items": { "type": "string" } } }
        });
        let mut notes = Vec::new();
        let out = coerce_for_validation(
            &serde_json::json!({ "which": "macd,rsi", "tags": "a,b" }), &sch, &mut notes);
        assert_eq!(out["which"], serde_json::json!(["macd", "rsi"]), "enum 로 확인되면 분리");
        assert_eq!(out["tags"], serde_json::json!(["a,b"]), "확인할 enum 이 없으면 통째로 감싼다");
    }
}

#[cfg(test)]
mod ws_frame_tests {
    use super::{parse_ws_jwt, parse_ws_login, substitute_ws_frame, ws_group_no, ws_str_list};
    use serde_json::json;

    #[test]
    fn fills_scalars_and_defaults() {
        let tpl = json!({"trnm": "REG", "grp_no": "{grpNo}", "data": [{"item": ["{item}"], "type": ["{type:0B}"]}]});
        let out = substitute_ws_frame(&tpl, &json!({"item": "005930", "grpNo": "1234"})).unwrap();
        assert_eq!(out["grp_no"], "1234");
        assert_eq!(out["data"][0]["item"][0], "005930");
        assert_eq!(out["data"][0]["type"][0], "0B", "an absent arg falls back to the declared default");
    }

    #[test]
    fn a_lone_placeholder_in_a_list_expands_into_the_list() {
        // One declaration has to serve one symbol and a batch of them: on a provider that caps
        // sessions per token, needing a frame per symbol is the whole difficulty.
        let tpl = json!({"data": [{"item": ["{item}"]}]});
        let out = substitute_ws_frame(&tpl, &json!({"item": ["005930", "000660"]})).unwrap();
        assert_eq!(out["data"][0]["item"], json!(["005930", "000660"]));
    }

    #[test]
    fn builds_the_object_a_provider_expects() {
        // kiwoom's US registration takes {jmcode, stex_tp} where the domestic one takes a code.
        let tpl = json!({"data": [{"item": [{"jmcode": "{item}", "stex_tp": "{stexTp:ND}"}]}]});
        let out = substitute_ws_frame(&tpl, &json!({"item": "NVDA"})).unwrap();
        assert_eq!(out["data"][0]["item"][0]["jmcode"], "NVDA");
        assert_eq!(out["data"][0]["item"][0]["stex_tp"], "ND");
    }

    #[test]
    fn structured_args_reach_the_wire_intact() {
        let tpl = json!({"data": "{payload}"});
        let out = substitute_ws_frame(&tpl, &json!({"payload": [{"a": 1}]})).unwrap();
        assert_eq!(out["data"], json!([{"a": 1}]));
    }

    #[test]
    fn an_absent_optional_arg_drops_its_key() {
        // Account-scoped realtime types (order fills, holdings) ignore the subscription id, yet
        // requiring it meant inventing a value just to subscribe to your own fills.
        let tpl = json!({"trnm": "REG", "data": [{"item": ["{item?}"], "type": ["{type:00}"]}]});
        let out = substitute_ws_frame(&tpl, &json!({})).unwrap();
        assert!(out["data"][0].get("item").is_none(), "key is left out, not sent empty");
        assert_eq!(out["data"][0]["type"][0], "00");
        // Supplied as usual when a value is given.
        let out = substitute_ws_frame(&tpl, &json!({"item": "005930"})).unwrap();
        assert_eq!(out["data"][0]["item"][0], "005930");
    }

    #[test]
    fn a_handshake_authenticated_venue_declares_no_login_frame() {
        // Upbit signs the upgrade request; there is no frame to send and nothing to wait for.
        // The absence has to survive parsing as a shape, or the transport waits for an ack that
        // the venue is never going to send.
        let login = parse_ws_login(&json!({
            "login": {
                "headers": {"Authorization": "Bearer {JWT}"},
                "jwt": {
                    "algorithm": "HS512",
                    "accessKeySecret": "UPBIT_ACCESS_KEY",
                    "secretKeySecret": "UPBIT_SECRET_KEY"
                }
            }
        }))
        .expect("login declared");
        assert!(login.frame.is_none());
        assert_eq!(
            login
                .headers
                .as_ref()
                .and_then(|h| h.get("Authorization"))
                .map(|v| v.as_str()),
            Some("Bearer {JWT}")
        );
        let jwt = login.jwt.expect("jwt declared");
        assert_eq!(jwt.algorithm, "HS512");
        assert_eq!(jwt.access_claim, "access_key");
        assert_eq!(jwt.nonce_claim, "nonce");
    }

    #[test]
    fn a_half_declared_jwt_is_not_a_jwt() {
        // Signing with a key we do not hold produces a token the venue rejects — and it would be
        // rejected at the socket, minutes later, looking like a credential problem.
        assert!(parse_ws_jwt(&json!({"accessKeySecret": "A"})).is_none());
        assert!(parse_ws_jwt(&json!({"secretKeySecret": "B"})).is_none());
        assert!(parse_ws_jwt(&json!({"accessKeySecret": "A", "secretKeySecret": "B"})).is_some());
    }

    #[test]
    fn a_missing_required_arg_is_an_error_not_an_empty_frame() {
        let tpl = json!({"item": "{item}"});
        assert!(substitute_ws_frame(&tpl, &json!({})).is_err());
    }

    #[test]
    fn group_numbers_differ_per_watch_and_are_stable() {
        let a = ws_group_no("ws-kiwoom-quotes-aaaa1111");
        let b = ws_group_no("ws-kiwoom-quotes-bbbb2222");
        assert_ne!(a, b, "watches sharing a group would tear down each other's registrations");
        assert_eq!(a, ws_group_no("ws-kiwoom-quotes-aaaa1111"), "must survive a restart");
        assert_eq!(a.len(), 4, "the provider caps the group field at four characters");
    }

    #[test]
    fn subscription_lists_accept_one_value_or_many() {
        assert_eq!(ws_str_list(Some(&json!("005930"))), vec!["005930"]);
        assert_eq!(ws_str_list(Some(&json!(["005930", "000660"]))), vec!["005930", "000660"]);
        assert!(ws_str_list(None).is_empty(), "no declaration means route everything on the type");
    }
}

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
            tracing::info!(
                target: "module",
                module = %module_name,
                "input dialect absorbed — inputData envelope normalized"
            );
        }
        let input_data: &serde_json::Value = normalized.as_ref().unwrap_or(input_data);

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
        if unstrung.is_some() {
            tracing::info!(
                target: "module",
                module = %module_name,
                "input dialect absorbed — stringified JSON field parsed"
            );
        }
        let input_data: &serde_json::Value = unstrung.as_ref().unwrap_or(input_data);

        // A declared array parameter may arrive as a cache key — expand it BEFORE validation, so
        // `required` still means what it says and the module receives real rows either way.
        let expanded = match &config {
            Some(cfg) => crate::utils::cache_inputs::expand(
                module_name,
                cfg,
                input_data,
                self.sysmod_cache.as_ref(),
            )?,
            None => None,
        };
        let input_data: &serde_json::Value = expanded.as_ref().unwrap_or(input_data);

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
        let coerced: Option<serde_json::Value> = config
            .as_ref()
            .and_then(|c| c.get("input"))
            .map(|schema| coerce_for_validation(input_data, schema))
            .filter(|c| c != input_data);
        let input_data: &serde_json::Value = coerced.as_ref().unwrap_or(input_data);

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
                    return Err(crate::i18n::t(
                        "core.error.module.input_validation_failed_catalog",
                        None,
                        &[("name", module_name), ("detail", &detail)],
                    ));
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
                let mut exec_opts = SandboxExecuteOpts {
                    skip_auto_cache,
                    keep_full_rows,
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

        Ok(result)
    }

    /// The module's own record, for an action its config named in `recall.actions`.
    ///
    /// Returns None when nothing is declared, nothing is stored, or the store is not wired — in
    /// each case the module runs exactly as it did before, which is what makes this safe to add
    /// to a module that has never heard of it.
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
            notify: notify.to,
            notify_action: notify.action,
            notify_min_interval_ms: notify.min_interval_ms,
            notify_job: notify.job,
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
            field_order,
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
        self.module_config(name)
            .await
            .and_then(|c| c.get("schedules").cloned())
            .and_then(|v| v.as_array().cloned())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .filter(|f| f.ends_with(".json") && !f.contains("..") && !f.contains('/'))
                    .collect()
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
        let Some(ty) = props.get(k).and_then(|p| p.get("type")).and_then(|t| t.as_str()) else {
            continue;
        };
        match (ty, v) {
            ("integer", serde_json::Value::String(s)) => {
                if let Ok(n) = s.trim().parse::<i64>() {
                    out.insert(k.clone(), serde_json::json!(n));
                }
            }
            ("number", serde_json::Value::String(s)) => {
                if let Ok(n) = s.trim().parse::<f64>() {
                    if let Some(num) = serde_json::Number::from_f64(n) {
                        out.insert(k.clone(), serde_json::Value::Number(num));
                    }
                }
            }
            // 역방향 — 스키마가 string 인데 모델이 스칼라를 따옴표 없이 보낸 경우.
            // 옛 구현은 string→number 한 방향뿐이라 `typhoonNo: 13` 이 그대로 400 이었다
            // (2026-07-27 실측: 태풍 조회가 한 라운드 낭비). 모델의 JSON 스칼라 타입 흔들림은
            // 양방향으로 나오므로 대칭으로 받는다. 값 자체는 따옴표만 붙는 것이라 손실 0이고,
            // enum·pattern 제약은 뒤 검증이 그대로 잡는다.
            ("string", serde_json::Value::Number(n)) => {
                out.insert(k.clone(), serde_json::Value::String(n.to_string()));
            }
            ("string", serde_json::Value::Bool(b)) => {
                out.insert(k.clone(), serde_json::Value::String(b.to_string()));
            }
            _ => {}
        }
    }
    serde_json::Value::Object(out)
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
    let compiled = compiled_schema_cached(schema)?;
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
mod coercion_tests {
    use super::*;

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
        let out = coerce_for_validation(&input, &schema());
        assert_eq!(out["typhoonNo"], serde_json::json!("13"));
        assert_eq!(out["count"], serde_json::json!(7));
        assert_eq!(out["ratio"], serde_json::json!(1.5));
        assert_eq!(out["flag"], serde_json::json!("true"));
        assert_eq!(out["note"], serde_json::json!("그대로"));
        // 강제 후에는 스키마를 통과해야 한다(이게 목적).
        assert!(validate_value(&out, &schema()).is_ok());
    }

    /// 스키마에 없는 키·타입 미선언 키는 건드리지 않는다.
    #[test]
    fn leaves_undeclared_untouched() {
        let input = serde_json::json!({ "unknown": 5, "typhoonNo": "13" });
        let out = coerce_for_validation(&input, &schema());
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
        let out = coerce_for_validation(&serde_json::json!({ "action": 7 }), &sch);
        assert_eq!(out["action"], serde_json::json!("7"));
        assert!(validate_value(&out, &sch).is_err(), "enum 밖 값은 여전히 거부");
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

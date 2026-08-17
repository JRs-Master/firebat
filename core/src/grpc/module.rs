//! gRPC ModuleService impl — ModuleManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core managers struct ↔ proto generated struct 변환.
//!
//! 2026-05-15 unique RPC message — Empty/StringRequest/BoolRequest/RawJsonPb shared 폐기 +
//! RPC 별 명시 message. 동적 schema 응답 (config / settings 등) 은 단일 raw_json 필드 보존.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::ai::dynamic_tools::DynamicToolRegistry;
use crate::managers::module::{ModuleManager, SystemEntry};
use crate::ports::{ModuleOutput, PackageStatus, PackageStatusKind};
use crate::proto::{
    module_service_server::ModuleService, ModuleDeleteAccountRequest,
    ModuleDeleteAccountResponse, ModuleEntryPb, ModuleGetAccountsRequest,
    ModuleGetAccountsResponse, ModuleGetCmsSettingsRequest,
    ModuleGetCmsSettingsResponse, ModuleGetConfigRequest, ModuleGetConfigResponse,
    ModuleGetComponentVendorKeysRequest, ModuleGetComponentVendorKeysResponse, ModuleGetLangRequest,
    ModuleGetLangResponse, ModuleGetPackageStatusRequest, ModuleGetPackageStatusResponse,
    ModuleGetSchemaRequest, ModuleGetSchemaResponse, ModuleGetSettingsRequest,
    ModuleGetSettingsResponse, ModuleInstallPackagesRequest, ModuleInstallPackagesResponse,
    ModuleIsEnabledRequest, ModuleIsEnabledResponse, ModuleListSystemRequest,
    ModuleListSystemResponse, ModuleListUserRequest, ModuleListUserResponse, ModuleOutputPb,
    ModuleRunRequest, ModuleSaveAccountRequest, ModuleSaveAccountResponse,
    ModuleRunUiActionRequest, ModuleRunUiActionResponse,
    ModuleSetEnabledRequest, ModuleSetEnabledResponse, ModuleSetSettingsRequest,
    ModuleSetSettingsResponse, ModuleWebhookProcessRequest, ModuleWebhookProcessResponse,
    ModuleWebhookVerifyRequest, ModuleWebhookVerifyResponse, PackageStatusPb,
};

pub struct ModuleServiceImpl {
    manager: Arc<ModuleManager>,
    /// 옵션 — 토글 / settings 변경 시 AI 도구 cache 즉시 무효화. None 시 60초 TTL 자연 만료 대기.
    dynamic_tools: Option<Arc<DynamicToolRegistry>>,
    /// 옵션 — 토글 시 모듈이 선언한 스케줄 등록/철회. 스케줄러는 Core 를 통해서만 닿는다.
    core: Option<Arc<crate::core_facade::Core>>,
    /// The discovery index. Its rebuild trigger is a fingerprint of the module directories, and a
    /// toggle writes a vault key — nothing on disk moves — so the fingerprint cannot see it. The
    /// tool registry has always been invalidated here; the index is the other half of the same
    /// event, and without it a module switched on stayed unsearchable until the debounce expired.
    action_catalog: Option<Arc<crate::managers::ai::action_catalog::ModuleActionCatalog>>,
    /// 옵션 — inbound webhook 의 AI 왕복(WebhookProcess). 미설정 = parse 만 돌고 답 없음.
    ai: Option<Arc<crate::managers::ai::AiManager>>,
}

impl ModuleServiceImpl {
    pub fn new(manager: Arc<ModuleManager>) -> Self {
        Self { manager, dynamic_tools: None, core: None, action_catalog: None, ai: None }
    }

    /// Wire the AI so a declared webhook can answer — parse → AI turn → declared reply action.
    pub fn with_ai(mut self, ai: Arc<crate::managers::ai::AiManager>) -> Self {
        self.ai = Some(ai);
        self
    }

    /// 토글 / settings 변경 직후 AI 가 즉시 갱신된 도구 목록 인식하도록 cache invalidate 연결.
    /// Wire the mediator so enabling a module registers the schedules it declares.
    pub fn with_core(mut self, core: Arc<crate::core_facade::Core>) -> Self {
        self.core = Some(core);
        self
    }

    pub fn with_dynamic_tools(mut self, registry: Arc<DynamicToolRegistry>) -> Self {
        self.dynamic_tools = Some(registry);
        self
    }

    pub fn with_action_catalog(
        mut self,
        catalog: Arc<crate::managers::ai::action_catalog::ModuleActionCatalog>,
    ) -> Self {
        self.action_catalog = Some(catalog);
        self
    }

    /// Both surfaces a toggle changes: which tools exist, and which actions can be found. They are
    /// invalidated together because a model that can search an action it cannot call — or call one
    /// it cannot find — is looking at two answers to the same question.
    async fn invalidate_tools_cache(&self) {
        if let Some(reg) = &self.dynamic_tools {
            reg.invalidate().await;
        }
        if let Some(cat) = &self.action_catalog {
            cat.invalidate().await;
        }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

// ─── proto ↔ core managers struct 변환 ────────────────────────────────────────

impl From<SystemEntry> for ModuleEntryPb {
    fn from(e: SystemEntry) -> Self {
        ModuleEntryPb {
            name: e.name,
            description: e.description,
            runtime: e.runtime,
            entry_type: e.entry_type,
            scope: e.scope,
            enabled: e.enabled,
        }
    }
}

impl From<ModuleOutput> for ModuleOutputPb {
    fn from(o: ModuleOutput) -> Self {
        ModuleOutputPb {
            success: o.success,
            data_json: if o.data.is_null() {
                None
            } else {
                serde_json::to_string(&o.data).ok()
            },
            error: o.error,
            stderr: o.stderr,
            exit_code: o.exit_code,
            protocol_version: o.protocol_version,
            error_key: o.error_key,
            error_params_json: o
                .error_params
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok()),
        }
    }
}

impl From<PackageStatus> for PackageStatusPb {
    fn from(s: PackageStatus) -> Self {
        let status = match s.status {
            PackageStatusKind::Installed => "installed",
            PackageStatusKind::Missing => "missing",
            PackageStatusKind::InProgress => "in_progress",
            PackageStatusKind::Failed => "failed",
        };
        PackageStatusPb {
            name: s.name,
            status: status.to_string(),
            job_id: s.job_id,
            error: s.error,
            installed_version: s.installed_version,
            required_version: s.required_version,
            upgrade_available: s.upgrade_available,
            latest_version: s.latest_version,
        }
    }
}

#[tonic::async_trait]
impl ModuleService for ModuleServiceImpl {
    async fn run(
        &self,
        req: Request<ModuleRunRequest>,
    ) -> Result<Response<ModuleOutputPb>, TonicStatus> {
        let args = req.into_inner();
        let data: serde_json::Value = if args.data_json.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&args.data_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("run data: {e}")))?
        };
        // module field 가 path 형태 (`/` 포함) 면 sandboxExecute (직접 경로 실행), 아니면 run (모듈 이름 + entry 자동 탐색).
        // 두 API 경로를 단일 RPC 로 통합하면서 자동 분기 — frontend wrapper 가 둘 다 같은 RPC 호출.
        // 이 RPC 의 소비자 = 프론트 라우트(/api/module/run · hub sysmod)뿐 = 사람 UI 표면 →
        // auto-cache truncation 비적용(run_raw). 모델 경로(FC/MCP/cron/파이프라인)는 in-process
        // manager.run 직행이라 이 핸들러를 안 탄다.
        let result = if args.module.contains('/') || args.module.contains('\\') {
            self.manager
                .execute(
                    &args.module,
                    &data,
                    &crate::ports::SandboxExecuteOpts {
                        skip_auto_cache: true,
                        ..crate::ports::SandboxExecuteOpts::default()
                    },
                )
                .await
        } else {
            self.manager.run_raw(&args.module, &data).await
        };
        match result {
            Ok(output) => Ok(Response::new(output.into())),
            Err(e) => Ok(Response::new(ModuleOutputPb {
                success: false,
                data_json: None,
                error: Some(e),
                stderr: None,
                exit_code: None,
                protocol_version: "1.0".to_string(),
                error_key: None,
                error_params_json: None,
            })),
        }
    }

    async fn list_system(
        &self,
        _req: Request<ModuleListSystemRequest>,
    ) -> Result<Response<ModuleListSystemResponse>, TonicStatus> {
        let entries = self
            .manager
            .list_system()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ModuleListSystemResponse { entries }))
    }

    async fn list_user(
        &self,
        _req: Request<ModuleListUserRequest>,
    ) -> Result<Response<ModuleListUserResponse>, TonicStatus> {
        let entries = self
            .manager
            .list_user_modules()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ModuleListUserResponse { entries }))
    }

    async fn get_schema(
        &self,
        req: Request<ModuleGetSchemaRequest>,
    ) -> Result<Response<ModuleGetSchemaResponse>, TonicStatus> {
        let args = req.into_inner();
        let config = self.manager.get_module_config(&args.scope, &args.name).await;
        Ok(Response::new(ModuleGetSchemaResponse {
            raw_json: to_raw_json(&config),
        }))
    }

    async fn get_settings(
        &self,
        req: Request<ModuleGetSettingsRequest>,
    ) -> Result<Response<ModuleGetSettingsResponse>, TonicStatus> {
        let name = req.into_inner().name;
        let settings = self.manager.get_settings(&name);
        Ok(Response::new(ModuleGetSettingsResponse {
            raw_json: to_raw_json(&settings),
        }))
    }

    async fn get_config(
        &self,
        req: Request<ModuleGetConfigRequest>,
    ) -> Result<Response<ModuleGetConfigResponse>, TonicStatus> {
        // 옛 TS `Core.getModuleConfig(name)` 1:1 — `ModuleManager.getConfig(name)` 호출.
        // system/modules → system/services → user/modules 순서. 호출자 (e.g. /api/settings/modules)
        // 가 scope 모를 때 첫 hit 반환. 옛 코드 user scope 만 시도해 system 모듈 (browser-scrape /
        // kakao-talk / kiwoom 등) 의 secrets 자동 UI 생성 안 되던 버그 (2026-05-10 발견 후 fix).
        let name = req.into_inner().name;
        let config = self.manager.get_config_any_scope(&name).await;
        Ok(Response::new(ModuleGetConfigResponse {
            raw_json: to_raw_json(&config),
        }))
    }

    async fn set_settings(
        &self,
        req: Request<ModuleSetSettingsRequest>,
    ) -> Result<Response<ModuleSetSettingsResponse>, TonicStatus> {
        let args = req.into_inner();
        let settings: serde_json::Value = serde_json::from_str(&args.settings_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("set_settings args: {e}")))?;
        if self.manager.set_settings(&args.name, &settings) {
            // enabled 토글 또는 시크릿 설정 변경 시 AI 도구 cache 즉시 무효화.
            self.invalidate_tools_cache().await;
            Ok(Response::new(ModuleSetSettingsResponse {}))
        } else {
            Err(TonicStatus::internal(crate::i18n::t(
                "core.error.rpc.set_settings_failed",
                None,
                &[],
            )))
        }
    }

    async fn get_accounts(
        &self,
        req: Request<ModuleGetAccountsRequest>,
    ) -> Result<Response<ModuleGetAccountsResponse>, TonicStatus> {
        let module = req.into_inner().module;
        let overview = self.manager.account_overview(&module).await;
        Ok(Response::new(ModuleGetAccountsResponse {
            raw_json: to_raw_json(&overview),
        }))
    }

    async fn save_account(
        &self,
        req: Request<ModuleSaveAccountRequest>,
    ) -> Result<Response<ModuleSaveAccountResponse>, TonicStatus> {
        let args = req.into_inner();
        let entry: crate::utils::account_secrets::AccountEntry = serde_json::from_str(&args.account_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("account_json: {e}")))?;
        let credentials: serde_json::Map<String, serde_json::Value> =
            if args.credentials_json.trim().is_empty() {
                serde_json::Map::new()
            } else {
                serde_json::from_str(&args.credentials_json)
                    .map_err(|e| TonicStatus::invalid_argument(format!("credentials_json: {e}")))?
            };
        self.manager
            .save_account(&args.module, entry, &credentials, args.make_primary)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        // A new account changes what `account` may be — the discovery surfaces read it live, but
        // the tool cache holds descriptions built from the same configs.
        self.invalidate_tools_cache().await;
        // Realtime watches that could not authenticate before now can.
        self.manager.relaunch_missing_streams(&args.module).await;
        Ok(Response::new(ModuleSaveAccountResponse {}))
    }

    async fn delete_account(
        &self,
        req: Request<ModuleDeleteAccountRequest>,
    ) -> Result<Response<ModuleDeleteAccountResponse>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .delete_account(&args.module, &args.id)
            .await
            .map_err(TonicStatus::invalid_argument)?;
        self.invalidate_tools_cache().await;
        Ok(Response::new(ModuleDeleteAccountResponse {}))
    }

    async fn is_enabled(
        &self,
        req: Request<ModuleIsEnabledRequest>,
    ) -> Result<Response<ModuleIsEnabledResponse>, TonicStatus> {
        let name = req.into_inner().name;
        Ok(Response::new(ModuleIsEnabledResponse {
            enabled: self.manager.is_enabled(&name),
        }))
    }

    /// A screen action a person confirmed. Core owns the round trip (decide → broker calls →
    /// record) so the browser never holds an ordering loop; this is the thin adapter.
    async fn run_ui_action(
        &self,
        req: Request<ModuleRunUiActionRequest>,
    ) -> Result<Response<ModuleRunUiActionResponse>, TonicStatus> {
        let args = req.into_inner();
        let Some(core) = self.core.as_ref() else {
            return Err(TonicStatus::failed_precondition(
                "screen actions need the Core facade — this server was built without it",
            ));
        };
        let parsed: serde_json::Value = if args.args_json.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&args.args_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("args_json: {e}")))?
        };
        match core.run_ui_action(&args.module, &args.action, &parsed).await {
            Ok(v) => Ok(Response::new(ModuleRunUiActionResponse {
                success: v.get("success").and_then(|b| b.as_bool()).unwrap_or(true),
                data_json: serde_json::to_string(&v).ok(),
                error: v.get("error").and_then(|e| e.as_str()).map(String::from),
            })),
            Err(e) => Ok(Response::new(ModuleRunUiActionResponse {
                success: false,
                data_json: None,
                error: Some(e),
            })),
        }
    }

    async fn set_enabled(
        &self,
        req: Request<ModuleSetEnabledRequest>,
    ) -> Result<Response<ModuleSetEnabledResponse>, TonicStatus> {
        let args = req.into_inner();
        if self.manager.set_enabled(&args.name, args.enabled) {
            // 토글 직후 AI 가 즉시 갱신 도구 목록 인식 — 60초 TTL 자연 만료 대기 안 함.
            self.invalidate_tools_cache().await;
            // A module that declares schedules gets them registered here rather than by hand.
            // Turning it off withdraws them, so "off" means off rather than off-but-still-firing.
            if let Some(core) = self.core.as_ref() {
                core.sync_module_schedules(&args.name).await;
            }
            Ok(Response::new(ModuleSetEnabledResponse {}))
        } else {
            Err(TonicStatus::internal(crate::i18n::t(
                "core.error.rpc.set_enabled_failed",
                None,
                &[],
            )))
        }
    }

    async fn get_cms_settings(
        &self,
        _req: Request<ModuleGetCmsSettingsRequest>,
    ) -> Result<Response<ModuleGetCmsSettingsResponse>, TonicStatus> {
        let stored = self.manager.get_settings("cms");
        let merged = merge_with_defaults(stored);
        Ok(Response::new(ModuleGetCmsSettingsResponse {
            raw_json: to_raw_json(&merged),
        }))
    }

    async fn get_lang(
        &self,
        req: Request<ModuleGetLangRequest>,
    ) -> Result<Response<ModuleGetLangResponse>, TonicStatus> {
        // 2026-05-16 — sysmod 설정화면 i18n 분리 (settings_fields[].i18n inline → lang/{lang}.json 별도 파일).
        // any-scope 자동 탐색 + lang fallback (활성 lang → en → ko). 미존재 시 빈 object.
        let args = req.into_inner();
        let lang = if args.lang.is_empty() { "en" } else { &args.lang };
        let data = self.manager.get_module_lang(&args.name, lang).await;
        Ok(Response::new(ModuleGetLangResponse {
            raw_json: to_raw_json(&data),
        }))
    }

    async fn get_component_vendor_keys(
        &self,
        _req: Request<ModuleGetComponentVendorKeysRequest>,
    ) -> Result<Response<ModuleGetComponentVendorKeysResponse>, TonicStatus> {
        // Which browser-side keys exist is a component declaration (`vendorKey` in
        // system/components.json), so this resolves ONLY declared names against the vault —
        // a new vendor component is a declaration, never a new RPC (v3-R4; the predecessor
        // was a kakao-named endpoint). Declaring a key marks it browser-exposable by intent.
        let mut map = serde_json::Map::new();
        for comp in crate::managers::ai::component_registry::components().iter() {
            if let Some(name) = comp.vendor_key.as_deref().filter(|s| !s.is_empty()) {
                if map.contains_key(name) {
                    continue;
                }
                if let Some(v) = self.manager.vault().get_secret(&format!("user:{name}")) {
                    if !v.is_empty() {
                        map.insert(name.to_string(), serde_json::Value::String(v));
                    }
                }
            }
        }
        Ok(Response::new(ModuleGetComponentVendorKeysResponse {
            raw_json: serde_json::Value::Object(map).to_string(),
        }))
    }

    async fn webhook_verify(
        &self,
        req: Request<ModuleWebhookVerifyRequest>,
    ) -> Result<Response<ModuleWebhookVerifyResponse>, TonicStatus> {
        // The ingress route knows nothing about vendors: it forwards every header, and the
        // module's declaration names the one that carries the shared secret. No declaration =
        // no webhook — absence refuses, it never permits.
        let args = req.into_inner();
        let Some(decl) = self.manager.webhook_decl(&args.module).await else {
            return Ok(Response::new(ModuleWebhookVerifyResponse { ok: false }));
        };
        let headers: serde_json::Value =
            serde_json::from_str(&args.headers_json).unwrap_or(serde_json::Value::Null);
        let wanted = decl.secret_header.to_ascii_lowercase();
        let incoming = headers
            .as_object()
            .and_then(|m| {
                m.iter()
                    .find(|(k, _)| k.to_ascii_lowercase() == wanted)
                    .and_then(|(_, v)| v.as_str())
            })
            .unwrap_or("");
        let ok = !incoming.is_empty() && incoming == self.manager.webhook_secret(&decl);
        Ok(Response::new(ModuleWebhookVerifyResponse { ok }))
    }

    async fn webhook_process(
        &self,
        req: Request<ModuleWebhookProcessRequest>,
    ) -> Result<Response<ModuleWebhookProcessResponse>, TonicStatus> {
        // Mechanism only: hand the vendor payload to the declared parse action, run the AI turn
        // on what it distilled, hand the answer to the declared reply action. Everything that
        // knows the vendor's shapes ran inside the module.
        let args = req.into_inner();
        let reply_err = |v: serde_json::Value| {
            Ok(Response::new(ModuleWebhookProcessResponse { raw_json: v.to_string() }))
        };
        let Some(decl) = self.manager.webhook_decl(&args.module).await else {
            return reply_err(serde_json::json!({"success": false, "error": "no webhook declaration"}));
        };
        let payload: serde_json::Value =
            serde_json::from_str(&args.payload_json).unwrap_or(serde_json::Value::Null);
        let parse_input = serde_json::json!({ "action": decl.parse_action, "payload": payload });
        let parsed = match self.manager.run(&args.module, &parse_input).await {
            Ok(out) if out.success => out.data,
            Ok(out) => {
                return reply_err(serde_json::json!({
                    "success": false,
                    "error": format!("{} refused the payload: {}", decl.parse_action, out.error.unwrap_or_default()),
                }))
            }
            Err(e) => {
                return reply_err(serde_json::json!({"success": false, "error": e.to_string()}))
            }
        };
        if !parsed.get("proceed").and_then(|v| v.as_bool()).unwrap_or(false) {
            let note = parsed.get("note").and_then(|v| v.as_str()).unwrap_or("");
            return reply_err(serde_json::json!({"success": true, "skipped": true, "note": note}));
        }
        let prompt = parsed.get("prompt").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        let (Some(ai), Some(reply_action), false) =
            (&self.ai, decl.reply_action.as_deref(), prompt.is_empty())
        else {
            // Receive-only (no reply action / no AI wired / nothing to answer) — the parse ran,
            // whatever it recorded is the outcome.
            return reply_err(serde_json::json!({"success": true, "replied": false}));
        };
        let llm_opts = crate::ports::LlmCallOpts::default();
        let ai_opts = crate::ports::AiRequestOpts::default();
        let reply = match ai.process_with_tools_opts(&prompt, &[], &llm_opts, &ai_opts).await {
            Ok(r) => r.reply.trim().to_string(),
            Err(e) => {
                return reply_err(serde_json::json!({"success": false, "error": format!("AI turn failed: {e}")}))
            }
        };
        if reply.is_empty() {
            return reply_err(serde_json::json!({"success": false, "error": "AI turn produced no reply"}));
        }
        let capped: String = reply.chars().take(decl.reply_max_chars).collect();
        let mut send_input = serde_json::Map::new();
        send_input.insert("action".into(), serde_json::Value::String(reply_action.to_string()));
        if let Some(extra) = parsed.get("replyArgs").and_then(|v| v.as_object()) {
            for (k, v) in extra {
                send_input.insert(k.clone(), v.clone());
            }
        }
        send_input.insert(decl.reply_text_param.clone(), serde_json::Value::String(capped));
        match self.manager.run(&args.module, &serde_json::Value::Object(send_input)).await {
            Ok(out) if out.success => {
                reply_err(serde_json::json!({"success": true, "replied": true}))
            }
            Ok(out) => reply_err(serde_json::json!({
                "success": false,
                "error": format!("{} failed: {}", reply_action, out.error.unwrap_or_default()),
            })),
            Err(e) => reply_err(serde_json::json!({"success": false, "error": e.to_string()})),
        }
    }

    async fn install_packages(
        &self,
        req: Request<ModuleInstallPackagesRequest>,
    ) -> Result<Response<ModuleInstallPackagesResponse>, TonicStatus> {
        let args = req.into_inner();
        let job_ids = self
            .manager
            .install_packages(&args.module, args.upgrade)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ModuleInstallPackagesResponse { job_ids }))
    }

    async fn get_package_status(
        &self,
        req: Request<ModuleGetPackageStatusRequest>,
    ) -> Result<Response<ModuleGetPackageStatusResponse>, TonicStatus> {
        let name = req.into_inner().module;
        let packages = self
            .manager
            .get_package_status(&name)
            .await
            .map_err(TonicStatus::internal)?
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ModuleGetPackageStatusResponse { packages }))
    }
}

/// CMS settings default 객체 + Vault 저장값 merge.
/// 옛 TS `getCmsSettings` 의 default 형태 1:1 port — 새 서버 빈 데이터 시점도 모든 필드 보장.
fn merge_with_defaults(stored: serde_json::Value) -> serde_json::Value {
    let defaults = cms_defaults();
    deep_merge(defaults, stored)
}

fn cms_defaults() -> serde_json::Value {
    serde_json::json!({
        "enabled": true,
        "siteTitle": "Firebat",
        "siteDescription": "Just Imagine. Firebat Runs.",
        "siteUrl": "",
        "siteLang": "ko",
        "favicon": "",
        "jsonLdEnabled": true,
        "jsonLdOrganization": "",
        "jsonLdLogoUrl": "",
        "sitemapEnabled": true,
        "rssEnabled": true,
        "robotsTxt": "User-agent: *\nAllow: /\n",
        "ogBgColor": "#0f172a",
        "ogAccentColor": "#f59e0b",
        "ogDomain": "",
        "twitterCard": "summary_large_image",
        "twitterSite": "",
        "autoCanonical": true,
        "customCss": "",
        "customFontUrls": [],
        "headScripts": "",
        "bodyScripts": "",
        "verifications": [],
        "kakaoMapJsKey": "",
        "tagAliases": {},
        "imageWebp": true,
        "imageAvif": false,
        "imageThumbnail": true,
        "imageBlurhash": true,
        "imageVariants": "480, 768, 1024",
        "imageDefaultQuality": 80,
        "imageDefaultSize": "1024x1024",
        "imageStripExif": true,
        "imageProgressive": true,
        "imageKeepOriginal": false,
        "adsense": {
            "publisherId": "",
            "autoAds": false,
            "slotHeaderBottom": "",
            "slotPostTop": "",
            "slotPostBottom": "",
            "slotFooterTop": "",
            "slotCardFeed": ""
        },
        "theme": {
            "preset": "slate-pro",
            "colors": {
                "primary": "#0f172a",
                "accent": "#f59e0b",
                "up": "#ef4444",
                "down": "#3b82f6",
                "text": "#0f172a",
                "textMuted": "#64748b",
                "bg": "#ffffff",
                "bgCard": "#f8fafc",
                "border": "#e2e8f0"
            },
            "fonts": {
                "body": "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
                "heading": "'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
                "mono": "'JetBrains Mono', 'Fira Code', Consolas, monospace"
            },
            "layout": {
                "contentMaxWidth": "1200px",
                "paddingMobile": "16px",
                "paddingTablet": "24px",
                "paddingDesktop": "32px",
                "radius": "8px"
            },
            "heading": {
                "h1": "plain",
                "h2": "border-left",
                "h3": "plain"
            },
            "typography": {
                "baseFontSize": "16px",
                "scaleRatio": 1.25,
                "bodyLineHeight": 1.7,
                "headingLineHeight": 1.25,
                "headingLetterSpacing": "-0.01em",
                "bodyLetterSpacing": "normal"
            }
        },
        "layout": {
            "mode": "full",
            "showReadingProgress": false,
            "header": {
                "show": true,
                "logoUrl": "",
                "siteName": "",
                "navLinks": [],
                "sticky": false,
                "transparentOnTop": false,
                "mobileDrawerIncludeSidebar": false,
                "rows": [],
                "widgets": {
                    "left": [{"type": "site-name", "props": {}}],
                    "center": [],
                    "right": []
                }
            },
            "sidebar": {
                "show": false,
                "widgets": []
            },
            "footer": {
                "show": true,
                "text": "© Firebat. All rights reserved.",
                "columns": []
            },
            "pageList": {
                "variant": "list",
                "showFeaturedImage": true,
                "showExcerpt": true,
                "showReadingTime": false,
                "pagination": "numbered",
                "perPage": 10
            }
        }
    })
}

/// 두 JSON 객체 deep merge — overlay 가 base 위에 설정. array 는 overlay 우선 (replace 아님 X).
fn deep_merge(base: serde_json::Value, overlay: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match (base, overlay) {
        (Value::Object(mut base_obj), Value::Object(overlay_obj)) => {
            for (k, v) in overlay_obj {
                let merged = match base_obj.remove(&k) {
                    Some(base_val) => deep_merge(base_val, v),
                    None => v,
                };
                base_obj.insert(k, merged);
            }
            Value::Object(base_obj)
        }
        // overlay 가 object 가 아니면 그대로 (array / primitive 모두 overlay 우선)
        (_, overlay) if !matches!(overlay, Value::Null) => overlay,
        // overlay 가 null 이면 base 유지
        (base, _) => base,
    }
}

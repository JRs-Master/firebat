//! DynamicToolRegistry — sysmod_* / mcp_* 도구 자동 등록 + 60초 cache.
//!
//! Phase B-post audit E3 (2026-05-06) 설정 — 옛 TS `buildToolDefinitions` 의 동적 빌드 부분
//! Rust port. 정적 도구 (`tool_registry::register_core_tools`) 와 분리:
//! - **정적**: page / storage / schedule / media / conversation / entity / episodic 등 핸들러
//!   (부팅 시 1회 등록 — `register_core_tools`)
//! - **동적**: sysmod_* (`system/modules/<name>/config.json` 스캔) + mcp_* (외부 MCP 서버 list)
//!   (매 LLM 호출 시 refresh, 60초 cache)
//!
//! 패턴:
//! 1. AiManager.process_with_tools_opts 시작 시 `dynamic.refresh().await` 호출
//! 2. 60초 안이면 즉시 return (cache hit)
//! 3. 60초 지났으면 sysmod scan + mcp list → ToolManager 에 register/unregister
//! 4. 그 후 `build_tool_definitions()` (sync ToolManager.list()) 호출 — 정적 + 동적 통합
//!
//! Sysmod 활성/비활성 토글 — `ModuleManager.is_enabled(name)` 검사. 비활성 시 unregister.
//!
//! What a sysmod tool LOOKS like is not decided here: `ai::sysmod_surface::build_surface` derives
//! the name, description, thin params, selector judgment and grounding once for both transports.
//! This registry only owns registration and the lookup state the FC dispatch path reads.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

use crate::managers::ai::sysmod_surface::{build_surface, ActionForm};
use crate::managers::mcp::McpManager;
use crate::managers::module::ModuleManager;
use crate::managers::tool::{make_handler, ToolDefinition, ToolListFilter, ToolManager};
use crate::ports::InfraResult;
use crate::utils::grounding::GroundedParam;

/// Cache TTL — 옛 TS 60초 1:1.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// 동적 도구 source 식별자 — ToolManager.unregister 시 filter 용.
const SOURCE_SYSMOD: &str = "sysmod";
const SOURCE_MCP: &str = "mcp";

pub struct DynamicToolRegistry {
    tools: Arc<ToolManager>,
    module: Arc<ModuleManager>,
    mcp: Arc<McpManager>,
    /// 마지막 refresh 시각. None = 아직 refresh 안 함.
    last_refresh: Mutex<Option<Instant>>,
    /// Published tool name → the module it runs. The ONE place that mapping lives on this path.
    ///
    /// Every gate below needs a module, and each of them used to recover one by cutting the
    /// `sysmod_` prefix off the tool name and swapping underscores back to hyphens — correct only
    /// while no module name contains an underscore, and unanswerable the moment one executor
    /// serves every module. `module_for_call` reads this map instead; the day a unified executor
    /// arrives it reads `args.module` there and nothing else moves.
    tool_modules: RwLock<HashMap<String, String>>,
    /// L1 grounding 선언 — **module** → grounded params (모듈 config 의 `grounding`).
    /// refresh 마다 config 에서 재구성. FC 경로(ai.rs 도구 루프)가 dispatch 전 `grounding_for` 로 조회해
    /// `check_grounding` 강제 — MCP 경로(mcp_server `state.grounding`) 와 대칭, 같은 pure 헬퍼 공유 (#8-2).
    grounding: RwLock<HashMap<String, Vec<GroundedParam>>>,
    /// requiresApproval 선언 — **module** → 선언 값. FC 게이트가 dispatch 전 조회 (#1-9b).
    approval: RwLock<HashMap<String, serde_json::Value>>,
    /// uiOnly 선언 — same shape. Actions a model may not call at all (screen actions).
    ui_only: RwLock<HashMap<String, serde_json::Value>>,
    /// **Modules** whose input declares an `action` selector (multi-action modules). The
    /// discovery-first gate applies to THESE only — the judgment itself lives in
    /// `sysmod_surface::declares_action_selector`, where both transports read it.
    action_selectors: RwLock<std::collections::HashSet<String>>,
    /// Step-three form material — module name → declared property schemas + per-action param
    /// names. Held per module (not per tool) because the overlay that fills the tool's
    /// `parameters` runs per turn, keyed by what THIS conversation discovered.
    forms: RwLock<HashMap<String, ActionForm>>,
    /// Modules whose config has been read into the four declaration maps above.
    ///
    /// Without it, a map miss has two meanings that must never be confused: "this module declares
    /// no approval" and "this module's config was never read". The maps only answer the first, and
    /// every gate treats a miss as permission — so the second silently disarms them. This set is
    /// what tells them apart. See [[feedback_absence_is_not_consent]].
    known: RwLock<std::collections::HashSet<String>>,
}

impl DynamicToolRegistry {
    pub fn new(tools: Arc<ToolManager>, module: Arc<ModuleManager>, mcp: Arc<McpManager>) -> Self {
        Self {
            tools,
            module,
            mcp,
            last_refresh: Mutex::new(None),
            tool_modules: RwLock::new(HashMap::new()),
            grounding: RwLock::new(HashMap::new()),
            approval: RwLock::new(HashMap::new()),
            ui_only: RwLock::new(HashMap::new()),
            action_selectors: RwLock::new(std::collections::HashSet::new()),
            forms: RwLock::new(HashMap::new()),
            known: RwLock::new(std::collections::HashSet::new()),
        }
    }

    /// Guarantee this module's declarations are loaded before a gate reads them.
    ///
    /// `refresh` builds them for every module it scans, switched off ones included, so the usual
    /// answer is "already known" and this costs one read lock. The miss path is a module the last
    /// scan did not see — installed since, or named through the executor, which takes its module
    /// from `args` and so can reach one the tool list never carried. Reading the config now is a
    /// disk read on a path that runs at most once per module; treating the empty map as a clean
    /// bill of health would run an unapproved order.
    async fn ensure_known(&self, module: &str) {
        if self.known.read().await.contains(module) {
            return;
        }
        // Both scopes, because a user module reaches the gates the same way a system one does.
        let config = match self.module.get_module_config("system", module).await {
            Some(c) => Some(c),
            None => self.module.get_module_config("user", module).await,
        };
        // Recorded either way: a name with no config on disk is not a module, and re-reading the
        // filesystem for it on every call would be the same miss forever.
        self.known.write().await.insert(module.to_string());
        let Some(config) = config else { return };
        self.absorb_declarations(module, &config).await;
    }

    /// Fold one module's gate declarations into the maps. The parse comes from `build_surface`, the
    /// same reader registration uses, so the live path and the scanned path cannot disagree.
    async fn absorb_declarations(&self, module: &str, config: &serde_json::Value) {
        let surface = build_surface(module, config);
        if let Some(ra) = config.get("requiresApproval") {
            self.approval.write().await.insert(module.to_string(), ra.clone());
        }
        if let Some(uo) = config.get("uiOnly") {
            self.ui_only.write().await.insert(module.to_string(), uo.clone());
        }
        if !surface.grounding.is_empty() {
            self.grounding.write().await.insert(module.to_string(), surface.grounding);
        }
        if surface.has_action_selector {
            self.action_selectors.write().await.insert(module.to_string());
        }
        self.forms.write().await.insert(module.to_string(), surface.form);
    }

    /// The typed form for the actions this conversation has already discovered, or `None` while
    /// it has discovered nothing (the thin form stands, and the gate keeps its teeth).
    pub async fn typed_parameters_for(
        &self,
        module: &str,
        actions: &[String],
    ) -> Option<serde_json::Value> {
        self.ensure_known(module).await;
        let forms = self.forms.read().await;
        crate::managers::ai::sysmod_surface::parameters_for(forms.get(module)?, actions)
    }

    /// Which module a tool call runs, or `None` when the call is not a module call at all.
    ///
    /// The single resolution point for the FC path. Registration recorded the pairing; nothing
    /// downstream reconstructs it from spelling. `args` is unused while one tool means one
    /// module — it is the parameter a unified executor reads.
    pub async fn module_for_call(&self, tool: &str, args: &serde_json::Value) -> Option<String> {
        if tool == crate::managers::ai::sysmod_surface::MODULE_EXEC_TOOL {
            return args
                .get("module")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        self.tool_modules.read().await.get(tool).cloned()
    }

    /// Whether this module really has an action selector — the discovery gate's applicability
    /// test. A stray `action` arg on a selector-less module is not a multi-action call, however
    /// much it looks like one.
    pub async fn has_action_selector(&self, module: &str) -> bool {
        self.ensure_known(module).await;
        self.action_selectors.read().await.contains(module)
    }

    /// The actions this module declares, for a refusal that names the choice instead of just
    /// withholding it. Read from the form's own `action` enum — the same declaration the gate and
    /// the published schema use, so a renamed action can never be advertised here alone.
    pub async fn action_choices(&self, module: &str) -> Vec<String> {
        self.ensure_known(module).await;
        let forms = self.forms.read().await;
        let Some(form) = forms.get(module) else {
            return Vec::new();
        };
        form.props
            .get("action")
            .and_then(|a| a.get("enum"))
            .and_then(|e| e.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    /// FC 경로가 dispatch 전 조회 — 이 모듈에 선언된 grounded params (없으면 None).
    pub async fn grounding_for(&self, module: &str) -> Option<Vec<GroundedParam>> {
        self.ensure_known(module).await;
        let map = self.grounding.read().await;
        map.get(module).cloned()
    }

    /// FC 경로가 dispatch 전 조회 — 이 모듈의 requiresApproval 선언.
    pub async fn approval_for(&self, module: &str) -> Option<serde_json::Value> {
        self.ensure_known(module).await;
        let map = self.approval.read().await;
        map.get(module).cloned()
    }

    /// The `uiOnly` declaration for this module, if it has one — see `is_ui_only_value`.
    pub async fn ui_only_for(&self, module: &str) -> Option<serde_json::Value> {
        self.ensure_known(module).await;
        let map = self.ui_only.read().await;
        map.get(module).cloned()
    }

    /// 60초 cache 검사 후 sysmod_* / mcp_* 동적 도구 재등록. cache hit 시 즉시 return.
    pub async fn refresh(&self) {
        // cache 검사 — 60초 안이면 skip
        {
            let last = self.last_refresh.lock().await;
            if let Some(t) = *last {
                if t.elapsed() < CACHE_TTL {
                    return;
                }
            }
        }

        // 1. 옛 sysmod_* / mcp_* 도구 모두 unregister (refresh 마다 깨끗이)
        for def in self.tools.list(&ToolListFilter { source: Some(SOURCE_SYSMOD.to_string()), name_prefix: None }) {
            self.tools.unregister(&def.name);
            self.tools.unregister_handler(&def.name);
        }
        for def in self.tools.list(&ToolListFilter { source: Some(SOURCE_MCP.to_string()), name_prefix: None }) {
            self.tools.unregister(&def.name);
            self.tools.unregister_handler(&def.name);
        }
        // grounding 맵은 로컬에 쌓고 끝에 한 번에 swap — clear→개별 insert 사이 rebuild 창에
        // 동시 read 가 빈 맵(fail-open)을 보는 race 회피 + write lock 획득 N회→1회.
        let mut new_tool_modules: HashMap<String, String> = HashMap::new();
        let mut new_grounding: HashMap<String, Vec<GroundedParam>> = HashMap::new();
        let mut new_approval: HashMap<String, serde_json::Value> = HashMap::new();
        let mut new_ui_only: HashMap<String, serde_json::Value> = HashMap::new();
        let mut new_selectors: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut new_forms: HashMap<String, ActionForm> = HashMap::new();
        let mut new_known: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 2. sysmod scan + register
        let modules = self.module.list_system_modules().await;
        for entry in modules {
            // config.json 의 input schema 추출
            let Some(config) = self.module.get_module_config("system", &entry.name).await else {
                continue;
            };
            new_known.insert(entry.name.clone());
            // The whole derivation — tool name, description (+tags), thin params, selector
            // judgment, grounding — comes from the shared builder. The MCP transport reads the same
            // one, so a gate is planted once instead of twice (that duplication is what let the
            // selector gate, the key canon and the gate notice each drift).
            let surface = build_surface(&entry.name, &config);
            let tool_name = surface.tool_name;
            // The pairing, recorded once. Everything below keys by module.
            new_tool_modules.insert(tool_name.clone(), entry.name.clone());
            // Declarations are collected for EVERY scanned module, switched off ones included, and
            // only the registration below is skipped for those. The toggle used to skip both, which
            // meant a module enabled after the scan came back with empty gate maps — and an empty
            // approval map reads as "no approval needed". Being off is a reason not to publish a
            // tool; it was never a reason to forget the module declares an order action.
            if let Some(ra) = config.get("requiresApproval") {
                new_approval.insert(entry.name.clone(), ra.clone());
            }
            if let Some(uo) = config.get("uiOnly") {
                new_ui_only.insert(entry.name.clone(), uo.clone());
            }
            if !surface.grounding.is_empty() {
                new_grounding.insert(entry.name.clone(), surface.grounding);
            }
            if surface.has_action_selector {
                new_selectors.insert(entry.name.clone());
            }
            // Material for step three's form, kept by MODULE name (the tool list is rebuilt per
            // turn from what the conversation has discovered — see the overlay in ai.rs).
            new_forms.insert(entry.name.clone(), surface.form);
            // Vault `system:module:<name>:settings.enabled` (default true). Past this point is
            // publication and dispatch, which the toggle does govern.
            if !self.module.is_enabled(&entry.name) {
                continue;
            }
            self.tools.register(ToolDefinition {
                name: tool_name.clone(),
                description: surface.description,
                parameters: surface.thin_parameters,
                source: SOURCE_SYSMOD.to_string(),
            });
            // 핸들러 — ModuleManager.run() 위임. 옛 코드는 주석만 "run() 위임"이고 실제론
            // execute()(sandbox 직행)라 run() 의 config 경로 전부를 우회했다: enabled 게이트 ·
            // 입력 스키마 검증(A6) · WS 라우팅(키움 조건검색) · 시계열 스펙(1-3). 파이프라인
            // EXECUTE 우회(87df93dd)와 같은 클래스 — 2026-07-06 timeseries absorb 0 실측으로 발각.
            // MCP SysmodHandler 는 원래 run() 이라 이 정정으로 FC↔MCP 경로가 일치한다.
            let module_mgr = self.module.clone();
            let module_name = entry.name.clone();
            let handler = make_handler(move |args: serde_json::Value| {
                let mgr = module_mgr.clone();
                let name = module_name.clone();
                async move {
                    let result = mgr.run(&name, &args).await?;
                    Ok(serde_json::to_value(&result)
                        .unwrap_or(serde_json::Value::Null))
                }
            });
            self.tools.register_handler(&tool_name, handler);
        }

        // 3. mcp scan + register — 외부 MCP 서버 list → 각 서버별 list_tools 순회
        if let Ok(all_tools) = self.mcp.list_all_tools().await {
            for info in all_tools {
                let tool_name = format!("mcp_{}_{}", info.server, info.name);
                let parameters = info
                    .input_schema
                    .clone()
                    .unwrap_or_else(|| serde_json::json!({}));
                self.tools.register(ToolDefinition {
                    name: tool_name.clone(),
                    description: info.description.clone(),
                    parameters,
                    source: SOURCE_MCP.to_string(),
                });
                let mcp_mgr = self.mcp.clone();
                let server = info.server.clone();
                let inner_name = info.name.clone();
                let handler = make_handler(move |args: serde_json::Value| {
                    let mgr = mcp_mgr.clone();
                    let server = server.clone();
                    let name = inner_name.clone();
                    async move {
                        mgr.call_tool(&server, &name, &args).await
                    }
                });
                self.tools.register_handler(&tool_name, handler);
            }
        }

        // 4. grounding 맵 atomic swap (rebuild 완료 후 한 번에 교체 — read 가 부분 상태 안 봄).
        *self.tool_modules.write().await = new_tool_modules;
        *self.grounding.write().await = new_grounding;
        *self.approval.write().await = new_approval;
        *self.ui_only.write().await = new_ui_only;
        *self.action_selectors.write().await = new_selectors;
        *self.forms.write().await = new_forms;
        *self.known.write().await = new_known;

        // 5. cache 갱신
        let mut last = self.last_refresh.lock().await;
        *last = Some(Instant::now());
    }

    /// 강제 invalidation — sysmod 활성/비활성 토글 또는 외부 MCP 서버 추가/제거 시 호출.
    pub async fn invalidate(&self) {
        let mut last = self.last_refresh.lock().await;
        *last = None;
    }
}

/// `_unused` 경고 회피 — InfraResult import 만 설정된 상태이지만 향후 확장 시 사용.
#[allow(dead_code)]
fn _placeholder() -> InfraResult<()> {
    Ok(())
}

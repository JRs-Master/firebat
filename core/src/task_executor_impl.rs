//! RealTaskExecutor — TaskExecutor trait 의 실 구현체 (Phase B-17a).
//!
//! 옛 TS TaskManager 의 step 별 실행 로직 Rust port. TaskManager 의 stub 을 RealExecutor 로
//! 교체 → pipeline 7-step 모두 실 매니저 메서드 호출.
//!
//! Phase B-17 minimum:
//! - EXECUTE — ISandboxPort.execute (sysmod 실행)
//! - MCP_CALL — McpManager.call_tool
//! - LLM_TRANSFORM — LlmService.ask_text
//! - SAVE_PAGE — PageManager.save
//! - TOOL_CALL — ToolManager.dispatch
//! - NETWORK_REQUEST — delegates to the registered `network_request` core tool (SSRF-guarded)

use std::sync::Arc;

use crate::capabilities::{CapabilityProvider, ProviderLocation};
use crate::managers::llm_service::LlmService;
use crate::managers::capability::CapabilityManager;
use crate::managers::mcp::McpManager;
use crate::managers::page::PageManager;
use crate::managers::task::TaskExecutor;
use crate::managers::tool::ToolManager;
use crate::ports::{
    ILogPort, ISandboxPort, InfraResult, LlmCallOpts, SandboxExecuteOpts,
};

pub struct RealTaskExecutor {
    sandbox: Arc<dyn ISandboxPort>,
    mcp: Arc<McpManager>,
    llm: Arc<LlmService>,
    page: Arc<PageManager>,
    tools: Arc<ToolManager>,
    log: Arc<dyn ILogPort>,
    /// Capability fallback 활성 — execute_module 실패 시 같은 capability 의 다른 활성 provider 자동 시도.
    /// None 이면 fallback 비활성 (테스트 / 경량 wiring).
    capability: Option<Arc<CapabilityManager>>,
    /// 무인(파이프라인) 정책 게이트 — 비활성 모듈 + requiresApproval 액션 차단.
    /// EXECUTE 는 sandbox 직행이라 FC/MCP 디스패치 계층 게이트를 우회 — 같은 정책을 여기서 강제.
    /// None (테스트/경량 wiring) = 게이트 없음 (옛 동작).
    module: Option<Arc<crate::managers::module::ModuleManager>>,
    /// SAVE_PAGE dataCacheKey bake — 저장 시 sysmod 캐시 records 를 baked data 로 굳힘.
    /// None (테스트/경량 wiring) = bake skip.
    sysmod_cache: Option<Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>>,
}

impl RealTaskExecutor {
    pub fn new(
        sandbox: Arc<dyn ISandboxPort>,
        mcp: Arc<McpManager>,
        llm: Arc<LlmService>,
        page: Arc<PageManager>,
        tools: Arc<ToolManager>,
        log: Arc<dyn ILogPort>,
    ) -> Self {
        Self {
            sandbox,
            mcp,
            llm,
            page,
            tools,
            log,
            capability: None,
            module: None,
            sysmod_cache: None,
        }
    }

    /// Capability 설정된 채로 부팅 — execute_module 의 자동 fallback 활성.
    pub fn with_capability(mut self, capability: Arc<CapabilityManager>) -> Self {
        self.capability = Some(capability);
        self
    }

    /// ModuleManager 설정된 채로 부팅 — 무인 정책 게이트 활성.
    pub fn with_module_manager(
        mut self,
        module: Arc<crate::managers::module::ModuleManager>,
    ) -> Self {
        self.module = Some(module);
        self
    }

    /// SysmodCacheAdapter 설정된 채로 부팅 — SAVE_PAGE dataCacheKey bake 활성.
    pub fn with_sysmod_cache(
        mut self,
        cache: Arc<crate::utils::sysmod_cache::SysmodCacheAdapter>,
    ) -> Self {
        self.sysmod_cache = Some(cache);
        self
    }

    /// Unattended-run policy gate for module-path EXECUTE steps. Pipelines bypass the FC/MCP
    /// dispatch layer where the disabled-module and requiresApproval gates live — enforce the
    /// same policy here. `fallback_target=true` is stricter: a module that declares ANY
    /// approval-gated action (real-money orders — kiwoom/korea-invest/toss all share
    /// capability "stock-trading") is never a fallback target, because auto-retrying a failed
    /// order on ANOTHER broker is the exact "side effects run exactly once" violation.
    async fn unattended_module_gate(
        &self,
        path: &str,
        input: &serde_json::Value,
        fallback_target: bool,
    ) -> Result<(), String> {
        let Some(mm) = &self.module else { return Ok(()) };
        let Some(name) = extract_module_name(path) else { return Ok(()) };
        if !mm.is_enabled(name) {
            return Err(format!(
                "module '{name}' is disabled — pipeline EXECUTE is blocked too"
            ));
        }
        let scope = if path.starts_with("system/") { "system" } else { "user" };
        let Some(cfg) = mm.get_module_config(scope, name).await else {
            return Ok(());
        };
        let Some(decl) = cfg.get("requiresApproval") else {
            return Ok(());
        };
        if fallback_target {
            return Err(format!(
                "module '{name}' declares approval-gated actions — excluded from unattended fallback"
            ));
        }
        let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
        // 승인 액션 분기 — cron 컨텍스트(등록 시 스케줄 승인 카드 통과 = 잡에 담긴 매매까지 승인,
        // 사용자 확정 2026-07-07: "오늘 TQQQ 1주 매수" → 새벽 미국장에 예약 실행)는 허용.
        // 인터랙티브 run_task 는 승인 카드 없이 파이프라인으로 게이트를 우회하는 경로라 차단
        // (2026-07-07 토스 매수 실측 — 모델이 정확히 이 우회를 시도함). 한도(가격 상한·잔고 %)
        // 세팅은 core 몫 아님 — 전용 자동매매 sysmod 의 설정 영역.
        if crate::utils::pending_tools::requires_approval_value(decl, action)
            && !crate::utils::cron_context::is_cron_context_active()
        {
            return Err(format!(
                "approval-required action '{action}' of module '{name}' cannot run via interactive run_task (that would bypass the approval card) — call the module tool directly for an approval card, or register it as a schedule (approving the schedule approves the action)"
            ));
        }
        Ok(())
    }

    /// Map an LLM-facing sysmod tool name to its module. Accepts every dialect the models
    /// actually emit: `sysmod_toss-invest` (FC per-module), `sysmod_toss_invest` (underscore),
    /// `sysmod_toss_invest_order` / `sysmod_kiwoom_chart` (MCP domain-split view — the domain
    /// suffix is presentation only; the module reads `action` from args). Matching is done on
    /// underscore-normalized names so hyphen/underscore variants are one identity.
    async fn resolve_sysmod_module(&self, tool: &str) -> Option<String> {
        let mm = self.module.as_ref()?;
        let norm = tool.strip_prefix("sysmod_")?.replace('-', "_");
        let mut best: Option<String> = None;
        for m in mm.list_system_modules().await {
            let m_norm = m.name.replace('-', "_");
            if norm == m_norm || norm.starts_with(&format!("{m_norm}_")) {
                // Longest-prefix wins (e.g. a hypothetical module "kiwoom_gold" over "kiwoom").
                if best.as_ref().map(|b| m.name.len() > b.len()).unwrap_or(true) {
                    best = Some(m.name.clone());
                }
            }
        }
        best
    }

    /// requiresApproval gate for pipeline steps that address a sysmod TOOL (TOOL_CALL /
    /// internal MCP_CALL). Same policy as `unattended_module_gate`: cron context (schedule
    /// card approved = contained actions approved) passes; interactive run_task is denied.
    /// Enabled/validation gates live in `ModuleManager.run` (single choke) — approval is a
    /// dispatch-layer policy, so it must be enforced here.
    async fn sysmod_approval_gate(
        &self,
        module_name: &str,
        args: &serde_json::Value,
    ) -> Result<(), String> {
        let Some(mm) = &self.module else { return Ok(()) };
        let Some(cfg) = mm.get_module_config("system", module_name).await else {
            return Ok(());
        };
        let Some(decl) = cfg.get("requiresApproval") else {
            return Ok(());
        };
        let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
        if crate::utils::pending_tools::requires_approval_value(decl, action)
            && !crate::utils::cron_context::is_cron_context_active()
        {
            return Err(format!(
                "approval-required action '{action}' of module '{module_name}' cannot run via an interactive pipeline (that would bypass the approval card) — call the module tool directly for an approval card, or register it as a schedule (approving the schedule approves the action)"
            ));
        }
        Ok(())
    }

    /// Execute one of OUR OWN tools from a pipeline step. sysmod names (any dialect) resolve
    /// to the module and run through `ModuleManager.run` (enabled gate · input validation ·
    /// WS routing · timeseries — the single choke point); other names go through
    /// `ToolManager.dispatch` with canonical-name normalization.
    async fn run_internal_tool(
        &self,
        tool: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        if let Some(module_name) = self.resolve_sysmod_module(tool).await {
            self.sysmod_approval_gate(&module_name, args).await?;
            let mm = self
                .module
                .as_ref()
                .expect("resolve_sysmod_module returned Some without module manager");
            let result = mm.run(&module_name, args).await?;
            return Ok(serde_json::to_value(&result).unwrap_or(serde_json::Value::Null));
        }
        let name = self.tools.canonical_name(tool);
        self.tools.dispatch(&name, args).await
    }
}

/// Split a CLI-namespaced MCP tool name (`mcp__<server>__<tool>`) into (server, tool).
/// Models that see tools through a CLI naturally write that combined form; absorbing it here
/// means a pipeline step works whether the model filled `server` separately or not.
fn split_mcp_name(server: &str, tool: &str) -> (String, String) {
    if let Some(rest) = tool.strip_prefix("mcp__") {
        if let Some((srv, t)) = rest.split_once("__") {
            if !srv.is_empty() && !t.is_empty() {
                return (srv.to_string(), t.to_string());
            }
        }
    }
    (server.to_string(), tool.to_string())
}

/// 모듈 path 에서 module_name 추출. `<scope>/modules/<name>/<entry>` 형식 가정.
/// 일반 메커니즘 — scope 또는 entry 변경에도 작동 (segments 두 번째가 modules, 세 번째가 name).
fn extract_module_name(path: &str) -> Option<&str> {
    let segs: Vec<&str> = path.split('/').collect();
    let modules_idx = segs.iter().position(|s| *s == "modules")?;
    segs.get(modules_idx + 1).copied()
}

/// Provider → path 빌드. 옛 TS 패턴 — runtime 미명시 시 index.mjs (node) 가정.
/// 정확한 entry 는 config.json runtime 필드 — Phase B-17+ CapabilityProvider 에 entry 추가 시 정확.
fn provider_to_path(p: &CapabilityProvider) -> String {
    let scope = match p.location {
        ProviderLocation::System => "system",
        ProviderLocation::User => "user",
    };
    format!("{}/modules/{}/index.mjs", scope, p.module_name)
}

#[async_trait::async_trait]
impl TaskExecutor for RealTaskExecutor {
    async fn execute_module(
        &self,
        path: &str,
        input: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] EXECUTE → {} (Sandbox)", path));
        self.unattended_module_gate(path, input, false).await?;
        let result = self
            .sandbox
            .execute(path, input, &SandboxExecuteOpts::default())
            .await;

        // 성공 → 그대로 반환
        if let Ok(out) = &result {
            if out.success {
                return Ok(out.data.clone());
            }
        }

        // 실패 → capability fallback (옛 TS task-manager.ts:373 tryFallbackProvider 1:1 port).
        // CapabilityManager 미설정 시 fallback 비활성 → 첫 시도 실패 그대로 반환.
        if let Some(capability) = &self.capability {
            if let Some(failed_module) = extract_module_name(path) {
                let fallbacks = capability.fallback_modules(failed_module).await;
                for alt in fallbacks {
                    let alt_path = provider_to_path(&alt);
                    if let Err(reason) = self.unattended_module_gate(&alt_path, input, true).await {
                        self.log.warn(&format!(
                            "[Pipeline] fallback candidate excluded: {} — {}",
                            alt_path, reason
                        ));
                        continue;
                    }
                    self.log.info(&format!(
                        "[Pipeline] capability fallback attempt: {} → {} ({})",
                        path, alt_path, alt.module_name
                    ));
                    match self
                        .sandbox
                        .execute(&alt_path, input, &SandboxExecuteOpts::default())
                        .await
                    {
                        Ok(out) if out.success => {
                            self.log
                                .info(&format!("[Pipeline] capability fallback succeeded: {}", alt_path));
                            return Ok(out.data);
                        }
                        Ok(out) => {
                            self.log.warn(&format!(
                                "[Pipeline] fallback module failed: {} — {}",
                                alt_path,
                                out.error.unwrap_or_default()
                            ));
                        }
                        Err(e) => {
                            self.log.warn(&format!(
                                "[Pipeline] fallback exception: {} — {}",
                                alt_path, e
                            ));
                        }
                    }
                }
            }
        }

        // 모든 fallback 실패 (또는 capability 미설정) → 원본 에러 반환
        match result {
            Ok(out) => Err(out
                .error
                .unwrap_or_else(|| "sandbox execute failed".to_string())),
            Err(e) => Err(e),
        }
    }

    async fn call_mcp_tool(
        &self,
        server: &str,
        tool: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        let (server, tool) = split_mcp_name(server, tool);
        self.log
            .info(&format!("[Pipeline] MCP_CALL → {}/{}", server, tool));
        // "firebat" = ourselves. The outbound MCP client only knows EXTERNAL servers
        // (data/mcp-servers.json), so routing self-calls there failed instantly with
        // "MCP 서버 미등록: firebat" — models addressing our own tools as mcp__firebat__*
        // (the only name a CLI ever shows them) could never be served (2026-07-07 실측:
        // 승인된 TQQQ 예약 매수가 이 경로에서 조용히 죽음). Loop back to internal dispatch —
        // sysmod resolution + approval gate + ModuleManager.run choke point.
        if server == "firebat" {
            return self.run_internal_tool(&tool, args).await;
        }
        self.mcp.call_tool(&server, &tool, args).await
    }

    async fn network_request(
        &self,
        url: &str,
        method: &str,
        body: Option<&serde_json::Value>,
        headers: Option<&serde_json::Value>,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] NETWORK_REQUEST → {method} {url}"));
        // Delegate to the registered `network_request` core tool — same SSRF-guarded path as
        // the Function Calling tool (single source, no separate wiring). Pipeline step params
        // map 1:1 to the tool schema {url, method?, body?, headers?}.
        let mut args = serde_json::json!({ "url": url, "method": method });
        if let Some(b) = body {
            args["body"] = b.clone();
        }
        if let Some(h) = headers {
            args["headers"] = h.clone();
        }
        self.tools.dispatch("network_request", &args).await
    }

    async fn llm_transform(
        &self,
        instruction: &str,
        input_text: &str,
        model: Option<&str>,
    ) -> InfraResult<String> {
        self.log.info(&format!(
            "[Pipeline] LLM_TRANSFORM → LlmService.ask_text (model={})",
            model.unwrap_or("current")
        ));
        let prompt = format!(
            "{instruction}\n\n---\n{input_text}\n---\n\nRespond based only on the source between the delimiters. Do not invent information that is not in the source."
        );
        // Per-step model override (declarative chore delegation) — the adapter resolves
        // opts.model first (adapter.rs select_config), None = current main model.
        let opts = LlmCallOpts {
            model: model.map(str::to_string),
            ..Default::default()
        };
        self.llm.ask_text(&prompt, &opts).await
    }

    async fn save_page(
        &self,
        slug: &str,
        spec: &serde_json::Value,
        _allow_overwrite: bool,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] SAVE_PAGE → slug={}", slug));
        // module 블록 publish-bake — cron 파이프라인 재발행이 정기 페이지의 표준 경로.
        let mut spec = spec.clone();
        if let Some(modules) = &self.module {
            crate::utils::page_binding::bake_spec(
                &mut spec,
                modules,
                None,
                self.sysmod_cache.as_ref(),
            )
            .await;
        }
        let spec_str = serde_json::to_string(&spec).map_err(|e| {
            crate::i18n::t(
                "core.error.page.spec_serialize_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;
        self.page
            .save(slug, &spec_str, "published", None, None, None)?;
        Ok(serde_json::json!({"slug": slug, "renamed": false}))
    }

    async fn execute_tool(
        &self,
        tool: &str,
        input: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        // Absorb the CLI-namespaced dialect here too (mcp__firebat__X ≡ our own tool X).
        let (server, tool) = split_mcp_name("firebat", tool);
        if server != "firebat" {
            // TOOL_CALL addressed an EXTERNAL server's tool by its namespaced name.
            self.log
                .info(&format!("[Pipeline] TOOL_CALL → {}/{} (external MCP)", server, tool));
            return self.mcp.call_tool(&server, &tool, input).await;
        }
        self.log
            .info(&format!("[Pipeline] TOOL_CALL → {} (internal dispatch)", tool));
        // run_internal_tool = canonical-name normalize + sysmod approval gate — a raw
        // tools.dispatch here let an interactive run_task invoke an approval-gated order
        // tool with no card (the same bypass class the EXECUTE gate closed).
        self.run_internal_tool(&tool, input).await
    }
}

// Tests 이관 — `infra/tests/task_executor_impl_test.rs` (integration test).

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
        }
    }

    /// Capability 설정된 채로 부팅 — execute_module 의 자동 fallback 활성.
    pub fn with_capability(mut self, capability: Arc<CapabilityManager>) -> Self {
        self.capability = Some(capability);
        self
    }
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
                    self.log.info(&format!(
                        "[Pipeline] capability fallback 시도: {} → {} ({})",
                        path, alt_path, alt.module_name
                    ));
                    match self
                        .sandbox
                        .execute(&alt_path, input, &SandboxExecuteOpts::default())
                        .await
                    {
                        Ok(out) if out.success => {
                            self.log
                                .info(&format!("[Pipeline] capability fallback 성공: {}", alt_path));
                            return Ok(out.data);
                        }
                        Ok(out) => {
                            self.log.warn(&format!(
                                "[Pipeline] fallback 모듈 실패: {} — {}",
                                alt_path,
                                out.error.unwrap_or_default()
                            ));
                        }
                        Err(e) => {
                            self.log.warn(&format!(
                                "[Pipeline] fallback 예외: {} — {}",
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
                .unwrap_or_else(|| "sandbox execute 실패".to_string())),
            Err(e) => Err(e),
        }
    }

    async fn call_mcp_tool(
        &self,
        server: &str,
        tool: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] MCP_CALL → {}/{}", server, tool));
        self.mcp.call_tool(server, tool, args).await
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
    ) -> InfraResult<String> {
        self.log
            .info("[Pipeline] LLM_TRANSFORM → AiManager.ask_text");
        let prompt = format!(
            "{instruction}\n\n---\n{input_text}\n---\n\n위 구분선 안 원본을 근거로 응답하세요. 원본에 없는 정보 추측 금지."
        );
        self.llm.ask_text(&prompt, &LlmCallOpts::default()).await
    }

    async fn save_page(
        &self,
        slug: &str,
        spec: &serde_json::Value,
        _allow_overwrite: bool,
    ) -> InfraResult<serde_json::Value> {
        self.log
            .info(&format!("[Pipeline] SAVE_PAGE → slug={}", slug));
        let spec_str = serde_json::to_string(spec).map_err(|e| {
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
        self.log
            .info(&format!("[Pipeline] TOOL_CALL → {} (ToolManager.dispatch)", tool));
        self.tools.dispatch(tool, input).await
    }
}

// Tests 이관 — `infra/tests/task_executor_impl_test.rs` (integration test).

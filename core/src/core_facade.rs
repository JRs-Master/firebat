//! Core — the Mediator (Hexagonal + DDD + Mediator, 2026-06-26).
//!
//! Single coordination point for cross-orchestrator use-cases. The first target is the cron
//! trigger: today `ScheduleManager` holds `ai`/`task` (orchestrators) and `handle_trigger`
//! calls them directly = orchestrator→orchestrator coupling (#1a violation). The fix is to
//! move that coordination here — the cron callback invokes `Core::handle_cron_trigger`, which
//! coordinates the agent (Ai) / pipeline (Task) modes, so no orchestrator calls another
//! orchestrator directly.
//!
//! Core also becomes where request-level cross-cutting (Principal owner-scope, auth, logging)
//! applies in ONE place — unifying #1a (manager decoupling), #2 (Principal), and #4 (admin·hub).
//!
//! Build sequence:
//!   (1) scaffold — this struct holding the cron-path orchestrators. [current]
//!   (2) `handle_cron_trigger` — move the agent/pipeline coordination out of ScheduleManager.
//!   (3) wire the cron callback to Core; drop `ai`/`task` from `ScheduleHooks`.

use std::sync::Arc;

use crate::managers::ai::{AiManager, AiResponse};
use crate::managers::module::ModuleManager;
use crate::managers::page::PageManager;
use crate::managers::schedule::ScheduleManager;
use crate::managers::task::{PipelineResult, PipelineStep, TaskManager};
use crate::ports::{AiRequestOpts, InfraResult, LlmCallOpts};

/// The Mediator. Holds the orchestrators it coordinates; cross-cutting applies here.
/// Grows field-by-field as each use-case migrates (cron first).
pub struct Core {
    /// Chat orchestrator — used for cron `agent` mode (run an AI agent on schedule).
    pub ai: Arc<AiManager>,
    /// Pipeline orchestrator — used for cron `pipeline` mode.
    pub task: Arc<TaskManager>,
    /// Schedule domain — runWhen evaluation, retry, CRUD (handle_trigger coordination moves to Core).
    pub schedule: Arc<ScheduleManager>,
    /// Page + Module leaves — cron `rebake:<slug>` mode (page↔module binding re-bake, LLM 0).
    pub page: Arc<PageManager>,
    pub module: Arc<ModuleManager>,
}

impl Core {
    pub fn new(
        ai: Arc<AiManager>,
        task: Arc<TaskManager>,
        schedule: Arc<ScheduleManager>,
        page: Arc<PageManager>,
        module: Arc<ModuleManager>,
    ) -> Self {
        Self { ai, task, schedule, page, module }
    }

    /// Cron `agent` mode — mediates the cron→Ai cross-orchestrator call so ScheduleManager no
    /// longer holds AiManager directly. ScheduleManager keeps the request/result orchestration
    /// (prompt build, cron context, result mapping); Core just routes the agent run.
    pub async fn run_cron_agent(
        &self,
        prompt: &str,
        ai_opts: &AiRequestOpts,
    ) -> InfraResult<AiResponse> {
        self.ai
            .process_with_tools_opts(prompt, &[], &LlmCallOpts::default(), ai_opts)
            .await
    }

    /// Cron `pipeline` mode — mediates the cron→Task cross-orchestrator call.
    pub async fn run_cron_pipeline(&self, steps: &[PipelineStep]) -> PipelineResult {
        self.task.execute_pipeline(steps).await
    }

    /// Cron `rebake:<slug>` mode — re-run every `module` block binding of a saved page and
    /// save the refreshed spec back (LLM 0 periodic pages). The binding lives IN the stored
    /// spec, so the job only needs the slug. Gates (pageBinding opt-in / requiresApproval
    /// refusal / caps) are the page_binding helper's single source.
    pub async fn run_page_rebake(&self, slug: &str) -> InfraResult<serde_json::Value> {
        let record = self
            .page
            .get(slug)
            .ok_or_else(|| format!("page '{slug}' not found"))?;
        let mut spec: serde_json::Value = serde_json::from_str(&record.spec)
            .map_err(|e| format!("page '{slug}' spec is not valid JSON: {e}"))?;
        let report =
            crate::utils::page_binding::bake_spec(&mut spec, &self.module, record.project.as_deref())
                .await;
        if report.baked == 0 {
            // 바인딩이 없거나 전부 실패 — 재저장 없이 정직한 실패(빈 rebake 는 무의미).
            return Err(if report.errors.is_empty() {
                format!("page '{slug}' has no bakeable module blocks")
            } else {
                format!("rebake '{slug}' baked 0 blocks: {}", report.errors.join(" / "))
            });
        }
        let spec_str = serde_json::to_string(&spec).map_err(|e| e.to_string())?;
        self.page.save(
            slug,
            &spec_str,
            &record.status,
            record.project.as_deref(),
            record.visibility.as_deref(),
            record.password.as_deref(),
        )?;
        Ok(serde_json::json!({
            "slug": slug,
            "baked": report.baked,
            "errors": report.errors,
        }))
    }
}

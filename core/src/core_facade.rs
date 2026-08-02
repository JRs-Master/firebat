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

    /// Register (or withdraw) the schedules a module declares. Returns `(added, removed)`.
    ///
    /// A module that needs a timer ships the cron declaration in its own folder and names it in
    /// `config.json`. Enabling the module registers those jobs; disabling withdraws them. The
    /// alternative — which is what existed — was that the declarations sat in the repo unread and
    /// somebody retyped a twelve-step pipeline into the scheduler by hand.
    ///
    /// Registration is one-way idempotent. A file already registered once is skipped forever
    /// after, so a job the owner deleted deliberately does not come back on the next restart,
    /// while a schedule added in a later version of the module is still picked up. Turning the
    /// module off clears that record, so turning it back on starts clean.
    ///
    /// Core only routes here. Reading the files and understanding what they declare belongs to
    /// the module domain and happens in `ModuleManager`; putting the jobs on the clock belongs to
    /// `ScheduleManager`. This sits between them because it crosses both, and a module manager
    /// that reached into the scheduler would be the exact coupling the mediator exists to
    /// prevent — but crossing two managers is the only thing it does.
    pub async fn sync_module_schedules(&self, name: &str) -> (Vec<String>, Vec<String>) {
        let jobs = self.module.declared_schedule_jobs(name).await;
        if jobs.is_empty() {
            return (vec![], vec![]);
        }
        let job_id = |file: &str| format!("module:{}:{}", name, file.trim_end_matches(".json"));

        if !self.module.is_enabled(name) {
            let mut removed = vec![];
            for (file, _) in &jobs {
                if self.schedule.cancel(&job_id(file)).await.unwrap_or(false) {
                    removed.push(file.clone());
                }
            }
            if !removed.is_empty() {
                self.module.set_registered_schedules(name, &[]);
                tracing::info!(target: "module_schedule", module = %name,
                    removed = removed.len(), "module disabled — its schedules were withdrawn");
            }
            return (vec![], removed);
        }

        let mut already = self.module.registered_schedules(name);
        // The panel reads what a job is off its target's prefix — `builtin:`, `rebake:`, a path.
        // A module-declared job had none of those and fell through to "an ordinary pipeline
        // somebody made", which is exactly what it is not.
        let target = format!("module:{}", name);
        let live: std::collections::HashMap<String, String> = self
            .schedule
            .list()
            .into_iter()
            .map(|j| (j.job_id, j.target_path))
            .collect();
        let mut added = vec![];
        for (file, job) in jobs {
            let id = job_id(&file);
            // A job registered before the target convention existed is repaired rather than left
            // mislabelled. Re-registering under the same id is refused — the scheduler rejects a
            // duplicate rather than replacing it — so the old one is withdrawn first. Same id,
            // same trigger, corrected target.
            let stale = live.get(&id).is_some_and(|t| t != &target);
            if !stale && (already.contains(&file) || live.contains_key(&id)) {
                continue;
            }
            if stale {
                match self.schedule.cancel(&id).await {
                    Ok(_) => tracing::info!(target: "module_schedule", module = %name, job = %id,
                        "withdrawing a schedule registered under the old target"),
                    Err(e) => {
                        tracing::warn!(target: "module_schedule", module = %name, job = %id,
                            error = %e, "could not withdraw the stale schedule — leaving it");
                        continue;
                    }
                }
            }
            match self.schedule.schedule(&id, &target, job).await {
                Ok(()) => {
                    already.push(file.clone());
                    added.push(file);
                    tracing::info!(target: "module_schedule", module = %name, job = %id,
                        "registered a schedule the module declares");
                }
                Err(e) => tracing::warn!(target: "module_schedule", module = %name, job = %id,
                    error = %e, "declared schedule was refused by the scheduler"),
            }
        }
        if !added.is_empty() {
            self.module.set_registered_schedules(name, &already);
        }
        (added, vec![])
    }

    /// Every module's declared schedules, reconciled at boot.
    pub async fn sync_all_module_schedules(&self) {
        let mut names: Vec<String> = self
            .module
            .list_system()
            .await
            .into_iter()
            .map(|e| e.name)
            .collect();
        names.extend(self.module.list_user_modules().await.into_iter().map(|e| e.name));
        let (mut added, mut removed) = (0usize, 0usize);
        for name in names {
            let (a, r) = self.sync_module_schedules(&name).await;
            added += a.len();
            removed += r.len();
        }
        if added > 0 || removed > 0 {
            tracing::info!(target: "module_schedule", added, removed,
                "module-declared schedules reconciled");
        }
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
        // cache = None — rebake 는 등록 수 시간 뒤라 30분 sysmod 캐시는 이미 죽어 있음
        // (dataCacheKey 는 저장 시점 1회 스냅샷 전용, 갱신은 module 블록 몫).
        let report = crate::utils::page_binding::bake_spec(
            &mut spec,
            &self.module,
            record.project.as_deref(),
            None,
        )
        .await;
        // 페이지가 스스로 누적해 갖는 상태(데모 체결 기록 등). 방문이 아니라 이 잡이 쓴다 —
        // 익명 GET 이 DB 쓰기를 유발하지 않게 한 성질을 그대로 둔 채, 안 보고 있어도 쌓이게.
        let acc = crate::utils::page_binding::accumulate_spec(
            &mut spec,
            &self.module,
            record.project.as_deref(),
            None,
        )
        .await;
        if report.baked == 0 && acc.blocks == 0 {
            // 바인딩이 없거나 전부 실패 — 재저장 없이 정직한 실패(빈 rebake 는 무의미).
            let mut why = report.errors.clone();
            why.extend(acc.errors.clone());
            return Err(if why.is_empty() {
                format!("page '{slug}' has nothing to rebake or accumulate")
            } else {
                format!("rebake '{slug}' produced nothing: {}", why.join(" / "))
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

#[cfg(test)]
mod module_schedule_tests {
    use crate::ports::CronScheduleOptions;

    /// The declaration a module ships has to be the thing the scheduler takes, with no step in
    /// between reshaping it — otherwise "it is in the repo" and "it runs" are different claims.
    fn parse(raw: &str) -> CronScheduleOptions {
        serde_json::from_str(raw).expect("declared schedule must deserialise as it ships")
    }

    #[test]
    fn the_crypto_declaration_is_a_schedule() {
        let job = parse(include_str!("../../system/modules/autotrade/cron-upbit.json"));
        assert!(job.cron_time.is_some(), "a schedule needs a trigger");
        assert_eq!(job.execution_mode.as_deref(), Some("pipeline"));
        let steps = job.pipeline.expect("pipeline mode carries its steps");
        // The gate first, so a switched-off day ends before any broker call.
        assert!(steps.len() > 5, "got {} steps", steps.len());
    }

    #[test]
    fn the_stock_declaration_is_a_schedule() {
        let job = parse(include_str!("../../system/modules/autotrade/cron-kiwoom.json"));
        assert!(job.cron_time.is_some());
        assert!(job.pipeline.is_some());
    }

    #[test]
    fn the_revision_declaration_is_a_schedule() {
        let job = parse(include_str!("../../system/modules/autotrade/cron-revise.json"));
        assert!(job.cron_time.is_some());
        assert!(job.pipeline.is_some());
    }

    /// Every file the module names must exist and parse. A declaration pointing at a missing or
    /// unreadable file registers nothing, and the only symptom is an empty schedule list.
    #[test]
    fn every_declared_file_is_shipped_and_readable() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../system/modules/autotrade/config.json"))
                .expect("config.json parses");
        let declared: Vec<String> = config["schedules"]
            .as_array()
            .expect("the module declares its schedules")
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(!declared.is_empty());
        for file in &declared {
            // The reader's whitelist: `<alphanumeric-dash-underscore>.json`, nothing else.
            let stem = file.strip_suffix(".json").expect("declared as .json");
            assert!(
                !stem.is_empty()
                    && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
                "'{}' cannot be read by read_module_file, so it would silently register nothing",
                file
            );
        }
    }
}


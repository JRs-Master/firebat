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
        let live: std::collections::HashMap<String, crate::ports::CronJobInfo> = self
            .schedule
            .list()
            .into_iter()
            .map(|j| (j.job_id.clone(), j))
            .collect();
        let mut added = vec![];
        for (file, job) in jobs {
            let id = job_id(&file);
            // A job registered before the target convention existed is repaired rather than left
            // mislabelled. Re-registering under the same id is refused — the scheduler rejects a
            // duplicate rather than replacing it — so the old one is withdrawn first. Same id,
            // same trigger, corrected target.
            //
            // The same repair covers a declaration that has since changed. Idempotence is there so
            // a job the owner deleted stays deleted; a job still on the clock is not that case, and
            // leaving it on a superseded pipeline meant editing the declaration did nothing until
            // somebody knew to toggle the module off and on (2026-08-03: six schedules kept calling
            // a broker by its pre-split name for an hour after the fix shipped).
            let current = live.get(&id);
            let stale = current.is_some_and(|j| {
                j.target_path != target || !declaration_is_live(&job, &j.options)
            });
            if !stale && (already.contains(&file) || current.is_some()) {
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
                    // A re-registration is already in the record — pushing again would grow the
                    // list by one every time a declaration changes.
                    if !already.contains(&file) {
                        already.push(file.clone());
                    }
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

    /// Every module's declared schedules, reconciled at boot. Because a changed declaration now
    /// re-registers, this is also what carries a module update onto the clock — a `git pull` plus
    /// a restart is enough, where before it took knowing which switch to toggle.
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

/// Is what the module declares still what is on the clock?
///
/// Only the keys the declaration actually sets are compared. The registered copy also carries
/// fields the scheduler owns — owner, the system flag, whatever a later version adds — and
/// counting those as a difference would re-register every job on every boot.
fn declaration_is_live(
    declared: &crate::ports::CronScheduleOptions,
    registered: &crate::ports::CronScheduleOptions,
) -> bool {
    let (Ok(want), Ok(have)) =
        (serde_json::to_value(declared), serde_json::to_value(registered))
    else {
        // Cannot tell. Leave the registration alone: churning a working schedule is worse than
        // missing an edit, and the edit is visible the moment anyone looks at the panel.
        return true;
    };
    let Some(want) = want.as_object() else {
        return true;
    };
    want.iter().all(|(key, value)| have.get(key) == Some(value))
}

#[cfg(test)]
mod module_schedule_tests {
    use super::declaration_is_live;
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

    /// Four of them: one per broker and market, because the pipeline behind each calls exactly
    /// one broker's tool and one market's endpoints. `include_str!` is deliberate — a file
    /// deleted or renamed fails the build here rather than registering nothing at runtime.
    #[test]
    fn the_stock_declarations_are_schedules() {
        for raw in [
            include_str!("../../system/modules/autotrade/cron-kiwoom-kr.json"),
            include_str!("../../system/modules/autotrade/cron-kiwoom-us.json"),
            include_str!("../../system/modules/autotrade/cron-kis-kr.json"),
            include_str!("../../system/modules/autotrade/cron-kis-us.json"),
        ] {
            let job = parse(raw);
            assert!(job.cron_time.is_some());
            let steps = job.pipeline.expect("pipeline mode carries its steps");
            assert!(steps.len() > 5, "got {} steps", steps.len());
        }
    }

    /// Every declared schedule, so the reference check below covers all of them. A file deleted or
    /// renamed fails the build here rather than registering nothing at runtime.
    const DECLARED: &[(&str, &str)] = &[
        ("cron-upbit", include_str!("../../system/modules/autotrade/cron-upbit.json")),
        ("cron-upbit-context",
         include_str!("../../system/modules/autotrade/cron-upbit-context.json")),
        ("cron-revise", include_str!("../../system/modules/autotrade/cron-revise.json")),
        ("cron-kiwoom-kr", include_str!("../../system/modules/autotrade/cron-kiwoom-kr.json")),
        ("cron-kiwoom-us", include_str!("../../system/modules/autotrade/cron-kiwoom-us.json")),
        ("cron-kis-kr", include_str!("../../system/modules/autotrade/cron-kis-kr.json")),
        ("cron-kis-us", include_str!("../../system/modules/autotrade/cron-kis-us.json")),
        ("cron-kiwoom-universe",
         include_str!("../../system/modules/autotrade/cron-kiwoom-universe.json")),
        ("cron-kiwoom-screen",
         include_str!("../../system/modules/autotrade/cron-kiwoom-screen.json")),
    ];

    /// A `$stepN` may only name a step that has already run.
    ///
    /// Nothing enforces this at runtime: an out-of-range index resolves to null and the step fails
    /// on the missing path, which reads as a broken tool rather than a broken declaration. A
    /// scalping pipeline shipped with every reference off by one — `fetched: "$step3.results"`
    /// where step 3 was the reader itself — and it never once got past its second step. The
    /// numbers are written by hand and renumber themselves whenever a step is inserted, so the
    /// only thing that catches this is counting.
    #[test]
    fn a_step_reference_points_backwards_at_a_step_that_exists() {
        fn scan(value: &serde_json::Value, limit: usize, job: &str, out: &mut Vec<String>) {
            match value {
                serde_json::Value::String(s) => {
                    let mut rest = s.as_str();
                    while let Some(at) = rest.find("$step") {
                        rest = &rest[at + 5..];
                        let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
                        if let Ok(idx) = rest[..end].parse::<usize>() {
                            if idx >= limit {
                                out.push(format!(
                                    "{job}: step {limit} reads $step{idx} — \
                                     itself or a step that has not run yet ({s})"
                                ));
                            }
                        }
                        rest = &rest[end..];
                    }
                }
                serde_json::Value::Array(a) => a.iter().for_each(|v| scan(v, limit, job, out)),
                serde_json::Value::Object(o) => {
                    o.values().for_each(|v| scan(v, limit, job, out))
                }
                _ => {}
            }
        }

        let mut bad = Vec::new();
        for (name, raw) in DECLARED {
            let job = parse(raw);
            let Some(steps) = job.pipeline else { continue };
            for (i, step) in steps.iter().enumerate() {
                let as_json = serde_json::to_value(step).expect("a step serialises");
                // `i` is the limit: a FOREACH body still addresses the OUTER steps, so a reference
                // to the loop's own index is a self-reference wherever it is written.
                scan(&as_json, i, name, &mut bad);
            }
        }
        assert!(bad.is_empty(), "{}", bad.join("\n"));
    }

    /// Idempotence keeps a deliberately deleted job deleted; it must not also keep a *changed*
    /// declaration off the clock. Editing a pipeline and seeing the old one keep firing is the
    /// failure this guards — it cost an hour of coin cycles calling a broker by its former name.
    #[test]
    fn an_edited_declaration_counts_as_stale() {
        let declared = parse(include_str!("../../system/modules/autotrade/cron-upbit.json"));

        let unchanged = declared.clone();
        assert!(declaration_is_live(&declared, &unchanged));

        // What the scheduler adds on its own is not a difference.
        let mut annotated = declared.clone();
        annotated.owner = Some("admin".to_string());
        annotated.system = Some(false);
        assert!(
            declaration_is_live(&declared, &annotated),
            "fields the scheduler owns must not force a re-registration"
        );

        // A changed step is.
        let mut edited = declared.clone();
        edited.pipeline.as_mut().expect("pipeline mode carries its steps").truncate(1);
        assert!(!declaration_is_live(&declared, &edited));

        // So is a changed trigger.
        let mut retimed = declared.clone();
        retimed.cron_time = Some("0 0 * * * *".to_string());
        assert!(!declaration_is_live(&declared, &retimed));
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

#[cfg(test)]
mod module_contract_tests {
    //! A module's schema is checked before its code runs, so an action or an input the module
    //! handles but does not declare is refused at the door — and the refusal reads as a caller
    //! mistake ("not one of […], do not guess") rather than as a missing declaration. Measured
    //! 2026-08-02: a live pipeline died on this four times in a row, in two different modules,
    //! each time one step further along.
    //!
    //! The broker contract is the part worth pinning here. It is the same five calls on every
    //! broker by design — that is what lets the caller stay ignorant of the dialect — so a broker
    //! that implements them and forgets to declare them breaks the promise silently.
    use std::path::Path;

    const NEUTRAL: [&str; 6] = [
        "place_order", "cancel_order", "list_open_orders", "list_fills", "get_balance",
        "get_candles",
    ];

    #[test]
    fn a_broker_declares_the_neutral_calls_it_implements() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("system/modules");
        let Ok(entries) = std::fs::read_dir(&root) else {
            return; // not a checkout with modules beside it
        };
        let mut problems: Vec<String> = vec![];
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(config_raw) = std::fs::read_to_string(dir.join("config.json")) else {
                continue;
            };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&config_raw) else {
                continue;
            };
            let Some(declared) = config["input"]["properties"]["action"]["enum"].as_array() else {
                continue;
            };
            let declared: Vec<&str> = declared.iter().filter_map(|v| v.as_str()).collect();
            // The entry point may be a wrapper over a dialect shared with the module's public
            // half — reading only the directory would make this check pass on twenty lines that
            // implement nothing, which is worse than not having it.
            let mut code = ["index.mjs", "main.py"]
                .iter()
                .find_map(|f| std::fs::read_to_string(dir.join(f)).ok())
                .unwrap_or_default();
            if let Some(lib) = code
                .split("'../_runtime/")
                .nth(1)
                .and_then(|rest| rest.split(0x27 as char).next())
            {
                if let Ok(shared) = std::fs::read_to_string(root.join("_runtime").join(lib)) {
                    code.push_str(&shared);
                }
            }
            // A broker that has been split declares the contract across the pair: the money half
            // holds the orders and the account, the public half holds the candles.
            let mut declared = declared;
            // The pair declares the contract between them: orders and the account on this half,
            // candles on the public one.
            let self_name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            let quotes = dir.with_file_name(self_name.trim_end_matches("-trade").to_string());
            let quotes_raw = std::fs::read_to_string(quotes.join("config.json")).unwrap_or_default();
            let quotes_cfg: serde_json::Value =
                serde_json::from_str(&quotes_raw).unwrap_or(serde_json::Value::Null);
            let quotes_actions: Vec<String> = quotes_cfg["input"]["properties"]["action"]["enum"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect();
            declared.extend(quotes_actions.iter().map(String::as_str));
            let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            // A split broker is `<name>` (quotes) and `<name>-trade` (orders). The public half
            // shares the dialect and declares none of the money calls, so there "implemented but
            // not declared" is the guarantee rather than a defect — the opposite assertion is
            // made about it by `a_hub_safe_module_cannot_reach_an_account`. Recognised by its
            // sibling existing, not by its name reading a particular way.
            if root.join(format!("{name}-trade")).join("config.json").exists() {
                continue;
            }
            let mentions = |a: &str| {
                code.contains(&format!("'{a}'")) || code.contains(&format!("\"{a}\""))
            };
            // A module that names one of these is not necessarily a broker — the strategy module
            // builds a `place_order` call without implementing one, and counting mentions cannot
            // tell the two apart (it grew past any threshold as the caller got better).
            //
            // What separates them is standing, not vocabulary: a broker is the thing that holds
            // accounts, or one that already answers part of the contract. The caller holds
            // neither, by design — the account belongs to the broker module.
            let is_broker = config.get("accounts").is_some()
                || NEUTRAL.iter().any(|a| declared.contains(a));
            if !is_broker {
                continue;
            }
            for action in NEUTRAL {
                // Implemented if the code compares against the name; declared if the schema lists
                // it. Anything implemented and undeclared is unreachable.
                if mentions(action) && !declared.contains(&action) {
                    problems.push(format!("{name}: {action}"));
                }
            }
        }
        assert!(
            problems.is_empty(),
            "these broker calls are implemented but not declared, so validation refuses them              before the module runs: {problems:?}"
        );
    }

    /// Declaring `place_order` is not enough — the words the caller uses have to get through too.
    ///
    /// Measured 2026-08-04: a live signal fired at 03:00 and the order never went out.
    /// `"buy" is not one of ["bid","ask"]`. Upbit's own vocabulary is bid/ask, the neutral contract
    /// says buy/sell, and the dialect held the translation — but **validation runs before the
    /// module**, so the schema refused the call before anything could translate it. Declaration and
    /// runtime were demanding opposite words, which made the neutral order path unreachable on that
    /// broker while every test stayed green: the action was declared, so the check above passed.
    ///
    /// The contract is only neutral if a caller who knows one vocabulary never has to learn the
    /// venue's. So a venue may add its own words, and must not subtract the contract's.
    #[test]
    fn a_broker_accepts_the_neutral_words_for_an_order() {
        const REQUIRED: [(&str, [&str; 2]); 2] =
            [("side", ["buy", "sell"]), ("orderType", ["limit", "market"])];

        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("system/modules");
        let Ok(entries) = std::fs::read_dir(&root) else { return };
        let mut problems: Vec<String> = vec![];
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else { continue };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            let places_orders = config["input"]["properties"]["action"]["enum"]
                .as_array()
                .map(|a| a.iter().any(|v| v.as_str() == Some("place_order")))
                .unwrap_or(false);
            if !places_orders {
                continue;
            }
            let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            for (param, words) in REQUIRED {
                // No enum at all is fine: an open string cannot refuse anything. Only a closed
                // vocabulary can lock the caller out.
                let Some(enumerated) = config["input"]["properties"][param]["enum"].as_array()
                else {
                    continue;
                };
                let allowed: Vec<&str> = enumerated.iter().filter_map(|v| v.as_str()).collect();
                for word in words {
                    if !allowed.contains(&word) {
                        problems.push(format!("{name}.{param} refuses '{word}' (allows {allowed:?})"));
                    }
                }
            }
        }
        assert!(
            problems.is_empty(),
            "validation runs before the module, so a closed vocabulary that omits the neutral word \
             makes the order unreachable no matter what the dialect can translate: {problems:?}"
        );
    }

    /// A module a hub visitor may be allowed must not be able to touch the account.
    ///
    /// The hub allowlist is per module, and a broker tool deliberately hides its parameters to
    /// force discovery — so it accepts any action string, and allowing a broker for its charts
    /// allowed it for `get_balance`. Blocking those by name does not work: the one list that
    /// exists is `requiresApproval`, and account *reads* are deliberately not on it because the
    /// trading cron calls them every cycle. Adding a second list of forbidden names would be one
    /// more list to keep correct.
    ///
    /// So the boundary is the module. A module marked `hubSafe` must declare no credential and
    /// no action that reads or moves money. Marked unsafe, it must never appear in a hub
    /// allowlist — which is a setting, checked at runtime, not here.
    #[test]
    fn a_hub_safe_module_cannot_reach_an_account() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("system/modules");
        let Ok(entries) = std::fs::read_dir(&root) else {
            return; // not a checkout with modules beside it
        };
        // A backstop, not the boundary — the boundary is the split enum and the absent
        // credential. These are the words the venues themselves use for endpoints that read or
        // move money, so a new action naming one lands on the wrong side loudly.
        // 2026-08-03: the first list was written from the order/deposit vocabulary and missed the
        // way a venue words *reading* a position — `holdings`, `buying-power`, `sellable-quantity`
        // named no account and no order, so three of them sat on a hub-exposed module while this
        // test stayed green. The list has to cover reading a balance, not only moving money.
        const MONEY: [&str; 25] = [
            "order", "account", "balance", "deposit", "withdraw", "transfer", "wallet",
            "api_key", "api-key", "holding", "buying", "sellable", "position", "asset", "cash",
            "commission", "주문", "계좌", "잔고", "환전", "이체", "보유", "예수금", "매수가능",
            "매도가능",
        ];
        // An order book is the public queue of bids and offers, not an order — every venue calls
        // it that, and matching it on "order" would make the check cry wolf on the most ordinary
        // public endpoint there is. Correcting the vocabulary rather than granting exemptions:
        // an exemption list is the thing this test exists to avoid needing.
        const PUBLIC_WORDS: [&str; 3] = ["orderbook", "order-book", "호가"];
        // The domains the venues themselves use for the account side of their own catalogues.
        const MONEY_DOMAINS: [&str; 13] = [
            "계좌", "자산", "잔고", "주문", "주문조회", "주문정보", "조건주문", "조건주문조회",
            "신용주문", "환전", "이체", "입출금", "예수금",
        ];
        // A module's action catalog, or an empty list when it has none.
        fn catalog_of(dir: &Path) -> Vec<serde_json::Value> {
            let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else {
                return vec![];
            };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) else {
                return vec![];
            };
            let entries = match &config["actionCatalog"] {
                v if v["file"].is_string() => std::fs::read_to_string(dir.join(v["file"].as_str().unwrap_or_default()))
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
                serde_json::Value::Array(a) => Some(serde_json::Value::Array(a.clone())),
                _ => None,
            };
            entries
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
        }
        let mut problems: Vec<String> = vec![];
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else {
                continue;
            };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            if config.get("hubSafe").and_then(|v| v.as_bool()) != Some(true) {
                continue;
            }
            let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            // Declaring no credential is a second layer where the venue allows it — Upbit serves
            // its market data unauthenticated, so `upbit-quotes` holds no key at all and could
            // not reach an account even if an action existed. Kiwoom and Korea Investment require
            // a token for quotes too, so their public halves must hold one; there the boundary is
            // the action list alone. Requiring the stronger property would mean those two have no
            // chartable module, which is the reason a hub was allowed a broker in the first place.
            //
            // The account registry lives on the trading half; a public half that needs a token
            // borrows the whole list through `credentialScope`. Holding a token that happens to be
            // issued for an account is not being able to trade in it — that is the action list,
            // checked below.
            for action in config["input"]["properties"]["action"]["enum"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| v.as_str())
            {
                let mut lower = action.to_lowercase();
                for w in PUBLIC_WORDS {
                    lower = lower.replace(w, "");
                }
                if let Some(hit) = MONEY.iter().find(|m| lower.contains(*m)) {
                    problems.push(format!("{name}: hubSafe but declares '{action}' ({hit})"));
                }
            }
            // The stronger check, where the venue supplies one. Action ids are arbitrary strings
            // and reading them is guesswork — which is how `holdings`, `buying-power` and
            // `sellable-quantity` got through: none of them names an account or an order, and all
            // three were already labelled 자산 / 주문정보 in the sheet sitting next to them. A
            // domain is a small vendor-authored set and a new action inherits it, so this catches
            // the next one without anybody widening a word list.
            for entry in catalog_of(&dir).iter() {
                let Some(domain) = entry["domain"].as_str() else {
                    continue;
                };
                // Any segment, not just the last: the venues write compound domains
                // ("[국내선물옵션] 주문/계좌", "OAuth 인증/접근토큰발급") and which end is
                // meaningful varies. Reading only one side makes the check depend on formatting.
                if let Some(hit) = domain
                    .split(['/', ']'])
                    .map(str::trim)
                    .find(|seg| MONEY_DOMAINS.contains(seg))
                {
                    let id = entry["id"].as_str().unwrap_or("?");
                    problems.push(format!(
                        "{name}: hubSafe but its catalog files '{id}' under the venue's own '{hit}' domain"
                    ));
                }
            }
        }
        assert!(
            problems.is_empty(),
            "these modules may be exposed to a hub visitor and can reach an account: {problems:?}"
        );
    }

    /// The action catalog is how the model finds an action, so it decides which module gets
    /// called. An entry filed under a module that cannot run it is worse than a missing entry:
    /// the model is told exactly where to go and the call is refused there.
    ///
    /// 2026-08-03: the broker split divided the action enums and left one `actions.json` behind on
    /// the trading half, so every chart action was indexed under the module that holds orders.
    /// `search_module_actions` answered "the daily chart is in kiwoom-trade", the model obeyed, and the
    /// hub boundary refused it — a routing failure that reads exactly like a permissions bug.
    #[test]
    fn an_action_catalog_lists_only_actions_its_module_can_run() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("system/modules");
        let Ok(entries) = std::fs::read_dir(&root) else {
            return; // not a checkout with modules beside it
        };
        let mut problems: Vec<String> = vec![];
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else {
                continue;
            };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(file) = config["actionCatalog"]["file"].as_str() else {
                continue; // inline or absent — nothing to locate
            };
            let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            let Ok(catalog_raw) = std::fs::read_to_string(dir.join(file)) else {
                // Declared and missing: the loader falls back to enum-derived stubs, so the module
                // still answers — with none of the names and parameters the catalog carries.
                problems.push(format!("{name}: declares actionCatalog '{file}' but it is not there"));
                continue;
            };
            let Ok(catalog) = serde_json::from_str::<serde_json::Value>(&catalog_raw) else {
                problems.push(format!("{name}/{file}: does not parse"));
                continue;
            };
            let enumerated: Vec<&str> = config["input"]["properties"]["action"]["enum"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            let ids: Vec<&str> = catalog
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|e| e["id"].as_str())
                .collect();
            let strays: Vec<&&str> =
                ids.iter().filter(|id| !enumerated.contains(id)).take(4).collect();
            if !strays.is_empty() {
                problems.push(format!(
                    "{name}/{file}: lists {} action(s) the module cannot run, e.g. {strays:?}",
                    ids.iter().filter(|id| !enumerated.contains(id)).count()
                ));
            }
            // A catalog covering none of its own actions is the same failure seen from the other
            // side — the half that was left without its share of the sheet.
            if !ids.is_empty() && !ids.iter().any(|id| enumerated.contains(id)) {
                problems.push(format!("{name}/{file}: covers none of the module's own actions"));
            }
        }
        assert!(problems.is_empty(), "action catalogs that misroute: {problems:?}");
    }

    /// A websocket stream is pure declaration — nothing in it is checked until someone starts a
    /// watch, and the failure then is a string at runtime on a socket nobody is watching. These
    /// are the four ways a stream declaration is dead on arrival.
    #[test]
    fn a_declared_ws_stream_is_startable() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("system/modules");
        let Ok(entries) = std::fs::read_dir(&root) else {
            return; // not a checkout with modules beside it
        };
        let mut problems: Vec<String> = vec![];
        for entry in entries.flatten() {
            let dir = entry.path();
            let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else {
                continue;
            };
            let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let ws = &config["ws"];
            let Some(streams) = ws["streams"].as_object() else {
                continue;
            };
            let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            let login = &ws["login"];
            if !login.is_null() {
                let has_frame = !login["frame"].is_null();
                let has_headers = login["headers"].as_object().is_some_and(|h| !h.is_empty());
                // One or the other has to carry the credential. Neither means the socket opens
                // anonymously and the venue closes it.
                if !has_frame && !has_headers {
                    problems.push(format!("{name}: login declares neither a frame nor headers"));
                }
                // A signature nothing sends is arithmetic thrown away.
                if !login["jwt"].is_null() && !has_headers {
                    problems.push(format!("{name}: jwt signed but no header carries it"));
                }
            }
            for (stream, decl) in streams {
                if decl["subscribe"]["frame"].is_null() {
                    problems.push(format!("{name}.{stream}: subscribe.frame missing"));
                }
                // Without it every frame on the socket is unrecognised and silently dropped.
                if decl["realtimeMatch"].as_str().unwrap_or_default().is_empty() {
                    problems.push(format!("{name}.{stream}: realtimeMatch missing"));
                }
            }
            // A websocket-served action is reached through the module's own action enum. Declared
            // in one module and enumerated in another it is simply unreachable, which is what the
            // broker split did to Kiwoom's two screening actions — the declaration went to the
            // trading half and the enum entries stayed on the public one.
            let enumerated: Vec<&str> = config["input"]["properties"]["action"]["enum"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            for key in ["actions", "unsupportedActions"] {
                let declared: Vec<String> = match &ws[key] {
                    serde_json::Value::Object(m) => m.keys().cloned().collect(),
                    serde_json::Value::Array(a) => {
                        a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
                    }
                    _ => vec![],
                };
                for action in declared {
                    if !enumerated.contains(&action.as_str()) {
                        problems.push(format!("{name}: ws.{key} declares '{action}' but the module's action enum does not"));
                    }
                }
            }
        }
        assert!(problems.is_empty(), "ws stream declarations that cannot start: {problems:?}");
    }
}


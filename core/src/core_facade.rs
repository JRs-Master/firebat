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
        }
        assert!(
            problems.is_empty(),
            "these modules may be exposed to a hub visitor and can reach an account: {problems:?}"
        );
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


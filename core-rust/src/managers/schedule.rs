//! ScheduleManager — 크론/예약 CRUD + handle_trigger.
//!
//! 옛 TS `core/managers/schedule-manager.ts` Rust 1:1 port. cron 발화 시 다음 분기:
//! 1. runWhen 평가 (sysmod 호출 + condition) → 미충족 skip
//! 2. retry loop (count + delayMs)
//! 3. 본 실행 — agent / pipeline / page URL / sandbox 4 모드
//! 4. notify hook (성공/실패별 sysmod 호출 + template 치환)
//! 5. oneShot 자동 취소 (성공 + condition met 시)

use std::sync::Arc;

use crate::adapters::cron::TokioCronAdapter;
use crate::managers::ai::AiManager;
use crate::managers::episodic::EpisodicManager;
use crate::managers::event::EventManager;
use crate::managers::status::StatusManager;
use crate::managers::task::{PipelineStep, TaskManager};
use crate::managers::tool::ToolManager;
use crate::ports::{
    CronJobInfo, CronJobResult, CronLogEntry, CronNotification, CronScheduleOptions,
    CronTriggerCallback, CronTriggerInfo, ICronPort, ILogPort, ISandboxPort, InfraResult,
    LlmCallOpts, SandboxExecuteOpts, SaveEventInput,
};
use crate::utils::condition::evaluate_condition;
use crate::utils::path_resolve::resolve_field_path;

const MAX_RETRY_COUNT: i64 = 5;
const DEFAULT_RETRY_DELAY_MS: i64 = 30_000;

/// Schedule trigger 의 외부 dependency. `with_hooks()` 박힘 후 handle_trigger 의 4 모드 + runWhen
/// + notify 활성. 미박힘 시 sandbox-only fallback (page URL 알림 만 동작).
/// episodic 박힘 시 AI 미개입 자동 hook 활성 — cron 발화 시 save_event(type='cron_trigger') 자동.
#[derive(Clone)]
pub struct ScheduleHooks {
    pub task: Arc<TaskManager>,
    pub ai: Arc<AiManager>,
    pub sandbox: Arc<dyn ISandboxPort>,
    pub tools: Arc<ToolManager>,
    pub log: Arc<dyn ILogPort>,
    pub episodic: Arc<EpisodicManager>,
    /// StatusManager — cron job 가시화 (옛 TS core/index.ts:1368 statusMgr.start/done/error 패턴).
    pub status: Arc<StatusManager>,
    /// EventManager — cron 완료 SSE 발행 (옛 TS core/index.ts:1384 notifyCronComplete 패턴).
    pub event: Arc<EventManager>,
}

pub struct ScheduleManager {
    cron: Arc<TokioCronAdapter>,
    hooks: Option<ScheduleHooks>,
}

impl ScheduleManager {
    pub fn new(cron: Arc<TokioCronAdapter>) -> Self {
        Self { cron, hooks: None }
    }

    /// hooks 박은 ScheduleManager — handle_trigger 의 4 모드 + runWhen + notify 활성.
    pub fn with_hooks(mut self, hooks: ScheduleHooks) -> Self {
        self.hooks = Some(hooks);
        self
    }

    pub async fn schedule(
        &self,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()> {
        // pipeline 검증은 Phase B-14 TaskManager 박힌 후 Core facade 에서 수행.
        // agent 모드 검증도 Phase B-16 AiManager 박힌 후 Core facade 에서.
        // 매니저 차원에서는 어댑터 위임만.
        if let (None, None, None) = (
            opts.cron_time.as_ref(),
            opts.run_at.as_ref(),
            opts.delay_sec,
        ) {
            return Err(
                "schedule: cronTime / runAt / delaySec 중 하나는 반드시 지정하세요"
                    .to_string(),
            );
        }
        self.cron.schedule_with_spawn(job_id, target_path, opts).await
    }

    pub async fn cancel(&self, job_id: &str) -> InfraResult<()> {
        self.cron.cancel(job_id).await
    }

    pub async fn update(
        &self,
        job_id: &str,
        target_path: &str,
        opts: CronScheduleOptions,
    ) -> InfraResult<()> {
        let _ = self.cron.cancel(job_id).await; // 미존재 OK
        self.schedule(job_id, target_path, opts).await
    }

    pub async fn trigger_now(&self, job_id: &str) -> InfraResult<()> {
        self.cron.trigger_now(job_id).await
    }

    pub fn list(&self) -> Vec<CronJobInfo> {
        self.cron.list()
    }

    pub fn get_logs(&self, limit: Option<usize>) -> Vec<CronLogEntry> {
        self.cron.get_logs(limit)
    }

    pub fn clear_logs(&self) {
        self.cron.clear_logs()
    }

    pub fn consume_notifications(&self) -> Vec<CronNotification> {
        self.cron.consume_notifications()
    }

    pub fn set_timezone(&self, tz: &str) {
        self.cron.set_timezone(tz);
    }

    pub fn get_timezone(&self) -> String {
        self.cron.get_timezone()
    }

    pub fn on_trigger(&self, callback: CronTriggerCallback) {
        self.cron.on_trigger(callback);
    }

    /// 부팅 시 영속 잡 복원 — main.rs 가 호출.
    pub async fn restore(&self) {
        self.cron.restore().await;
    }

    // ─────── handle_trigger — cron 발화 시 호출 (옛 TS handleTrigger Rust port) ───────

    /// cron 발화 처리:
    /// 1. runWhen 평가 → 미충족 skip
    /// 2. retry loop — info.retry.count 만큼 반복
    /// 3. run_once — agent / pipeline / page URL / sandbox 4 모드
    /// 4. notify hook (fire-and-forget)
    /// 5. oneShot 자동 취소
    pub async fn handle_trigger(self: &Arc<Self>, info: CronTriggerInfo) -> CronJobResult {
        let start = std::time::Instant::now();

        // AI 미개입 cross-call hook — cron job StatusManager 시작 (옛 TS core/index.ts:1368
        // statusMgr.start 패턴 1:1). 어드민 UI 의 ActiveJobsIndicator 가 자동 표시.
        let status_job_id = self.hooks.as_ref().map(|h| {
            let job = h.status.start(
                Some(format!("cron-{}", info.job_id)),
                "cron".to_string(),
                Some(format!("cron 발화: {}", info.job_id)),
                None,
                serde_json::json!({"jobId": info.job_id, "trigger": format!("{:?}", info.trigger)}),
            );
            job.id
        });

        // 1. runWhen — 미충족 skip
        if let Some(run_when) = &info.run_when {
            if let Some(hooks) = &self.hooks {
                let met = self
                    .evaluate_run_when(run_when, &info.job_id, hooks)
                    .await;
                if !met.0 {
                    hooks.log.info(&format!(
                        "[Cron] runWhen 미충족 → skip: {} ({})",
                        info.job_id, met.1
                    ));
                    return CronJobResult {
                        job_id: info.job_id.clone(),
                        target_path: info.target_path.clone(),
                        trigger: info.trigger,
                        success: true,
                        duration_ms: start.elapsed().as_millis() as i64,
                        error: None,
                        output: Some(serde_json::json!({"skipped": true, "reason": met.1})),
                        steps_executed: None,
                        steps_total: None,
                    };
                }
            }
        }

        // 2. retry loop
        let retry_count = info
            .retry
            .as_ref()
            .and_then(|r| r.get("count"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .clamp(0, MAX_RETRY_COUNT);
        let retry_delay_ms = info
            .retry
            .as_ref()
            .and_then(|r| r.get("delayMs"))
            .and_then(|v| v.as_i64())
            .unwrap_or(DEFAULT_RETRY_DELAY_MS);

        let mut result: Option<CronJobResult> = None;
        for attempt in 0..=retry_count {
            if attempt > 0 {
                if let Some(hooks) = &self.hooks {
                    hooks.log.warn(&format!(
                        "[Cron] retry {}/{}: {} ({}ms 대기)",
                        attempt, retry_count, info.job_id, retry_delay_ms
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(retry_delay_ms as u64)).await;
            }
            let r = self.run_once(&info, start).await;
            let success = r.success;
            result = Some(r);
            if success {
                break;
            }
        }
        let final_result = result.expect("retry loop 가 attempt=0 부터 실행 → 항상 채워짐");

        // 3. notify hook (fire-and-forget)
        if let Some(notify) = &info.notify {
            if let Some(hooks) = &self.hooks {
                let notify_clone = notify.clone();
                let info_clone = info.clone();
                let result_clone = final_result.clone();
                let hooks_clone = hooks.clone();
                let self_clone = self.clone();
                tokio::spawn(async move {
                    let _ = self_clone
                        .fire_notify(&notify_clone, &info_clone, &result_clone, &hooks_clone)
                        .await;
                });
            }
        }

        // 4. oneShot 자동 취소
        let condition_met = final_result
            .output
            .as_ref()
            .and_then(|o| o.get("conditionMet"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if final_result.success && condition_met && info.one_shot.unwrap_or(false) {
            if let Some(hooks) = &self.hooks {
                hooks
                    .log
                    .info(&format!("[Cron] oneShot 성공 → 자동 취소: {}", info.job_id));
            }
            let _ = self.cron.cancel(&info.job_id).await;
        }

        // 5. AI 미개입 자동 hook 1: cron 발화 사실 자체를 리콜에 박음.
        // 옛 TS Core facade 의 saveEvent 자동 호출 패턴 1:1. silent 실패 (event 박기 실패해도 cron
        // result 영향 X). type='cron_trigger' / title=jobId / description=success/error 요약.
        if let Some(hooks) = &self.hooks {
            let description = if final_result.success {
                format!("cron 정상 실행 ({}ms)", final_result.duration_ms)
            } else {
                format!(
                    "cron 실패: {}",
                    final_result.error.as_deref().unwrap_or("(unknown)")
                )
            };
            let _ = hooks.episodic.save_event(SaveEventInput {
                event_type: "cron_trigger".to_string(),
                title: info.job_id.clone(),
                description: Some(description),
                ..Default::default()
            });
        }

        // 6. AI 미개입 자동 hook 2: StatusManager done/error 박음 (옛 TS core/index.ts:1375 패턴).
        if let (Some(hooks), Some(job_id)) = (&self.hooks, status_job_id) {
            if final_result.success {
                let _ = hooks.status.complete(
                    &job_id,
                    Some(serde_json::json!({
                        "durationMs": final_result.duration_ms,
                        "success": true,
                    })),
                );
            } else {
                let _ = hooks.status.fail(
                    &job_id,
                    final_result
                        .error
                        .clone()
                        .unwrap_or_else(|| "Cron 실행 실패".to_string()),
                );
            }
        }

        // 7. AI 미개입 자동 hook 3: cron:complete SSE 발행 (옛 TS core/index.ts:1384 1:1).
        // 어드민 클라이언트의 CronPanel + Sidebar 가 SSE 받아 실시간 갱신.
        if let Some(hooks) = &self.hooks {
            let mut meta = serde_json::Map::new();
            meta.insert("jobId".into(), serde_json::Value::String(info.job_id.clone()));
            meta.insert("success".into(), serde_json::Value::Bool(final_result.success));
            meta.insert(
                "durationMs".into(),
                serde_json::Value::from(final_result.duration_ms),
            );
            if let Some(err) = &final_result.error {
                meta.insert("error".into(), serde_json::Value::String(err.clone()));
            }
            hooks.event.notify_cron_complete(serde_json::Value::Object(meta));
        }

        final_result
    }

    /// 단일 실행 — agent / pipeline / page URL / sandbox 4 모드 분기.
    async fn run_once(&self, info: &CronTriggerInfo, start: std::time::Instant) -> CronJobResult {
        let mut success = false;
        let mut error: Option<String> = None;
        let mut output: Option<serde_json::Value> = None;
        let mut steps_total: Option<i64> = None;
        let mut steps_executed: Option<i64> = None;

        let hooks = self.hooks.as_ref();

        // Mode 1: agent (executionMode === "agent")
        if info.execution_mode.as_deref() == Some("agent") {
            if let Some(h) = hooks {
                let prompt = info
                    .agent_prompt
                    .as_deref()
                    .filter(|p| !p.trim().is_empty())
                    .or(info.title.as_deref())
                    .map(String::from)
                    .unwrap_or_else(|| format!("Cron job {} 실행", info.job_id));
                h.log.info(&format!(
                    "[Cron] agent 실행: {} ({:?}) — prompt 길이 {}",
                    info.job_id,
                    info.trigger,
                    prompt.len()
                ));
                match h.ai.process_with_tools(&prompt, &[], &LlmCallOpts::default()).await {
                    Ok(res) => {
                        success = res.error.is_none();
                        if !success {
                            error = res.error.clone();
                        }
                        let mut out = serde_json::Map::new();
                        out.insert("mode".into(), serde_json::Value::String("agent".into()));
                        if !res.executed_actions.is_empty() {
                            out.insert(
                                "executedActions".into(),
                                serde_json::Value::Array(res.executed_actions),
                            );
                        }
                        if !res.blocks.is_empty() {
                            out.insert("blockCount".into(), serde_json::Value::from(res.blocks.len()));
                        }
                        if !res.reply.is_empty() {
                            let preview: String = res.reply.chars().take(200).collect();
                            out.insert("replyPreview".into(), serde_json::Value::String(preview));
                        }
                        output = Some(serde_json::Value::Object(out));
                    }
                    Err(e) => {
                        error = Some(e);
                    }
                }
            } else {
                error = Some("ScheduleHooks 미박음 — agent 모드 cron 작동 안 함".to_string());
            }
        }
        // Mode 2: pipeline
        else if let Some(pipeline_value) = info.pipeline.as_ref().filter(|v| {
            v.as_array().map(|a| !a.is_empty()).unwrap_or(false)
        }) {
            if let Some(h) = hooks {
                let arr = pipeline_value.as_array().unwrap();
                let total = arr.len() as i64;
                steps_total = Some(total);
                h.log.info(&format!(
                    "[Cron] 파이프라인 실행: {} ({}단계, {:?})",
                    info.job_id, total, info.trigger
                ));
                let steps: Vec<PipelineStep> = match serde_json::from_value(pipeline_value.clone()) {
                    Ok(s) => s,
                    Err(e) => {
                        return self.build_result(info, start, false, Some(format!("pipeline 파싱 실패: {e}")), None, None, steps_total);
                    }
                };
                let pipe_result = h.task.execute_pipeline(&steps).await;
                success = pipe_result.success;
                if !success {
                    error = pipe_result.error.clone();
                }
                steps_executed = Some(arr.len() as i64); // 단순화 — 실제 진행 추적은 후속
                output = Self::summarize_final_output(&steps, pipe_result.data.as_ref());
            } else {
                error = Some("ScheduleHooks 미박음 — pipeline 모드 cron 작동 안 함".to_string());
            }
        }
        // Mode 3: page URL 알림 (targetPath 가 / 시작)
        else if info.target_path.starts_with('/') {
            if let Some(h) = hooks {
                h.log.info(&format!(
                    "[Cron] 잡 실행: {} → {} ({:?})",
                    info.job_id, info.target_path, info.trigger
                ));
            }
            self.cron.append_notify(CronNotification {
                job_id: info.job_id.clone(),
                url: info.target_path.clone(),
                triggered_at: chrono::Utc::now().to_rfc3339(),
            });
            success = true;
            output = Some(serde_json::json!({"notified": info.target_path}));
        }
        // Mode 4: sandbox 모듈 실행
        else {
            if let Some(h) = hooks {
                h.log.info(&format!(
                    "[Cron] 잡 실행: {} → {} ({:?})",
                    info.job_id, info.target_path, info.trigger
                ));
                let input = info.input_data.clone().unwrap_or_else(|| {
                    serde_json::json!({"trigger": format!("{:?}", info.trigger), "jobId": info.job_id})
                });
                match h
                    .sandbox
                    .execute(&info.target_path, &input, &SandboxExecuteOpts::default())
                    .await
                {
                    Ok(res) => {
                        success = res.success;
                        if !res.success {
                            error = res.error;
                        } else {
                            output = Some(serde_json::json!({"module": info.target_path}));
                        }
                    }
                    Err(e) => {
                        error = Some(e);
                    }
                }
            } else {
                error = Some("ScheduleHooks 미박음 — sandbox 모드 cron 작동 안 함".to_string());
            }
        }

        self.build_result(info, start, success, error, output, steps_executed, steps_total)
    }

    fn build_result(
        &self,
        info: &CronTriggerInfo,
        start: std::time::Instant,
        success: bool,
        error: Option<String>,
        output: Option<serde_json::Value>,
        steps_executed: Option<i64>,
        steps_total: Option<i64>,
    ) -> CronJobResult {
        CronJobResult {
            job_id: info.job_id.clone(),
            target_path: info.target_path.clone(),
            trigger: info.trigger,
            success,
            duration_ms: start.elapsed().as_millis() as i64,
            error,
            output,
            steps_executed,
            steps_total,
        }
    }

    /// 마지막 step 결과 의미있는 요약 — silent failure 추적 (옛 TS summarizeFinalOutput Rust port).
    /// SAVE_PAGE → {savedSlug, renamed} / LLM_TRANSFORM → {textPreview, warning} /
    /// CONDITION 미충족 → {conditionMet: false} / 일반 EXECUTE → 처음 5 필드 추출.
    fn summarize_final_output(
        pipeline: &[PipelineStep],
        data: Option<&serde_json::Value>,
    ) -> Option<serde_json::Value> {
        let data = data?;
        let last = pipeline.last()?;
        match last {
            PipelineStep::SavePage { .. } => {
                if let Some(obj) = data.as_object() {
                    return Some(serde_json::json!({
                        "savedSlug": obj.get("slug"),
                        "renamed": obj.get("renamed").and_then(|v| v.as_bool()).unwrap_or(false),
                    }));
                }
                None
            }
            PipelineStep::LlmTransform { .. } => {
                if let Some(s) = data.as_str() {
                    let preview: String = s.chars().take(200).collect();
                    return Some(serde_json::json!({
                        "textPreview": preview,
                        "length": s.len(),
                        "warning": "pipeline ends with LLM_TRANSFORM — no actual save_page/sysmod execution",
                    }));
                }
                None
            }
            PipelineStep::Condition { .. } => {
                if let Some(obj) = data.as_object() {
                    if obj.get("conditionMet").and_then(|v| v.as_bool()) == Some(false) {
                        return Some(serde_json::json!({"conditionMet": false}));
                    }
                }
                None
            }
            _ => {
                if let Some(obj) = data.as_object() {
                    let mut summary = serde_json::Map::new();
                    for (k, v) in obj.iter().take(5) {
                        let trimmed = match v {
                            serde_json::Value::String(s) => {
                                serde_json::Value::String(s.chars().take(100).collect())
                            }
                            other => other.clone(),
                        };
                        summary.insert(k.clone(), trimmed);
                    }
                    return Some(serde_json::Value::Object(summary));
                }
                if let Some(s) = data.as_str() {
                    let preview: String = s.chars().take(200).collect();
                    return Some(serde_json::json!({"text": preview, "length": s.len()}));
                }
                Some(serde_json::json!({"value": data}))
            }
        }
    }

    /// runWhen 평가 — sysmod 호출 + field path 추출 + condition op 비교.
    /// 일반 메커니즘: 어떤 조건도 sysmod 결과 + condition 으로 표현 (휴장일 / 잔고 / 부재 모드 등 enumerate X).
    async fn evaluate_run_when(
        &self,
        run_when: &serde_json::Value,
        _job_id: &str,
        hooks: &ScheduleHooks,
    ) -> (bool, String) {
        // 옛 TS schema: { check: { sysmod, action, inputData }, field, op, value }
        let check = match run_when.get("check") {
            Some(v) => v,
            None => return (false, "runWhen.check 필드 누락".to_string()),
        };
        let sysmod = check.get("sysmod").and_then(|v| v.as_str()).unwrap_or("");
        let action = check.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let input_data = check
            .get("inputData")
            .cloned()
            .unwrap_or(serde_json::json!({}));
        let field = run_when.get("field").and_then(|v| v.as_str()).unwrap_or("");
        let op = run_when.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let expected = run_when.get("value");

        // sysmod path resolve — system/modules/<sysmod>/index.mjs
        let path = format!("system/modules/{}/index.mjs", sysmod);
        let mut input = input_data.clone();
        if !action.is_empty() {
            if let Some(obj) = input.as_object_mut() {
                obj.insert("action".to_string(), serde_json::Value::String(action.to_string()));
            }
        }

        match hooks
            .sandbox
            .execute(&path, &input, &SandboxExecuteOpts::default())
            .await
        {
            Ok(res) => {
                if !res.success {
                    return (
                        false,
                        format!(
                            "runWhen check 실행 실패: {}",
                            res.error.unwrap_or_default()
                        ),
                    );
                }
                // 모듈 결과 unwrap — { success, data } wrapper 면 내부 data 사용
                let mut result = res.data;
                if let Some(obj) = result.as_object() {
                    if obj.contains_key("success") && obj.contains_key("data") {
                        result = obj.get("data").cloned().unwrap_or(serde_json::Value::Null);
                    }
                }
                // field path 추출 — '$result.foo' / '$prev.foo' 접두사 정규화
                let field_path = field
                    .strip_prefix("$result.")
                    .or_else(|| field.strip_prefix("$prev."))
                    .unwrap_or(field);
                let actual = resolve_field_path(&result, field_path)
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let met = evaluate_condition(&actual, op, expected);
                (
                    met,
                    format!(
                        "{} {} {:?} → 실제={:?} = {}",
                        field, op, expected, actual, met
                    ),
                )
            }
            Err(e) => (false, format!("runWhen 평가 예외: {e}")),
        }
    }

    /// 알림 hook 발동 — 성공/실패별 sysmod 호출 + template 치환.
    /// schema: { onSuccess?: { sysmod, template?, chatId? }, onError?: {...} }
    /// fire-and-forget — 본 결과에 영향 X (caller 가 spawn).
    async fn fire_notify(
        &self,
        notify: &serde_json::Value,
        info: &CronTriggerInfo,
        result: &CronJobResult,
        hooks: &ScheduleHooks,
    ) -> InfraResult<()> {
        let cfg_key = if result.success { "onSuccess" } else { "onError" };
        let Some(cfg) = notify.get(cfg_key) else {
            return Ok(());
        };
        let sysmod = cfg.get("sysmod").and_then(|v| v.as_str()).unwrap_or("");
        if sysmod.is_empty() {
            return Ok(());
        }
        let path = format!("system/modules/{}/index.mjs", sysmod);

        // template 치환 — {title} / {jobId} / {error} / {duration|durationMs} / {output}
        let title = info
            .title
            .as_deref()
            .unwrap_or(&info.job_id)
            .to_string();
        let default_template = if result.success {
            format!("✓ {title} 완료 ({{durationMs}}ms)")
        } else {
            format!("❌ {title} 실패: {{error}}")
        };
        let tpl = cfg
            .get("template")
            .and_then(|v| v.as_str())
            .unwrap_or(&default_template);

        let output_str = result
            .output
            .as_ref()
            .map(|o| {
                let s = serde_json::to_string(o).unwrap_or_default();
                s.chars().take(200).collect::<String>()
            })
            .unwrap_or_default();
        let text = tpl
            .replace("{title}", &title)
            .replace("{jobId}", &info.job_id)
            .replace("{error}", result.error.as_deref().unwrap_or(""))
            .replace("{duration}", &result.duration_ms.to_string())
            .replace("{durationMs}", &result.duration_ms.to_string())
            .replace("{output}", &output_str);

        let mut input = serde_json::json!({"action": "send-message", "text": text});
        if let Some(chat_id) = cfg.get("chatId") {
            input["chatId"] = chat_id.clone();
        }
        hooks
            .sandbox
            .execute(&path, &input, &SandboxExecuteOpts::default())
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manager() -> (ScheduleManager, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let jobs = dir.path().join("jobs.json");
        let logs = dir.path().join("logs.json");
        let notes = dir.path().join("notes.json");
        let cron = TokioCronAdapter::new(jobs, logs, notes, "Asia/Seoul").unwrap();
        (ScheduleManager::new(cron), dir)
    }

    #[tokio::test]
    async fn schedule_invalid_no_time_rejected() {
        let (mgr, _dir) = manager();
        let result = mgr
            .schedule("j", "/p", CronScheduleOptions::default())
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn schedule_list_cancel_via_manager() {
        let (mgr, _dir) = manager();
        mgr.schedule(
            "j1",
            "/p",
            CronScheduleOptions {
                cron_time: Some("0 0 * * * *".to_string()),
                title: Some("test".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let list = mgr.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].options.title.as_deref(), Some("test"));

        mgr.cancel("j1").await.unwrap();
        assert!(mgr.list().is_empty());
    }

    #[tokio::test]
    async fn timezone_default_and_override() {
        let (mgr, _dir) = manager();
        assert_eq!(mgr.get_timezone(), "Asia/Seoul");
        mgr.set_timezone("UTC");
        assert_eq!(mgr.get_timezone(), "UTC");
    }
}

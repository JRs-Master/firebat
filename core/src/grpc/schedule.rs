//! gRPC ScheduleService impl — ScheduleManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.
//! 2026-05-15 — 옛 공유 타입 (Empty / StringRequest / NumberRequest) 폐기 + 매 RPC unique
//! Request / Response.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::schedule::ScheduleManager;
use crate::managers::task::{PipelineStep, TaskManager};
use crate::ports::{
    CronJobInfo, CronLogEntry, CronNotification, CronNotify, CronOccurrence, CronRetry,
    CronRunWhen, CronScheduleOptions,
};
use crate::proto::{
    schedule_service_server::ScheduleService, CancelCronRequest, CancelCronResponse,
    ClearCronLogsRequest, ClearCronLogsResponse, ConsumeCronNotificationsRequest, CronJobListPb,
    CronJobPb, CronLogEntryPb, CronLogListPb, CronNotificationListPb, CronNotificationPb,
    CronOccurrenceListPb, CronOccurrencePb, GetCronLogsRequest, ListCronOccurrencesRequest,
    ListCronRequest, RunCronNowRequest, RunCronNowResponse, ScheduleCronRequest,
    ScheduleCronResponse, UpdateCronRequest, UpdateCronResponse, ValidatePipelineRequest,
    ValidatePipelineResultPb,
};

pub struct ScheduleServiceImpl {
    manager: Arc<ScheduleManager>,
    /// TaskManager (옵션) — validate_pipeline 위임. 미설정 시 fallback (silent OK).
    task: Option<Arc<TaskManager>>,
}

impl ScheduleServiceImpl {
    pub fn new(manager: Arc<ScheduleManager>) -> Self {
        Self { manager, task: None }
    }

    /// TaskManager 설정한 채로 부팅 — validate_pipeline 정밀 검증 활성.
    pub fn with_task_manager(mut self, task: Arc<TaskManager>) -> Self {
        self.task = Some(task);
        self
    }
}

/// 동적 JSON value parse helper — silently None 이면 None, 비어있으면 None, 실제 parse 실패만 Err.
fn parse_value(raw: Option<String>) -> Result<Option<serde_json::Value>, String> {
    match raw {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
    }
}
/// typed schema 안에 들어간 동적 JSON 도 parse 동일 처리.
fn parse_typed<T: serde::de::DeserializeOwned>(
    raw: Option<String>,
    label: &str,
) -> Result<Option<T>, String> {
    match raw {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("{label}: {e}")),
    }
}

/// ScheduleCron / UpdateCron Request 공통 field 셋 (등록/수정 호환). proto schema 분리는
/// buf STANDARD `RPC_REQUEST_RESPONSE_UNIQUE` 룰 정공이지만 변환 로직은 중복 회피.
struct ScheduleArgs {
    job_id: Option<String>,
    target_path: String,
    cron_time: Option<String>,
    run_at: Option<String>,
    delay_sec: Option<i64>,
    start_at: Option<String>,
    end_at: Option<String>,
    input_data_json: Option<String>,
    pipeline_json: Option<String>,
    title: Option<String>,
    description: Option<String>,
    one_shot: Option<bool>,
    run_when_json: Option<String>,
    retry_json: Option<String>,
    notify_json: Option<String>,
    execution_mode: Option<String>,
    agent_prompt: Option<String>,
    show_in_calendar: Option<bool>,
}

impl From<ScheduleCronRequest> for ScheduleArgs {
    fn from(r: ScheduleCronRequest) -> Self {
        Self {
            job_id: r.job_id, target_path: r.target_path,
            cron_time: r.cron_time, run_at: r.run_at, delay_sec: r.delay_sec,
            start_at: r.start_at, end_at: r.end_at,
            input_data_json: r.input_data_json, pipeline_json: r.pipeline_json,
            title: r.title, description: r.description, one_shot: r.one_shot,
            run_when_json: r.run_when_json, retry_json: r.retry_json,
            notify_json: r.notify_json, execution_mode: r.execution_mode,
            agent_prompt: r.agent_prompt, show_in_calendar: r.show_in_calendar,
        }
    }
}
impl From<UpdateCronRequest> for ScheduleArgs {
    fn from(r: UpdateCronRequest) -> Self {
        Self {
            job_id: r.job_id, target_path: r.target_path,
            cron_time: r.cron_time, run_at: r.run_at, delay_sec: r.delay_sec,
            start_at: r.start_at, end_at: r.end_at,
            input_data_json: r.input_data_json, pipeline_json: r.pipeline_json,
            title: r.title, description: r.description, one_shot: r.one_shot,
            run_when_json: r.run_when_json, retry_json: r.retry_json,
            notify_json: r.notify_json, execution_mode: r.execution_mode,
            agent_prompt: r.agent_prompt, show_in_calendar: r.show_in_calendar,
        }
    }
}

fn parse_schedule_args(args: ScheduleArgs) -> Result<(String, String, CronScheduleOptions), String> {
    let opts = CronScheduleOptions {
        cron_time: args.cron_time,
        run_at: args.run_at,
        delay_sec: args.delay_sec,
        start_at: args.start_at,
        end_at: args.end_at,
        input_data: parse_value(args.input_data_json)?,
        pipeline: parse_typed::<Vec<PipelineStep>>(args.pipeline_json, "pipeline")?,
        title: args.title,
        description: args.description,
        one_shot: args.one_shot,
        run_when: parse_typed::<CronRunWhen>(args.run_when_json, "runWhen")?,
        retry: parse_typed::<CronRetry>(args.retry_json, "retry")?,
        notify: parse_typed::<CronNotify>(args.notify_json, "notify")?,
        execution_mode: args.execution_mode,
        agent_prompt: args.agent_prompt,
        // admin RPC 호출 = owner None. hub 익명 endpoint 가 직접 owner='hub:<id>' 주입.
        owner: None,
        // 시스템 스케줄은 이 RPC 로 만들지 않음(인프라가 직접 생성). 사용자 크론은 캘린더 opt-in 만 전달.
        system: None,
        builtin_kind: None,
        show_in_calendar: args.show_in_calendar,
    };
    Ok((args.job_id.unwrap_or_default(), args.target_path, opts))
}

// ─── proto ↔ core port struct 변환 ─────────────────────────────────────────

impl From<CronJobInfo> for CronJobPb {
    fn from(j: CronJobInfo) -> Self {
        let o = &j.options;
        CronJobPb {
            job_id: j.job_id,
            target_path: j.target_path,
            mode: format!("{:?}", j.mode).to_lowercase(),
            created_at: j.created_at,
            cron_time: o.cron_time.clone(),
            run_at: o.run_at.clone(),
            delay_sec: o.delay_sec,
            start_at: o.start_at.clone(),
            end_at: o.end_at.clone(),
            input_data_json: o
                .input_data
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok()),
            pipeline_json: o
                .pipeline
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok()),
            title: o.title.clone(),
            description: o.description.clone(),
            one_shot: o.one_shot,
            run_when_json: o
                .run_when
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok()),
            retry_json: o
                .retry
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok()),
            notify_json: o
                .notify
                .as_ref()
                .and_then(|v| serde_json::to_string(v).ok()),
            execution_mode: o.execution_mode.clone(),
            agent_prompt: o.agent_prompt.clone(),
            owner: o.owner.clone(),
            system: o.system,
            builtin_kind: o.builtin_kind.clone(),
            show_in_calendar: o.show_in_calendar,
        }
    }
}

impl From<CronLogEntry> for CronLogEntryPb {
    fn from(e: CronLogEntry) -> Self {
        CronLogEntryPb {
            job_id: e.job_id,
            target_path: e.target_path,
            title: e.title,
            triggered_at: e.triggered_at,
            success: e.success,
            duration_ms: e.duration_ms,
            error: e.error,
            output_json: e.output.as_ref().and_then(|v| serde_json::to_string(v).ok()),
            steps_executed: e.steps_executed,
            steps_total: e.steps_total,
        }
    }
}

impl From<CronNotification> for CronNotificationPb {
    fn from(n: CronNotification) -> Self {
        CronNotificationPb {
            job_id: n.job_id,
            url: n.url,
            triggered_at: n.triggered_at,
        }
    }
}

impl From<CronOccurrence> for CronOccurrencePb {
    fn from(o: CronOccurrence) -> Self {
        CronOccurrencePb {
            job_id: o.job_id,
            title: o.title,
            target_path: o.target_path,
            occurs_at: o.occurs_at,
            mode: o.mode,
        }
    }
}

#[tonic::async_trait]
impl ScheduleService for ScheduleServiceImpl {
    async fn schedule_cron(
        &self,
        req: Request<ScheduleCronRequest>,
    ) -> Result<Response<ScheduleCronResponse>, TonicStatus> {
        let (job_id, target_path, opts) = parse_schedule_args(req.into_inner().into())
            .map_err(|e| TonicStatus::invalid_argument(format!("schedule args: {e}")))?;
        self.manager
            .schedule(&job_id, &target_path, opts)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ScheduleCronResponse {}))
    }

    async fn cancel_cron(
        &self,
        req: Request<CancelCronRequest>,
    ) -> Result<Response<CancelCronResponse>, TonicStatus> {
        let args = req.into_inner();
        let job_id = args.job_id;
        // owner 지정(hub) → cancel_owned 로 owner 일치 검사. None(admin) → 기존 cancel(무검사).
        let cancelled = match args.owner.as_deref().filter(|s| !s.is_empty()) {
            Some(o) => self.manager.cancel_owned(&job_id, Some(o)).await,
            None => self.manager.cancel(&job_id).await,
        }
        .map_err(TonicStatus::internal)?;
        if !cancelled {
            return Err(TonicStatus::not_found(format!(
                "cron 잡 {} 미등록",
                job_id
            )));
        }
        Ok(Response::new(CancelCronResponse {}))
    }

    async fn update_cron(
        &self,
        req: Request<UpdateCronRequest>,
    ) -> Result<Response<UpdateCronResponse>, TonicStatus> {
        let args = req.into_inner();
        // owner 지정(hub) → update_owned 로 owner 일치 검사. None(admin) → 기존 update(무검사).
        // 잡 owner 자체는 update 가 기존값 보존(편집이 owner 안 바꿈).
        let owner = args.owner.clone().filter(|s| !s.is_empty());
        let (job_id, target_path, opts) = parse_schedule_args(args.into())
            .map_err(|e| TonicStatus::invalid_argument(format!("update args: {e}")))?;
        match owner.as_deref() {
            Some(o) => self.manager.update_owned(&job_id, &target_path, opts, Some(o)).await,
            None => self.manager.update(&job_id, &target_path, opts).await,
        }
        .map_err(TonicStatus::internal)?;
        Ok(Response::new(UpdateCronResponse {}))
    }

    async fn list_cron(
        &self,
        _req: Request<ListCronRequest>,
    ) -> Result<Response<CronJobListPb>, TonicStatus> {
        let jobs = self.manager.list().into_iter().map(Into::into).collect();
        Ok(Response::new(CronJobListPb { jobs }))
    }

    async fn get_logs(
        &self,
        req: Request<GetCronLogsRequest>,
    ) -> Result<Response<CronLogListPb>, TonicStatus> {
        let limit = req.into_inner().limit;
        let limit_opt = if limit > 0 { Some(limit as usize) } else { None };
        let entries = self.manager.get_logs(limit_opt).into_iter().map(Into::into).collect();
        Ok(Response::new(CronLogListPb { entries }))
    }

    async fn clear_logs(
        &self,
        _req: Request<ClearCronLogsRequest>,
    ) -> Result<Response<ClearCronLogsResponse>, TonicStatus> {
        self.manager.clear_logs();
        Ok(Response::new(ClearCronLogsResponse {}))
    }

    async fn consume_notifications(
        &self,
        _req: Request<ConsumeCronNotificationsRequest>,
    ) -> Result<Response<CronNotificationListPb>, TonicStatus> {
        let items = self
            .manager
            .consume_notifications()
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(CronNotificationListPb { items }))
    }

    async fn run_now(
        &self,
        req: Request<RunCronNowRequest>,
    ) -> Result<Response<RunCronNowResponse>, TonicStatus> {
        let args = req.into_inner();
        let job_id = args.job_id;
        // owner 지정(hub) → trigger_now_owned 로 owner 일치 검사. None(admin) → 기존 trigger_now(무검사).
        match args.owner.as_deref().filter(|s| !s.is_empty()) {
            Some(o) => self.manager.trigger_now_owned(&job_id, Some(o)).await,
            None => self.manager.trigger_now(&job_id).await,
        }
        .map_err(TonicStatus::internal)?;
        Ok(Response::new(RunCronNowResponse {}))
    }

    async fn validate_pipeline(
        &self,
        req: Request<ValidatePipelineRequest>,
    ) -> Result<Response<ValidatePipelineResultPb>, TonicStatus> {
        let args = req.into_inner();
        let Some(task) = &self.task else {
            return Ok(Response::new(ValidatePipelineResultPb { valid: true, error: None }));
        };
        let steps: Vec<PipelineStep> = serde_json::from_str(&args.pipeline_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("pipeline_json: {e}")))?;
        match task.validate_pipeline(&steps) {
            None => Ok(Response::new(ValidatePipelineResultPb { valid: true, error: None })),
            Some(err) => Ok(Response::new(ValidatePipelineResultPb {
                valid: false,
                error: Some(err),
            })),
        }
    }

    async fn list_occurrences(
        &self,
        req: Request<ListCronOccurrencesRequest>,
    ) -> Result<Response<CronOccurrenceListPb>, TonicStatus> {
        let r = req.into_inner();
        let occurrences = self
            .manager
            .list_occurrences(&r.from_date, &r.to_date, r.owner.as_deref())
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(CronOccurrenceListPb { occurrences }))
    }
}

// Tests 이관 — `infra/tests/svc_schedule_test.rs` (integration test).

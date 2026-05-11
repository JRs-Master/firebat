//! gRPC ScheduleService impl — ScheduleManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::schedule::ScheduleManager;
use crate::managers::task::{PipelineStep, TaskManager};
use crate::ports::{CronJobInfo, CronLogEntry, CronNotification, CronScheduleOptions};
use crate::proto::{
    schedule_service_server::ScheduleService, CronJobListPb, CronJobPb, CronLogEntryPb,
    CronLogListPb, CronNotificationListPb, CronNotificationPb, Empty, NumberRequest,
    ScheduleCronRequest, Status, StringRequest, ValidatePipelineRequest, ValidatePipelineResultPb,
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

fn ok_status() -> Response<Status> {
    Response::new(Status {
        ok: true,
        error: String::new(),
        error_code: String::new(),
    })
}

fn err_status(msg: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: String::new(),
    })
}

/// ScheduleCronRequest → (job_id, target_path, CronScheduleOptions) 변환.
/// 동적 JSON field (input_data / pipeline / run_when / retry / notify) 는 string 으로
/// 전달되므로 serde_json::from_str 으로 Value 복원.
fn parse_schedule_request(
    req: ScheduleCronRequest,
) -> Result<(String, String, CronScheduleOptions), String> {
    let parse_value = |raw: Option<String>| -> Result<Option<serde_json::Value>, String> {
        match raw {
            None => Ok(None),
            Some(s) if s.is_empty() => Ok(None),
            Some(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
        }
    };
    let opts = CronScheduleOptions {
        cron_time: req.cron_time,
        run_at: req.run_at,
        delay_sec: req.delay_sec,
        start_at: req.start_at,
        end_at: req.end_at,
        input_data: parse_value(req.input_data_json)?,
        pipeline: parse_value(req.pipeline_json)?,
        title: req.title,
        description: req.description,
        one_shot: req.one_shot,
        run_when: parse_value(req.run_when_json)?,
        retry: parse_value(req.retry_json)?,
        notify: parse_value(req.notify_json)?,
        execution_mode: req.execution_mode,
        agent_prompt: req.agent_prompt,
    };
    Ok((req.job_id.unwrap_or_default(), req.target_path, opts))
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

#[tonic::async_trait]
impl ScheduleService for ScheduleServiceImpl {
    async fn schedule_cron(
        &self,
        req: Request<ScheduleCronRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let (job_id, target_path, opts) = match parse_schedule_request(req.into_inner()) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("schedule args: {e}"))),
        };
        match self.manager.schedule(&job_id, &target_path, opts).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn cancel_cron(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let job_id = req.into_inner().value;
        match self.manager.cancel(&job_id).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn update_cron(
        &self,
        req: Request<ScheduleCronRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let (job_id, target_path, opts) = match parse_schedule_request(req.into_inner()) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("update args: {e}"))),
        };
        match self.manager.update(&job_id, &target_path, opts).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn list_cron(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<CronJobListPb>, TonicStatus> {
        let jobs = self.manager.list().into_iter().map(Into::into).collect();
        Ok(Response::new(CronJobListPb { jobs }))
    }

    async fn get_logs(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<CronLogListPb>, TonicStatus> {
        let limit = req.into_inner().value;
        let limit_opt = if limit > 0 { Some(limit as usize) } else { None };
        let entries = self.manager.get_logs(limit_opt).into_iter().map(Into::into).collect();
        Ok(Response::new(CronLogListPb { entries }))
    }

    async fn clear_logs(&self, _req: Request<Empty>) -> Result<Response<Status>, TonicStatus> {
        self.manager.clear_logs();
        Ok(ok_status())
    }

    async fn consume_notifications(
        &self,
        _req: Request<Empty>,
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
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let job_id = req.into_inner().value;
        match self.manager.trigger_now(&job_id).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
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
}

// Tests 이관 — `infra/tests/svc_schedule_test.rs` (integration test).

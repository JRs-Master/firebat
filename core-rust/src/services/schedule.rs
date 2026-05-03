//! gRPC ScheduleService impl — ScheduleManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::schedule::ScheduleManager;
use crate::ports::CronScheduleOptions;
use crate::proto::{
    schedule_service_server::ScheduleService, Empty, JsonArgs, JsonValue, NumberRequest, Status,
    StringRequest,
};

pub struct ScheduleServiceImpl {
    manager: Arc<ScheduleManager>,
}

impl ScheduleServiceImpl {
    pub fn new(manager: Arc<ScheduleManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
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

#[derive(serde::Deserialize)]
struct ScheduleArgs {
    #[serde(rename = "jobId")]
    job_id: String,
    #[serde(rename = "targetPath", default)]
    target_path: String,
    #[serde(flatten)]
    opts: CronScheduleOptions,
}

#[tonic::async_trait]
impl ScheduleService for ScheduleServiceImpl {
    async fn schedule_cron(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        let args: ScheduleArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("schedule args: {e}"))),
        };
        match self
            .manager
            .schedule(&args.job_id, &args.target_path, args.opts)
            .await
        {
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
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        let args: ScheduleArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("update args: {e}"))),
        };
        match self
            .manager
            .update(&args.job_id, &args.target_path, args.opts)
            .await
        {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn list_cron(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&self.manager.list())
    }

    async fn get_logs(
        &self,
        req: Request<NumberRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let limit = req.into_inner().value;
        let limit_opt = if limit > 0 { Some(limit as usize) } else { None };
        json_response(&self.manager.get_logs(limit_opt))
    }

    async fn clear_logs(&self, _req: Request<Empty>) -> Result<Response<Status>, TonicStatus> {
        self.manager.clear_logs();
        Ok(ok_status())
    }

    async fn consume_notifications(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&self.manager.consume_notifications())
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
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-14 TaskManager 박힌 후 활성. 현재는 silent OK 반환 (skip).
        json_response(&serde_json::json!({"_phase": "B-14 stub", "valid": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::cron::TokioCronAdapter;
    use tempfile::tempdir;

    fn service() -> (ScheduleServiceImpl, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let jobs = dir.path().join("jobs.json");
        let logs = dir.path().join("logs.json");
        let notes = dir.path().join("notes.json");
        let cron = TokioCronAdapter::new(jobs, logs, notes, "Asia/Seoul").unwrap();
        let mgr = Arc::new(ScheduleManager::new(cron));
        (ScheduleServiceImpl::new(mgr), dir)
    }

    #[tokio::test]
    async fn schedule_then_list_via_grpc() {
        let (svc, _dir) = service();
        let resp = svc
            .schedule_cron(Request::new(JsonArgs {
                raw: serde_json::json!({
                    "jobId": "g1",
                    "targetPath": "/p",
                    "cronTime": "0 0 * * * *"
                })
                .to_string(),
            }))
            .await
            .unwrap();
        assert!(resp.into_inner().ok);

        let list = svc
            .list_cron(Request::new(Empty {}))
            .await
            .unwrap()
            .into_inner();
        let parsed: serde_json::Value = serde_json::from_str(&list.raw).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn cancel_unknown_returns_error() {
        let (svc, _dir) = service();
        let resp = svc
            .cancel_cron(Request::new(StringRequest {
                value: "none".to_string(),
            }))
            .await
            .unwrap();
        let status = resp.into_inner();
        assert!(!status.ok);
    }
}

//! gRPC StatusService impl — StatusManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::status::{JobStatusKind, StatusManager};
use crate::proto::{status_service_server::StatusService, Empty, JsonArgs, JsonValue, StringRequest};

pub struct StatusServiceImpl {
    manager: Arc<StatusManager>,
}

impl StatusServiceImpl {
    pub fn new(manager: Arc<StatusManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl StatusService for StatusServiceImpl {
    async fn start(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct StartArgs {
            #[serde(default)]
            id: Option<String>,
            #[serde(rename = "type")]
            job_type: String,
            #[serde(default)]
            message: Option<String>,
            #[serde(rename = "parentJobId", default)]
            parent_job_id: Option<String>,
            #[serde(default)]
            meta: serde_json::Value,
        }
        let args: StartArgs = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("start args: {e}")))?;
        let job = self.manager.start(args.id, args.job_type, args.message, args.parent_job_id, args.meta);
        json_response(&job)
    }

    async fn update(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct UpdateArgs {
            id: String,
            #[serde(default)]
            progress: Option<f64>,
            #[serde(default)]
            message: Option<String>,
            #[serde(default)]
            meta: Option<serde_json::Value>,
        }
        let args: UpdateArgs = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("update args: {e}")))?;
        let result = self.manager.update(&args.id, args.progress, args.message, args.meta);
        json_response(&result)
    }

    async fn complete(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct DoneArgs {
            id: String,
            #[serde(default)]
            result: Option<serde_json::Value>,
        }
        let args: DoneArgs = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("complete args: {e}")))?;
        let result = self.manager.complete(&args.id, args.result);
        json_response(&result)
    }

    async fn fail(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct FailArgs {
            id: String,
            error: String,
        }
        let args: FailArgs = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("fail args: {e}")))?;
        let result = self.manager.fail(&args.id, args.error);
        json_response(&result)
    }

    async fn get(&self, req: Request<StringRequest>) -> Result<Response<JsonValue>, TonicStatus> {
        let id = req.into_inner().value;
        let job = self.manager.get(&id);
        json_response(&job)
    }

    async fn list(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize, Default)]
        struct ListFilter {
            #[serde(rename = "type", default)]
            job_type: Option<String>,
            #[serde(default)]
            status: Option<JobStatusKind>,
            #[serde(default)]
            since: Option<i64>,
            #[serde(rename = "parentJobId", default)]
            parent_job_id: Option<String>,
            #[serde(default)]
            limit: Option<usize>,
        }
        let f: ListFilter = serde_json::from_str(&raw).unwrap_or_default();
        let jobs = self.manager.list(
            f.job_type.as_deref(),
            f.status,
            f.since,
            f.parent_job_id.as_deref(),
            f.limit,
        );
        json_response(&jobs)
    }

    async fn stats(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let stats = self.manager.stats();
        json_response(&stats)
    }
}

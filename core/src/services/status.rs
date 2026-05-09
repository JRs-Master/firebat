//! gRPC StatusService impl — StatusManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! Start / Update / Complete / Fail → 갱신된 JobStatus 레코드 (동적 meta 포함) → RawJsonPb.
//! Get / List / Stats → domain struct 배열 또는 집계 맵 → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::status::{JobStatusKind, StatusManager};
use crate::proto::{status_service_server::StatusService, Empty, JsonArgs, RawJsonPb, StringRequest};

pub struct StatusServiceImpl {
    manager: Arc<StatusManager>,
}

impl StatusServiceImpl {
    pub fn new(manager: Arc<StatusManager>) -> Self {
        Self { manager }
    }
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

#[tonic::async_trait]
impl StatusService for StatusServiceImpl {
    async fn start(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
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
        Ok(Response::new(raw_json(&job)))
    }

    async fn update(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
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
        Ok(Response::new(raw_json(&result)))
    }

    async fn complete(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
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
        Ok(Response::new(raw_json(&result)))
    }

    async fn fail(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct FailArgs {
            id: String,
            error: String,
        }
        let args: FailArgs = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("fail args: {e}")))?;
        let result = self.manager.fail(&args.id, args.error);
        Ok(Response::new(raw_json(&result)))
    }

    async fn get(&self, req: Request<StringRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let id = req.into_inner().value;
        let job = self.manager.get(&id);
        Ok(Response::new(raw_json(&job)))
    }

    async fn list(&self, req: Request<JsonArgs>) -> Result<Response<RawJsonPb>, TonicStatus> {
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
        Ok(Response::new(raw_json(&jobs)))
    }

    async fn stats(&self, _req: Request<Empty>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let stats = self.manager.stats();
        Ok(Response::new(raw_json(&stats)))
    }
}

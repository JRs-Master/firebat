//! gRPC StatusService impl — StatusManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! Start / Update / Complete / Fail → 갱신된 JobStatus 레코드 (동적 meta 포함) → RawJsonPb.
//! Get / List / Stats → domain struct 배열 또는 집계 맵 → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::status::{JobStatusKind, StatusManager};
use crate::proto::{
    status_service_server::StatusService, Empty, RawJsonPb, StatusCompleteRequest,
    StatusFailRequest, StatusListRequest, StatusStartRequest, StatusUpdateRequest, StringRequest,
};

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

fn parse_opt_json(raw: &str) -> serde_json::Value {
    if raw.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(raw).unwrap_or(serde_json::Value::Null)
    }
}

#[tonic::async_trait]
impl StatusService for StatusServiceImpl {
    async fn start(&self, req: Request<StatusStartRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let meta = parse_opt_json(&args.meta_json);
        let job = self.manager.start(args.id, args.job_type, args.message, args.parent_job_id, meta);
        Ok(Response::new(raw_json(&job)))
    }

    async fn update(&self, req: Request<StatusUpdateRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let meta = args
            .meta_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let result = self.manager.update(&args.id, args.progress, args.message, meta);
        Ok(Response::new(raw_json(&result)))
    }

    async fn complete(&self, req: Request<StatusCompleteRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let result_val = args
            .result_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let result = self.manager.complete(&args.id, result_val);
        Ok(Response::new(raw_json(&result)))
    }

    async fn fail(&self, req: Request<StatusFailRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let result = self.manager.fail(&args.id, args.error);
        Ok(Response::new(raw_json(&result)))
    }

    async fn get(&self, req: Request<StringRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let id = req.into_inner().value;
        let job = self.manager.get(&id);
        Ok(Response::new(raw_json(&job)))
    }

    async fn list(&self, req: Request<StatusListRequest>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        let status: Option<JobStatusKind> = args
            .status
            .as_deref()
            .and_then(|s| serde_json::from_value(serde_json::Value::String(s.to_string())).ok());
        let jobs = self.manager.list(
            args.job_type.as_deref(),
            status,
            args.since,
            args.parent_job_id.as_deref(),
            args.limit.map(|v| v as usize),
        );
        Ok(Response::new(raw_json(&jobs)))
    }

    async fn stats(&self, _req: Request<Empty>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let stats = self.manager.stats();
        Ok(Response::new(raw_json(&stats)))
    }
}

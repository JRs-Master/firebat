//! gRPC StatusService impl — StatusManager wrapping.
//!
//! 매 RPC unique Request / Response — buf STANDARD 정공.
//! 옛 공유 타입 (StringRequest / RawJsonPb / Empty) 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::status::{JobStatusKind, StatusManager};
use crate::proto::{
    status_service_server::StatusService, StatusCompleteRequest, StatusCompleteResponse,
    StatusFailRequest, StatusFailResponse, StatusGetRequest, StatusGetResponse,
    StatusListRequest, StatusListResponse, StatusStartRequest, StatusStartResponse,
    StatusStatsRequest, StatusStatsResponse, StatusUpdateRequest, StatusUpdateResponse,
};

pub struct StatusServiceImpl {
    manager: Arc<StatusManager>,
}

impl StatusServiceImpl {
    pub fn new(manager: Arc<StatusManager>) -> Self {
        Self { manager }
    }
}

fn to_raw(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
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
    async fn start(
        &self,
        req: Request<StatusStartRequest>,
    ) -> Result<Response<StatusStartResponse>, TonicStatus> {
        let args = req.into_inner();
        let meta = parse_opt_json(&args.meta_json);
        let job = self
            .manager
            .start(args.id, args.job_type, args.message, args.parent_job_id, meta);
        Ok(Response::new(StatusStartResponse {
            raw_json: to_raw(&job),
        }))
    }

    async fn update(
        &self,
        req: Request<StatusUpdateRequest>,
    ) -> Result<Response<StatusUpdateResponse>, TonicStatus> {
        let args = req.into_inner();
        let meta = args
            .meta_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let result = self.manager.update(&args.id, args.progress, args.message, meta);
        Ok(Response::new(StatusUpdateResponse {
            raw_json: to_raw(&result),
        }))
    }

    async fn complete(
        &self,
        req: Request<StatusCompleteRequest>,
    ) -> Result<Response<StatusCompleteResponse>, TonicStatus> {
        let args = req.into_inner();
        let result_val = args
            .result_json
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|s| serde_json::from_str(s).ok());
        let result = self.manager.complete(&args.id, result_val);
        Ok(Response::new(StatusCompleteResponse {
            raw_json: to_raw(&result),
        }))
    }

    async fn fail(
        &self,
        req: Request<StatusFailRequest>,
    ) -> Result<Response<StatusFailResponse>, TonicStatus> {
        let args = req.into_inner();
        let result = self.manager.fail(&args.id, args.error);
        Ok(Response::new(StatusFailResponse {
            raw_json: to_raw(&result),
        }))
    }

    async fn get(
        &self,
        req: Request<StatusGetRequest>,
    ) -> Result<Response<StatusGetResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let job = self.manager.get(&id);
        Ok(Response::new(StatusGetResponse {
            raw_json: to_raw(&job),
        }))
    }

    async fn list(
        &self,
        req: Request<StatusListRequest>,
    ) -> Result<Response<StatusListResponse>, TonicStatus> {
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
        Ok(Response::new(StatusListResponse {
            raw_json: to_raw(&jobs),
        }))
    }

    async fn stats(
        &self,
        _req: Request<StatusStatsRequest>,
    ) -> Result<Response<StatusStatsResponse>, TonicStatus> {
        let stats = self.manager.stats();
        Ok(Response::new(StatusStatsResponse {
            raw_json: to_raw(&stats),
        }))
    }
}

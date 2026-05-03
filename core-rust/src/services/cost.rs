//! gRPC CostService impl — CostManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::cost::{CostBudget, CostManager, CostStatsFilter};
use crate::proto::{cost_service_server::CostService, Empty, JsonArgs, JsonValue, Status};

pub struct CostServiceImpl {
    manager: Arc<CostManager>,
}

impl CostServiceImpl {
    pub fn new(manager: Arc<CostManager>) -> Self {
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

#[tonic::async_trait]
impl CostService for CostServiceImpl {
    async fn get_stats(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        let filter: CostStatsFilter = serde_json::from_str(&raw).unwrap_or_default();
        let stats = self.manager.get_stats(&filter);
        json_response(&stats)
    }

    async fn flush(&self, _req: Request<Empty>) -> Result<Response<Status>, TonicStatus> {
        // Rust 에선 즉시 INSERT 라 별도 flush 불필요. ok 반환 (호환성).
        Ok(ok_status())
    }

    async fn get_budget(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let budget = self.manager.get_budget();
        json_response(&budget)
    }

    async fn set_budget(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        let budget: CostBudget = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_budget: {e}"))),
        };
        if self.manager.set_budget(&budget) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_budget 실패"))
        }
    }

    async fn check_budget(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let result = self.manager.check_budget();
        json_response(&result)
    }
}

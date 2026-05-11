//! gRPC TaskService impl — TaskManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core managers struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::task::{PipelineResult, PipelineStep, TaskManager};
use crate::proto::{task_service_server::TaskService, PipelineResultPb, TaskRunRequest};

pub struct TaskServiceImpl {
    manager: Arc<TaskManager>,
}

impl TaskServiceImpl {
    pub fn new(manager: Arc<TaskManager>) -> Self {
        Self { manager }
    }
}

// ─── proto ↔ core managers struct 변환 ────────────────────────────────────────

impl From<PipelineResult> for PipelineResultPb {
    fn from(r: PipelineResult) -> Self {
        PipelineResultPb {
            success: r.success,
            data_json: r.data.as_ref().and_then(|v| serde_json::to_string(v).ok()),
            error: r.error,
        }
    }
}

#[tonic::async_trait]
impl TaskService for TaskServiceImpl {
    async fn run(
        &self,
        req: Request<TaskRunRequest>,
    ) -> Result<Response<PipelineResultPb>, TonicStatus> {
        let args = req.into_inner();
        let steps: Vec<PipelineStep> = if args.pipeline_json.is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(&args.pipeline_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("pipeline_json: {e}")))?
        };
        let result = self.manager.execute_pipeline(&steps).await;
        Ok(Response::new(result.into()))
    }
}

// Tests 이관 — `infra/tests/svc_task_test.rs` (integration test).

//! gRPC TaskService impl — TaskManager wrapping.
//!
//! Phase B-14 minimum: Run RPC 활성. CONDITION 까지 진짜 평가, 다른 step 은 Phase B-16+ stub.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::task::{PipelineStep, TaskManager};
use crate::proto::{task_service_server::TaskService, JsonArgs, JsonValue};

pub struct TaskServiceImpl {
    manager: Arc<TaskManager>,
}

impl TaskServiceImpl {
    pub fn new(manager: Arc<TaskManager>) -> Self {
        Self { manager }
    }
}

#[tonic::async_trait]
impl TaskService for TaskServiceImpl {
    async fn run(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            #[serde(default)]
            steps: Vec<PipelineStep>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("run args: {e}")))?;
        let result = self.manager.execute_pipeline(&args.steps).await;
        let raw = serde_json::to_string(&result)
            .map_err(|e| TonicStatus::internal(format!("result 직렬화: {e}")))?;
        Ok(Response::new(JsonValue { raw }))
    }
}

// Tests 이관 — `infra/tests/svc_task_test.rs` (integration test).

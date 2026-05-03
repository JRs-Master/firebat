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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::log::ConsoleLogAdapter;
    use crate::managers::task::{StubTaskExecutor, TaskExecutor};
    use crate::ports::ILogPort;
    use serde_json::json;

    fn service() -> TaskServiceImpl {
        let executor: Arc<dyn TaskExecutor> = Arc::new(StubTaskExecutor);
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let mgr = Arc::new(TaskManager::new(executor, log));
        TaskServiceImpl::new(mgr)
    }

    #[tokio::test]
    async fn run_condition_only_pipeline_via_grpc() {
        let svc = service();
        let body = json!({
            "steps": [
                {"type": "CONDITION", "field": "x", "op": "exists"}
            ]
        });
        let resp = svc
            .run(Request::new(JsonArgs {
                raw: body.to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        // x 가 prev=null 에 없으므로 unmet → conditionMet=false 결과
        assert_eq!(parsed["success"], json!(true));
        assert_eq!(parsed["data"]["conditionMet"], json!(false));
    }

    #[tokio::test]
    async fn run_validate_failure_returns_error() {
        let svc = service();
        let body = json!({
            "steps": [
                {"type": "EXECUTE", "path": ""}
            ]
        });
        let resp = svc
            .run(Request::new(JsonArgs {
                raw: body.to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(parsed["success"], json!(false));
        assert!(parsed["error"].as_str().unwrap().contains("EXECUTE"));
    }
}

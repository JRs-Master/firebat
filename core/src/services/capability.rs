//! gRPC CapabilityService impl — CapabilityManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::capabilities::CapabilitySettings;
use crate::managers::capability::CapabilityManager;
use crate::proto::{
    capability_service_server::CapabilityService, Empty, JsonArgs, JsonValue, Status,
    StringRequest,
};

pub struct CapabilityServiceImpl {
    manager: Arc<CapabilityManager>,
}

impl CapabilityServiceImpl {
    pub fn new(manager: Arc<CapabilityManager>) -> Self {
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
impl CapabilityService for CapabilityServiceImpl {
    async fn list(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let caps = self.manager.list();
        json_response(&caps)
    }

    async fn register(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct RegArgs {
            id: String,
            label: String,
            description: String,
        }
        let args: RegArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("register args 파싱 실패: {e}"))),
        };
        self.manager
            .register(&args.id, &args.label, &args.description);
        Ok(ok_status())
    }

    async fn get_providers(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let cap_id = req.into_inner().value;
        let providers = self.manager.get_providers(&cap_id).await;
        json_response(&providers)
    }

    async fn list_with_providers(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let summary = self.manager.list_with_providers().await;
        json_response(&summary)
    }

    async fn resolve(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let cap_id = req.into_inner().value;
        let resolved = self.manager.resolve(&cap_id).await;
        json_response(&resolved)
    }

    async fn get_settings(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let cap_id = req.into_inner().value;
        let settings = self.manager.get_settings(&cap_id);
        json_response(&settings)
    }

    async fn set_settings(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct SetArgs {
            cap_id: String,
            settings: CapabilitySettings,
        }
        let args: SetArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_settings args 파싱 실패: {e}"))),
        };
        if self.manager.set_settings(&args.cap_id, &args.settings) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_settings 저장 실패"))
        }
    }
}

// Tests 이관 — `infra/tests/svc_capability_test.rs` (integration test).

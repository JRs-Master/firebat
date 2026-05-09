//! gRPC TemplateService impl — TemplateManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! TemplateConfig / TemplateEntry 는 동적 spec 포함 도메인 타입 → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::template::{TemplateConfig, TemplateManager};
use crate::proto::{
    template_service_server::TemplateService, Empty, JsonArgs, RawJsonPb, Status, StringRequest,
};

pub struct TemplateServiceImpl {
    manager: Arc<TemplateManager>,
}

impl TemplateServiceImpl {
    pub fn new(manager: Arc<TemplateManager>) -> Self {
        Self { manager }
    }
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

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

#[tonic::async_trait]
impl TemplateService for TemplateServiceImpl {
    async fn list(&self, _req: Request<Empty>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let entries = self.manager.list().await;
        Ok(Response::new(raw_json(&entries)))
    }

    async fn get(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let slug = req.into_inner().value;
        let config = self.manager.get(&slug).await;
        Ok(Response::new(raw_json(&config)))
    }

    async fn save(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct SaveArgs {
            slug: String,
            config: TemplateConfig,
        }
        let args: SaveArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("save args 파싱 실패: {e}"))),
        };
        match self.manager.save(&args.slug, &args.config).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.delete(&slug).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_template_test.rs` (integration test).

//! gRPC TemplateService impl — TemplateManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! TemplateConfig / TemplateEntry 는 동적 spec 포함 도메인 타입 → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::template::{TemplateConfig, TemplateManager};
use crate::proto::{
    template_service_server::TemplateService, Empty, RawJsonPb, StringRequest, TemplateSaveRequest,
};

pub struct TemplateServiceImpl {
    manager: Arc<TemplateManager>,
}

impl TemplateServiceImpl {
    pub fn new(manager: Arc<TemplateManager>) -> Self {
        Self { manager }
    }
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

    async fn save(&self, req: Request<TemplateSaveRequest>) -> Result<Response<Empty>, TonicStatus> {
        let args = req.into_inner();
        let config: TemplateConfig = serde_json::from_str(&args.config_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("save config_json 파싱: {e}")))?;
        self.manager
            .save(&args.slug, &config)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn delete(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let slug = req.into_inner().value;
        self.manager
            .delete(&slug)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }
}

// Tests 이관 — `infra/tests/svc_template_test.rs` (integration test).

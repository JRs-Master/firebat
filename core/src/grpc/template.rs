//! gRPC TemplateService impl — TemplateManager wrapping.
//!
//! 매 RPC unique Request / Response — buf STANDARD 정공.
//! 옛 공유 타입 (StringRequest / RawJsonPb / Empty) 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::template::{TemplateConfig, TemplateManager};
use crate::proto::{
    template_service_server::TemplateService, TemplateDeleteRequest, TemplateDeleteResponse,
    TemplateGetRequest, TemplateGetResponse, TemplateListRequest, TemplateListResponse,
    TemplateSaveRequest, TemplateSaveResponse,
};

pub struct TemplateServiceImpl {
    manager: Arc<TemplateManager>,
}

impl TemplateServiceImpl {
    pub fn new(manager: Arc<TemplateManager>) -> Self {
        Self { manager }
    }
}

fn to_raw(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl TemplateService for TemplateServiceImpl {
    async fn list(
        &self,
        _req: Request<TemplateListRequest>,
    ) -> Result<Response<TemplateListResponse>, TonicStatus> {
        let entries = self.manager.list().await;
        Ok(Response::new(TemplateListResponse {
            raw_json: to_raw(&entries),
        }))
    }

    async fn get(
        &self,
        req: Request<TemplateGetRequest>,
    ) -> Result<Response<TemplateGetResponse>, TonicStatus> {
        let slug = req.into_inner().slug;
        let config = self.manager.get(&slug).await;
        Ok(Response::new(TemplateGetResponse {
            raw_json: to_raw(&config),
        }))
    }

    async fn save(
        &self,
        req: Request<TemplateSaveRequest>,
    ) -> Result<Response<TemplateSaveResponse>, TonicStatus> {
        let args = req.into_inner();
        let config: TemplateConfig = serde_json::from_str(&args.config_json).map_err(|e| {
            TonicStatus::invalid_argument(crate::i18n::t(
                "core.error.template.save_config_parse_failed",
                None,
                &[("detail", &e.to_string())],
            ))
        })?;
        self.manager
            .save(&args.slug, &config)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(TemplateSaveResponse {}))
    }

    async fn delete(
        &self,
        req: Request<TemplateDeleteRequest>,
    ) -> Result<Response<TemplateDeleteResponse>, TonicStatus> {
        let slug = req.into_inner().slug;
        self.manager
            .delete(&slug)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(TemplateDeleteResponse {}))
    }
}

// Tests 이관 — `infra/tests/svc_template_test.rs` (integration test).

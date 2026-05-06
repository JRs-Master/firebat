//! gRPC TemplateService impl — TemplateManager wrapping.
//!
//! Phase B 단계: JsonArgs (raw JSON string) → manager typed args 변환.
//! 이후 매니저별 typed proto message 박히면 generated stub 직접 활용 (이 wrapper 폐기).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::template::{TemplateConfig, TemplateManager};
use crate::proto::{
    template_service_server::TemplateService, Empty, JsonArgs, JsonValue, Status, StringRequest,
};

pub struct TemplateServiceImpl {
    manager: Arc<TemplateManager>,
}

impl TemplateServiceImpl {
    pub fn new(manager: Arc<TemplateManager>) -> Self {
        Self { manager }
    }
}

/// Helper — JsonValue (raw JSON string) 응답 빌드.
fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

/// Helper — Status (ok/error) 응답 빌드.
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
impl TemplateService for TemplateServiceImpl {
    /// List() → JsonValue (TemplateEntry array)
    async fn list(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let entries = self.manager.list().await;
        json_response(&entries)
    }

    /// Get(slug) → JsonValue (TemplateConfig 또는 null)
    async fn get(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let slug = req.into_inner().value;
        let config = self.manager.get(&slug).await;
        json_response(&config)
    }

    /// Save(JsonArgs { slug, config }) → Status
    async fn save(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        // JsonArgs 의 raw 가 { slug: string, config: TemplateConfig } 형태
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

    /// Delete(slug) → Status
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

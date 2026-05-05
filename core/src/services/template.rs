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

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::storage::LocalStorageAdapter;
    use crate::managers::template::{TemplateBlock, TemplateSpec};
    use crate::ports::IStoragePort;
    use tempfile::tempdir;

    fn make_template(name: &str) -> TemplateConfig {
        TemplateConfig {
            name: name.to_string(),
            description: "test".to_string(),
            tags: vec![],
            spec: TemplateSpec {
                head: serde_json::json!({}),
                body: vec![TemplateBlock {
                    block_type: "Text".to_string(),
                    props: serde_json::json!({"content": "hi"}),
                }],
            },
        }
    }

    #[tokio::test]
    async fn service_save_list_get_delete_roundtrip() {
        let tmp = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
        let manager = Arc::new(TemplateManager::new(storage));
        let service = TemplateServiceImpl::new(manager);

        // Save
        let cfg = make_template("주간 시황");
        let save_args = serde_json::json!({ "slug": "weekly", "config": cfg });
        let resp = service
            .save(Request::new(JsonArgs {
                raw: save_args.to_string(),
            }))
            .await
            .unwrap();
        assert!(resp.into_inner().ok);

        // List
        let resp = service.list(Request::new(Empty {})).await.unwrap();
        let raw = resp.into_inner().raw;
        let entries: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["slug"], "weekly");

        // Get
        let resp = service
            .get(Request::new(StringRequest {
                value: "weekly".to_string(),
            }))
            .await
            .unwrap();
        let got: Option<TemplateConfig> = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(got.is_some());
        assert_eq!(got.unwrap().name, "주간 시황");

        // Delete
        let resp = service
            .delete(Request::new(StringRequest {
                value: "weekly".to_string(),
            }))
            .await
            .unwrap();
        assert!(resp.into_inner().ok);

        // Verify deleted
        let resp = service.list(Request::new(Empty {})).await.unwrap();
        let entries: Vec<serde_json::Value> =
            serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(entries.len(), 0);
    }

    #[tokio::test]
    async fn service_save_invalid_args_returns_error_status() {
        let tmp = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
        let manager = Arc::new(TemplateManager::new(storage));
        let service = TemplateServiceImpl::new(manager);

        let resp = service
            .save(Request::new(JsonArgs {
                raw: "{ not valid json".to_string(),
            }))
            .await
            .unwrap();
        let status = resp.into_inner();
        assert!(!status.ok);
        assert!(status.error.contains("파싱 실패"));
    }
}

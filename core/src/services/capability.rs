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

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::{
        log::ConsoleLogAdapter, storage::LocalStorageAdapter, vault::SqliteVaultAdapter,
    };
    use crate::ports::{ILogPort, IStoragePort, IVaultPort};
    use tempfile::tempdir;

    fn make_service() -> CapabilityServiceImpl {
        let tmp = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        let manager = Arc::new(CapabilityManager::new(storage, vault, log));
        CapabilityServiceImpl::new(manager)
    }

    #[tokio::test]
    async fn list_returns_builtin_via_grpc() {
        let service = make_service();
        let resp = service.list(Request::new(Empty {})).await.unwrap();
        let caps: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(caps.get("web-scrape").is_some());
        assert!(caps.get("notification").is_some());
    }

    #[tokio::test]
    async fn settings_roundtrip_via_grpc() {
        let service = make_service();

        // set
        let resp = service
            .set_settings(Request::new(JsonArgs {
                raw: r#"{"cap_id":"notification","settings":{"providers":["a","b"]}}"#.to_string(),
            }))
            .await
            .unwrap();
        assert!(resp.into_inner().ok);

        // get
        let resp = service
            .get_settings(Request::new(StringRequest {
                value: "notification".to_string(),
            }))
            .await
            .unwrap();
        let settings: CapabilitySettings = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(settings.providers, vec!["a".to_string(), "b".to_string()]);
    }
}

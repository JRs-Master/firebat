//! gRPC CapabilityService impl — CapabilityManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core capabilities struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::capabilities::{CapabilityProvider, CapabilitySettings};
use crate::managers::capability::{CapabilityManager, CapabilitySummary};
use crate::proto::{
    capability_service_server::CapabilityService, CapabilityProviderListPb, CapabilityProviderPb,
    CapabilityRegisterRequest, CapabilitySetSettingsRequest, CapabilitySettingsPb,
    CapabilitySummaryListPb, CapabilitySummaryPb, Empty, RawJsonPb, Status, StringRequest,
};

pub struct CapabilityServiceImpl {
    manager: Arc<CapabilityManager>,
}

impl CapabilityServiceImpl {
    pub fn new(manager: Arc<CapabilityManager>) -> Self {
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

// ─── proto ↔ core capabilities struct 변환 ─────────────────────────────────

impl From<CapabilityProvider> for CapabilityProviderPb {
    fn from(p: CapabilityProvider) -> Self {
        CapabilityProviderPb {
            present: true,
            module_name: p.module_name,
            provider_type: format!("{:?}", p.provider_type).to_lowercase(),
            location: format!("{:?}", p.location).to_lowercase(),
            description: p.description,
        }
    }
}

impl From<CapabilitySummary> for CapabilitySummaryPb {
    fn from(s: CapabilitySummary) -> Self {
        CapabilitySummaryPb {
            id: s.id,
            label: s.label,
            description: s.description,
            provider_count: s.provider_count as i64,
        }
    }
}

impl From<CapabilitySettings> for CapabilitySettingsPb {
    fn from(s: CapabilitySettings) -> Self {
        CapabilitySettingsPb { providers: s.providers }
    }
}

#[tonic::async_trait]
impl CapabilityService for CapabilityServiceImpl {
    async fn list(&self, _req: Request<Empty>) -> Result<Response<RawJsonPb>, TonicStatus> {
        let caps = self.manager.list();
        Ok(Response::new(raw_json(&caps)))
    }

    async fn register(&self, req: Request<CapabilityRegisterRequest>) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .register(&args.id, &args.label, &args.description);
        Ok(ok_status())
    }

    async fn get_providers(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<CapabilityProviderListPb>, TonicStatus> {
        let cap_id = req.into_inner().value;
        let providers = self
            .manager
            .get_providers(&cap_id)
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(CapabilityProviderListPb { providers }))
    }

    async fn list_with_providers(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<CapabilitySummaryListPb>, TonicStatus> {
        let summaries = self
            .manager
            .list_with_providers()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(CapabilitySummaryListPb { summaries }))
    }

    async fn resolve(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<CapabilityProviderPb>, TonicStatus> {
        let cap_id = req.into_inner().value;
        let resolved = self.manager.resolve(&cap_id).await;
        Ok(Response::new(match resolved {
            Some(p) => p.into(),
            None => CapabilityProviderPb {
                present: false,
                ..Default::default()
            },
        }))
    }

    async fn get_settings(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<CapabilitySettingsPb>, TonicStatus> {
        let cap_id = req.into_inner().value;
        let settings = self.manager.get_settings(&cap_id);
        Ok(Response::new(settings.into()))
    }

    async fn set_settings(
        &self,
        req: Request<CapabilitySetSettingsRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        let settings = CapabilitySettings {
            providers: args.providers,
        };
        if self.manager.set_settings(&args.cap_id, &settings) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_settings 저장 실패"))
        }
    }
}

// Tests 이관 — `infra/tests/svc_capability_test.rs` (integration test).

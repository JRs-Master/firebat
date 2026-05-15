//! gRPC SecretService impl — SecretManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core managers struct ↔ proto generated struct 변환.
//! 2026-05-15 — 옛 공유 타입 (Empty / StringRequest / OptionalStringPb / StringListPb) 폐기
//! + 매 RPC unique Request / Response.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::secret::{ModuleSecretEntry, SecretManager};
use crate::proto::{
    secret_service_server::SecretService, ModuleSecretEntryPb, ModuleSecretListPb,
    SecretDeleteUserRequest, SecretDeleteUserResponse, SecretGetSystemRequest,
    SecretGetSystemResponse, SecretGetUserRequest, SecretGetUserResponse, SecretListUserRequest,
    SecretListUserResponse, SecretListUserModuleSecretsRequest, SecretSetSystemRequest,
    SecretSetSystemResponse, SecretSetUserRequest, SecretSetUserResponse,
};

pub struct SecretServiceImpl {
    manager: Arc<SecretManager>,
}

impl SecretServiceImpl {
    pub fn new(manager: Arc<SecretManager>) -> Self {
        Self { manager }
    }
}

// ─── proto ↔ core managers struct 변환 ────────────────────────────────────────

impl From<ModuleSecretEntry> for ModuleSecretEntryPb {
    fn from(e: ModuleSecretEntry) -> Self {
        ModuleSecretEntryPb {
            secret_name: e.secret_name,
            module_name: e.module_name,
            has_value: e.has_value,
        }
    }
}

#[tonic::async_trait]
impl SecretService for SecretServiceImpl {
    async fn list_user(
        &self,
        _req: Request<SecretListUserRequest>,
    ) -> Result<Response<SecretListUserResponse>, TonicStatus> {
        let names = self.manager.list_user();
        Ok(Response::new(SecretListUserResponse { names }))
    }

    async fn set_user(
        &self,
        req: Request<SecretSetUserRequest>,
    ) -> Result<Response<SecretSetUserResponse>, TonicStatus> {
        let args = req.into_inner();
        if self.manager.set_user(&args.name, &args.value) {
            Ok(Response::new(SecretSetUserResponse {}))
        } else {
            Err(TonicStatus::internal("set_user 실패"))
        }
    }

    async fn get_user(
        &self,
        req: Request<SecretGetUserRequest>,
    ) -> Result<Response<SecretGetUserResponse>, TonicStatus> {
        let name = req.into_inner().name;
        let value = self.manager.get_user(&name);
        Ok(Response::new(SecretGetUserResponse {
            value: value.clone().unwrap_or_default(),
            present: value.is_some(),
        }))
    }

    async fn delete_user(
        &self,
        req: Request<SecretDeleteUserRequest>,
    ) -> Result<Response<SecretDeleteUserResponse>, TonicStatus> {
        let name = req.into_inner().name;
        if self.manager.delete_user(&name) {
            Ok(Response::new(SecretDeleteUserResponse {}))
        } else {
            Err(TonicStatus::not_found("delete_user 실패"))
        }
    }

    async fn list_user_module_secrets(
        &self,
        _req: Request<SecretListUserModuleSecretsRequest>,
    ) -> Result<Response<ModuleSecretListPb>, TonicStatus> {
        let entries = self
            .manager
            .list_module_secrets()
            .await
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ModuleSecretListPb { entries }))
    }

    async fn get_system(
        &self,
        req: Request<SecretGetSystemRequest>,
    ) -> Result<Response<SecretGetSystemResponse>, TonicStatus> {
        let key = req.into_inner().key;
        let value = self.manager.get_system(&key);
        Ok(Response::new(SecretGetSystemResponse {
            value: value.clone().unwrap_or_default(),
            present: value.is_some(),
        }))
    }

    async fn set_system(
        &self,
        req: Request<SecretSetSystemRequest>,
    ) -> Result<Response<SecretSetSystemResponse>, TonicStatus> {
        let args = req.into_inner();
        if self.manager.set_system(&args.key, &args.value) {
            Ok(Response::new(SecretSetSystemResponse {}))
        } else {
            Err(TonicStatus::internal("set_system 실패"))
        }
    }
}

// Tests 이관 — `infra/tests/svc_secret_test.rs` (integration test).

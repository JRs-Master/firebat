//! gRPC SecretService impl — SecretManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::secret::SecretManager;
use crate::proto::{
    secret_service_server::SecretService, Empty, JsonArgs, JsonValue, Status, StringRequest,
};

pub struct SecretServiceImpl {
    manager: Arc<SecretManager>,
}

impl SecretServiceImpl {
    pub fn new(manager: Arc<SecretManager>) -> Self {
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
impl SecretService for SecretServiceImpl {
    async fn list_user(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let names = self.manager.list_user();
        json_response(&names)
    }

    async fn set_user(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct SetUserArgs {
            name: String,
            value: String,
        }
        let args: SetUserArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_user args 파싱 실패: {e}"))),
        };
        if self.manager.set_user(&args.name, &args.value) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_user 실패"))
        }
    }

    async fn get_user(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let name = req.into_inner().value;
        let value = self.manager.get_user(&name);
        json_response(&value)
    }

    async fn delete_user(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let name = req.into_inner().value;
        if self.manager.delete_user(&name) {
            Ok(ok_status())
        } else {
            Ok(err_status("delete_user 실패"))
        }
    }

    async fn list_user_module_secrets(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let entries = self.manager.list_module_secrets().await;
        json_response(&entries)
    }

    async fn get_system(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let key = req.into_inner().value;
        let value = self.manager.get_system(&key);
        json_response(&value)
    }

    async fn set_system(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct SetSystemArgs {
            key: String,
            value: String,
        }
        let args: SetSystemArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_system args 파싱 실패: {e}"))),
        };
        if self.manager.set_system(&args.key, &args.value) {
            Ok(ok_status())
        } else {
            Ok(err_status("set_system 실패"))
        }
    }
}

// Tests 이관 — `infra/tests/svc_secret_test.rs` (integration test).

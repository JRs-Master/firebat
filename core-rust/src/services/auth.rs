//! gRPC AuthService impl — AuthManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::auth::{AuthManager, LoginOutcome};
use crate::proto::{
    auth_service_server::AuthService, BoolRequest, Empty, JsonArgs, JsonValue, NumberRequest,
    Status, StringRequest,
};

pub struct AuthServiceImpl {
    manager: Arc<AuthManager>,
}

impl AuthServiceImpl {
    pub fn new(manager: Arc<AuthManager>) -> Self {
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

fn err_status(msg: impl Into<String>, code: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: code.into(),
    })
}

#[tonic::async_trait]
impl AuthService for AuthServiceImpl {
    async fn login(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct LoginArgs {
            id: String,
            password: String,
            #[serde(default)]
            attempt_key: String,
        }
        let args: LoginArgs = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("login args 파싱 실패: {e}")))?;
        let outcome = self.manager.login(&args.id, &args.password, &args.attempt_key);
        match outcome {
            LoginOutcome::Ok(session) => json_response(&serde_json::json!({
                "ok": true,
                "session": session,
            })),
            LoginOutcome::InvalidCredentials => json_response(&serde_json::json!({
                "ok": false,
                "error": "invalid credentials",
                "code": "AUTH_FAILED",
            })),
            LoginOutcome::Locked { retry_after_sec } => json_response(&serde_json::json!({
                "ok": false,
                "error": "locked",
                "code": "LOGIN_LOCKED",
                "retry_after_sec": retry_after_sec,
            })),
        }
    }

    async fn logout(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let token = req.into_inner().value;
        Ok(Response::new(BoolRequest {
            value: self.manager.logout(&token),
        }))
    }

    async fn validate_session(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let token = req.into_inner().value;
        let session = self.manager.validate_session(&token);
        json_response(&session)
    }

    async fn validate_token(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let token = req.into_inner().value;
        let session = self.manager.validate_token(&token);
        json_response(&session)
    }

    async fn generate_api_token(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        let label = req.into_inner().value;
        let token = self.manager.generate_api_token(if label.is_empty() {
            None
        } else {
            Some(&label)
        });
        Ok(Response::new(StringRequest { value: token }))
    }

    async fn validate_api_token(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let token = req.into_inner().value;
        let session = self.manager.validate_api_token(&token);
        json_response(&session)
    }

    async fn revoke_api_tokens(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        let count = self.manager.revoke_api_tokens() as i64;
        Ok(Response::new(NumberRequest { value: count }))
    }

    async fn get_api_token_info(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let info = self.manager.get_api_token_info();
        json_response(&info)
    }

    async fn get_admin_credentials(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let (id, password) = self.manager.get_admin_credentials();
        json_response(&serde_json::json!({
            "id": id,
            "password": password,
        }))
    }

    async fn set_admin_credentials(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct SetCredArgs {
            #[serde(default)]
            id: Option<String>,
            #[serde(default)]
            password: Option<String>,
        }
        let args: SetCredArgs = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                return Ok(err_status(
                    format!("set_admin_credentials 파싱 실패: {e}"),
                    "INVALID_ARGS",
                ));
            }
        };
        self.manager
            .set_admin_credentials(args.id.as_deref(), args.password.as_deref());
        Ok(ok_status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{auth::VaultAuthAdapter, vault::SqliteVaultAdapter};
    use crate::ports::{IAuthPort, IVaultPort};

    fn make_service() -> AuthServiceImpl {
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let auth: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));
        let manager = Arc::new(AuthManager::new(auth, vault));
        AuthServiceImpl::new(manager)
    }

    #[tokio::test]
    async fn login_success_via_grpc() {
        let service = make_service();
        let resp = service
            .login(Request::new(JsonArgs {
                raw: r#"{"id":"admin","password":"admin","attempt_key":"test"}"#.to_string(),
            }))
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(json["ok"], true);
        assert!(json["session"]["token"].as_str().unwrap().starts_with("fbat_"));
    }

    #[tokio::test]
    async fn login_wrong_password_returns_failed() {
        let service = make_service();
        let resp = service
            .login(Request::new(JsonArgs {
                raw: r#"{"id":"admin","password":"wrong"}"#.to_string(),
            }))
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["code"], "AUTH_FAILED");
    }

    #[tokio::test]
    async fn api_token_grpc_lifecycle() {
        let service = make_service();
        // 발급
        let resp = service
            .generate_api_token(Request::new(StringRequest {
                value: "MCP test".to_string(),
            }))
            .await
            .unwrap();
        let token = resp.into_inner().value;
        assert!(token.starts_with("fbat_"));

        // 검증
        let resp = service
            .validate_api_token(Request::new(StringRequest { value: token.clone() }))
            .await
            .unwrap();
        let session: Option<crate::ports::AuthSession> =
            serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(session.is_some());

        // info
        let resp = service.get_api_token_info(Request::new(Empty {})).await.unwrap();
        let info: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(info["exists"], true);

        // 폐기
        let resp = service.revoke_api_tokens(Request::new(Empty {})).await.unwrap();
        assert_eq!(resp.into_inner().value, 1);

        // 검증 실패
        let resp = service
            .validate_api_token(Request::new(StringRequest { value: token }))
            .await
            .unwrap();
        let session: Option<crate::ports::AuthSession> =
            serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert!(session.is_none());
    }
}

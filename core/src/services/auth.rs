//! gRPC AuthService impl — AuthManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 박혀 core port struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::auth::{ApiTokenInfo, AuthManager, LoginOutcome};
use crate::ports::{AuthSession, SessionRole, SessionType};
use crate::proto::{
    auth_service_server::AuthService, AdminCredentialsPb, ApiTokenInfoPb, AuthSessionPb,
    BoolRequest, Empty, JsonArgs, LoginResponsePb, NumberRequest, Status, StringRequest,
};

pub struct AuthServiceImpl {
    manager: Arc<AuthManager>,
}

impl AuthServiceImpl {
    pub fn new(manager: Arc<AuthManager>) -> Self {
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

fn err_status(msg: impl Into<String>, code: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: code.into(),
    })
}

// ─── proto ↔ core port struct 변환 ─────────────────────────────────────────

impl From<AuthSession> for AuthSessionPb {
    fn from(s: AuthSession) -> Self {
        AuthSessionPb {
            token: s.token,
            session_type: match s.session_type {
                SessionType::Session => "session".to_string(),
                SessionType::Api => "api".to_string(),
            },
            role: match s.role {
                SessionRole::Admin => "admin".to_string(),
            },
            created_at: s.created_at,
            expires_at: s.expires_at,
            last_used_at: s.last_used_at,
            label: s.label,
        }
    }
}

/// `Option<AuthSession>` → `AuthSessionPb` — None 은 token="" 빈 레코드.
/// 클라이언트는 `token.is_empty()` 로 미인증 판정.
fn session_opt_to_pb(opt: Option<AuthSession>) -> AuthSessionPb {
    opt.map(Into::into).unwrap_or_default()
}

impl From<ApiTokenInfo> for ApiTokenInfoPb {
    fn from(i: ApiTokenInfo) -> Self {
        ApiTokenInfoPb {
            exists: i.exists,
            hint: i.hint,
            label: i.label,
            created_at: i.created_at,
            last_used_at: i.last_used_at,
        }
    }
}

#[tonic::async_trait]
impl AuthService for AuthServiceImpl {
    async fn login(&self, req: Request<JsonArgs>) -> Result<Response<LoginResponsePb>, TonicStatus> {
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
        let pb = match outcome {
            LoginOutcome::Ok(session) => LoginResponsePb {
                ok: true,
                session: Some(session.into()),
                error: None,
                code: None,
                retry_after_sec: None,
            },
            LoginOutcome::InvalidCredentials => LoginResponsePb {
                ok: false,
                session: None,
                error: Some("invalid credentials".to_string()),
                code: Some("AUTH_FAILED".to_string()),
                retry_after_sec: None,
            },
            LoginOutcome::Locked { retry_after_sec } => LoginResponsePb {
                ok: false,
                session: None,
                error: Some("locked".to_string()),
                code: Some("LOGIN_LOCKED".to_string()),
                retry_after_sec: Some(retry_after_sec),
            },
        };
        Ok(Response::new(pb))
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
    ) -> Result<Response<AuthSessionPb>, TonicStatus> {
        let token = req.into_inner().value;
        Ok(Response::new(session_opt_to_pb(
            self.manager.validate_session(&token),
        )))
    }

    async fn validate_token(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<AuthSessionPb>, TonicStatus> {
        let token = req.into_inner().value;
        Ok(Response::new(session_opt_to_pb(
            self.manager.validate_token(&token),
        )))
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
    ) -> Result<Response<AuthSessionPb>, TonicStatus> {
        let token = req.into_inner().value;
        Ok(Response::new(session_opt_to_pb(
            self.manager.validate_api_token(&token),
        )))
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
    ) -> Result<Response<ApiTokenInfoPb>, TonicStatus> {
        Ok(Response::new(self.manager.get_api_token_info().into()))
    }

    async fn get_admin_credentials(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<AdminCredentialsPb>, TonicStatus> {
        let (id, password) = self.manager.get_admin_credentials();
        Ok(Response::new(AdminCredentialsPb { id, password }))
    }

    async fn is_admin_setup(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        Ok(Response::new(BoolRequest {
            value: self.manager.is_admin_setup(),
        }))
    }

    async fn verify_admin_password(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let plain = req.into_inner().value;
        Ok(Response::new(BoolRequest {
            value: self.manager.verify_admin_password(&plain),
        }))
    }

    async fn validate_password_policy(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            password: String,
            #[serde(default)]
            id: Option<String>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("validate_password_policy: {e}")))?;
        match crate::managers::auth::AuthManager::validate_password_policy(
            &args.password,
            args.id.as_deref(),
        ) {
            Ok(_) => Ok(Response::new(Status {
                ok: true,
                error: String::new(),
                error_code: String::new(),
            })),
            Err(e) => Ok(Response::new(Status {
                ok: false,
                error: e,
                error_code: "POLICY_VIOLATION".to_string(),
            })),
        }
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

// Tests 이관 — `infra/tests/svc_auth_test.rs` (integration test).

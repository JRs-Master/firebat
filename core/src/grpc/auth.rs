//! gRPC AuthService impl — AuthManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.
//! 2026-05-15: 옛 공유 타입 (Empty / BoolRequest / StringRequest / NumberRequest / AuthSessionPb)
//! → RPC 별 unique Request/Response 분리 (buf STANDARD lint RPC_REQUEST_RESPONSE_UNIQUE).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::auth::{ApiTokenInfo, AuthManager, LoginOutcome};
use crate::ports::{AuthSession, SessionRole, SessionType};
use crate::proto::{
    auth_service_server::AuthService, AdminCredentialsPb, ApiTokenInfoPb, AuthGenerateApiTokenRequest,
    AuthGenerateApiTokenResponse, AuthGetAdminCredentialsRequest, AuthGetApiTokenInfoRequest,
    AuthIsAdminSetupRequest, AuthIsAdminSetupResponse, AuthLoginRequest, AuthLogoutRequest,
    AuthLogoutResponse, AuthRevokeApiTokensRequest, AuthRevokeApiTokensResponse, AuthSessionPb,
    AuthSetAdminCredentialsRequest, AuthSetAdminCredentialsResponse, AuthValidateApiTokenRequest,
    AuthValidateApiTokenResponse, AuthValidatePasswordPolicyRequest,
    AuthValidatePasswordPolicyResponse, AuthValidateSessionRequest, AuthValidateSessionResponse,
    AuthValidateTokenRequest, AuthValidateTokenResponse, AuthVerifyAdminPasswordRequest,
    AuthVerifyAdminPasswordResponse, LoginResponsePb,
};

pub struct AuthServiceImpl {
    manager: Arc<AuthManager>,
}

impl AuthServiceImpl {
    pub fn new(manager: Arc<AuthManager>) -> Self {
        Self { manager }
    }
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
/// 클라이언트는 `session.token.is_empty()` 로 미인증 판정.
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
    async fn login(
        &self,
        req: Request<AuthLoginRequest>,
    ) -> Result<Response<LoginResponsePb>, TonicStatus> {
        let args = req.into_inner();
        let attempt_key = args.attempt_key.unwrap_or_default();
        let outcome = self.manager.login(&args.id, &args.password, &attempt_key);
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
        req: Request<AuthLogoutRequest>,
    ) -> Result<Response<AuthLogoutResponse>, TonicStatus> {
        let token = req.into_inner().session_token;
        Ok(Response::new(AuthLogoutResponse {
            ok: self.manager.logout(&token),
        }))
    }

    async fn validate_session(
        &self,
        req: Request<AuthValidateSessionRequest>,
    ) -> Result<Response<AuthValidateSessionResponse>, TonicStatus> {
        let token = req.into_inner().session_token;
        Ok(Response::new(AuthValidateSessionResponse {
            session: Some(session_opt_to_pb(self.manager.validate_session(&token))),
        }))
    }

    async fn validate_token(
        &self,
        req: Request<AuthValidateTokenRequest>,
    ) -> Result<Response<AuthValidateTokenResponse>, TonicStatus> {
        let token = req.into_inner().token;
        Ok(Response::new(AuthValidateTokenResponse {
            session: Some(session_opt_to_pb(self.manager.validate_token(&token))),
        }))
    }

    async fn generate_api_token(
        &self,
        req: Request<AuthGenerateApiTokenRequest>,
    ) -> Result<Response<AuthGenerateApiTokenResponse>, TonicStatus> {
        let label = req.into_inner().label;
        let token = self.manager.generate_api_token(if label.is_empty() {
            None
        } else {
            Some(&label)
        });
        Ok(Response::new(AuthGenerateApiTokenResponse { token }))
    }

    async fn validate_api_token(
        &self,
        req: Request<AuthValidateApiTokenRequest>,
    ) -> Result<Response<AuthValidateApiTokenResponse>, TonicStatus> {
        let token = req.into_inner().token;
        Ok(Response::new(AuthValidateApiTokenResponse {
            session: Some(session_opt_to_pb(self.manager.validate_api_token(&token))),
        }))
    }

    async fn revoke_api_tokens(
        &self,
        _req: Request<AuthRevokeApiTokensRequest>,
    ) -> Result<Response<AuthRevokeApiTokensResponse>, TonicStatus> {
        let revoked_count = self.manager.revoke_api_tokens() as i64;
        Ok(Response::new(AuthRevokeApiTokensResponse { revoked_count }))
    }

    async fn get_api_token_info(
        &self,
        _req: Request<AuthGetApiTokenInfoRequest>,
    ) -> Result<Response<ApiTokenInfoPb>, TonicStatus> {
        Ok(Response::new(self.manager.get_api_token_info().into()))
    }

    async fn get_admin_credentials(
        &self,
        _req: Request<AuthGetAdminCredentialsRequest>,
    ) -> Result<Response<AdminCredentialsPb>, TonicStatus> {
        let (id, password) = self.manager.get_admin_credentials();
        Ok(Response::new(AdminCredentialsPb { id, password }))
    }

    async fn is_admin_setup(
        &self,
        _req: Request<AuthIsAdminSetupRequest>,
    ) -> Result<Response<AuthIsAdminSetupResponse>, TonicStatus> {
        Ok(Response::new(AuthIsAdminSetupResponse {
            is_setup: self.manager.is_admin_setup(),
        }))
    }

    async fn verify_admin_password(
        &self,
        req: Request<AuthVerifyAdminPasswordRequest>,
    ) -> Result<Response<AuthVerifyAdminPasswordResponse>, TonicStatus> {
        let plain = req.into_inner().password;
        Ok(Response::new(AuthVerifyAdminPasswordResponse {
            valid: self.manager.verify_admin_password(&plain),
        }))
    }

    async fn validate_password_policy(
        &self,
        req: Request<AuthValidatePasswordPolicyRequest>,
    ) -> Result<Response<AuthValidatePasswordPolicyResponse>, TonicStatus> {
        let args = req.into_inner();
        crate::managers::auth::AuthManager::validate_password_policy(
            &args.password,
            args.id.as_deref(),
        )
        .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(AuthValidatePasswordPolicyResponse {}))
    }

    async fn set_admin_credentials(
        &self,
        req: Request<AuthSetAdminCredentialsRequest>,
    ) -> Result<Response<AuthSetAdminCredentialsResponse>, TonicStatus> {
        let args = req.into_inner();
        self.manager
            .set_admin_credentials(args.id.as_deref(), args.password.as_deref());
        Ok(Response::new(AuthSetAdminCredentialsResponse {}))
    }
}

// Tests 이관 — `infra/tests/svc_auth_test.rs` (integration test).

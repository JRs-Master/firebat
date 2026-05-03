//! gRPC SettingsService impl — Vault `system:*` 키 직접 wrapper.
//!
//! 옛 TS Core facade 의 settings 메서드들 (timezone / aiModel / userPrompt / anthropicCache 등)
//! Rust 재현. Vault 위 thin wrapper — 어드민 설정 모달 backend.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IVaultPort;
use crate::proto::{
    settings_service_server::SettingsService, BoolRequest, Empty, JsonArgs, JsonValue,
    StringRequest,
};

pub struct SettingsServiceImpl {
    vault: Arc<dyn IVaultPort>,
}

impl SettingsServiceImpl {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self { vault }
    }

    fn get_or_default(&self, key: &str, default: &str) -> String {
        self.vault
            .get_secret(key)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default.to_string())
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
}

#[tonic::async_trait]
impl SettingsService for SettingsServiceImpl {
    async fn get_timezone(&self, _req: Request<Empty>) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: self.get_or_default("system:timezone", "Asia/Seoul"),
        }))
    }

    async fn set_timezone(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let tz = req.into_inner().value;
        let ok = self.vault.set_secret("system:timezone", &tz);
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_ai_model(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let model = self.get_or_default("system:llm:model", "claude-4-sonnet");
        json_response(&serde_json::json!({"model": model}))
    }

    async fn set_ai_model(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let model = req.into_inner().value;
        let ok = self.vault.set_secret("system:llm:model", &model);
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_ai_thinking_level(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: self.get_or_default("system:llm:thinking-level", "medium"),
        }))
    }

    async fn set_ai_thinking_level(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let level = req.into_inner().value;
        let ok = self.vault.set_secret("system:llm:thinking-level", &level);
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_user_prompt(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: self.get_or_default("system:user-prompt", ""),
        }))
    }

    async fn set_user_prompt(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let prompt = req.into_inner().value;
        // 옛 TS 와 동일 — 2000자 제한
        if prompt.chars().count() > 2000 {
            return Ok(Response::new(BoolRequest { value: false }));
        }
        let ok = self.vault.set_secret("system:user-prompt", &prompt);
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_anthropic_cache_enabled(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let enabled = self
            .vault
            .get_secret("system:llm:anthropic-cache")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        Ok(Response::new(BoolRequest { value: enabled }))
    }

    async fn set_anthropic_cache_enabled(
        &self,
        req: Request<BoolRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let enabled = req.into_inner().value;
        let value = if enabled { "true" } else { "false" };
        let ok = self.vault.set_secret("system:llm:anthropic-cache", value);
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_last_model_by_category(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = self.get_or_default("system:llm:last-by-category", "{}");
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
        json_response(&parsed)
    }

    async fn set_last_model_by_category(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let raw = req.into_inner().raw;
        // valid JSON 검증 후 저장
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(Response::new(BoolRequest { value: false })),
        };
        let ok = self.vault.set_secret(
            "system:llm:last-by-category",
            &serde_json::to_string(&parsed).unwrap_or_default(),
        );
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_ai_assistant_model(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: self.get_or_default("system:ai-router:model", "gemini-3-pro"),
        }))
    }

    async fn set_ai_assistant_model(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let model = req.into_inner().value;
        let ok = self.vault.set_secret("system:ai-router:model", &model);
        Ok(Response::new(BoolRequest { value: ok }))
    }

    async fn get_ai_assistant_default(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: "gemini-3-pro".to_string(),
        }))
    }

    async fn get_available_ai_assistant_models(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 빌트인 carousel 에서 cli 제외 (assistant 는 fast/cheap 모델 우선)
        let models = crate::llm::config::builtin_models()
            .into_iter()
            .filter(|m| !m.format.starts_with("cli-"))
            .map(|m| serde_json::json!({"id": m.id, "displayName": m.display_name}))
            .collect::<Vec<_>>();
        json_response(&models)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    fn service() -> (SettingsServiceImpl, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        (SettingsServiceImpl::new(vault), dir)
    }

    #[tokio::test]
    async fn timezone_default_and_set() {
        let (svc, _dir) = service();
        let resp = svc.get_timezone(Request::new(Empty {})).await.unwrap();
        assert_eq!(resp.into_inner().value, "Asia/Seoul");

        svc.set_timezone(Request::new(StringRequest {
            value: "UTC".to_string(),
        }))
        .await
        .unwrap();
        let resp = svc.get_timezone(Request::new(Empty {})).await.unwrap();
        assert_eq!(resp.into_inner().value, "UTC");
    }

    #[tokio::test]
    async fn user_prompt_2000_chars_limit() {
        let (svc, _dir) = service();
        let too_long: String = "a".repeat(2001);
        let resp = svc
            .set_user_prompt(Request::new(StringRequest { value: too_long }))
            .await
            .unwrap();
        assert!(!resp.into_inner().value); // 거부
    }

    #[tokio::test]
    async fn anthropic_cache_toggle() {
        let (svc, _dir) = service();
        let resp = svc
            .get_anthropic_cache_enabled(Request::new(Empty {}))
            .await
            .unwrap();
        assert!(!resp.into_inner().value); // default false

        svc.set_anthropic_cache_enabled(Request::new(BoolRequest { value: true }))
            .await
            .unwrap();
        let resp = svc
            .get_anthropic_cache_enabled(Request::new(Empty {}))
            .await
            .unwrap();
        assert!(resp.into_inner().value);
    }
}

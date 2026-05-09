//! gRPC SettingsService impl — Vault `system:*` 키 직접 wrapper.
//!
//! 옛 TS Core facade 의 settings 메서드들 (timezone / aiModel / userPrompt / anthropicCache 등)
//! Rust 재현. Vault 위 thin wrapper — 어드민 설정 모달 backend.
//!
//! Step 3 (typed RPC) — GetAiModel / GetLastModelByCategory / GetAvailableAiAssistantModels
//! JsonValue 폐기 + typed proto message 사용.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IVaultPort;
use crate::proto::{
    settings_service_server::SettingsService, AiAssistantModelListPb, AiAssistantModelPb,
    AiModelResponsePb, AvailableAiModelListPb, AvailableAiModelPb, BoolRequest, Empty, JsonArgs,
    LastModelByCategoryPb, StringRequest,
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

    async fn get_ai_model(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<AiModelResponsePb>, TonicStatus> {
        let model = self.get_or_default("system:llm:model", "claude-sonnet-4-6");
        Ok(Response::new(AiModelResponsePb { model }))
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
    ) -> Result<Response<LastModelByCategoryPb>, TonicStatus> {
        let raw = self.get_or_default("system:llm:last-by-category", "{}");
        // valid JSON 인지 검증만 — 항상 정규화된 JSON 반환
        let raw_json = serde_json::from_str::<serde_json::Value>(&raw)
            .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string()))
            .unwrap_or_else(|_| "{}".to_string());
        Ok(Response::new(LastModelByCategoryPb { raw_json }))
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
            value: self.get_or_default(
                crate::vault_keys::VK_SYSTEM_AI_ASSISTANT_MODEL,
                crate::vault_keys::AI_ASSISTANT_DEFAULT_MODEL,
            ),
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
    ) -> Result<Response<AiAssistantModelListPb>, TonicStatus> {
        // 빌트인 carousel 에서 cli 제외 (assistant 는 fast/cheap 모델 우선)
        let models = crate::llm::config::builtin_models()
            .into_iter()
            .filter(|m| !m.format.starts_with("cli-"))
            .map(|m| AiAssistantModelPb {
                id: m.id,
                display_name: m.display_name,
            })
            .collect::<Vec<_>>();
        Ok(Response::new(AiAssistantModelListPb { models }))
    }

    /// 전체 AI 모델 carousel — frontend cascade UI single source.
    /// frontend types.ts AI_MODELS 박힌 게 fallback (Rust 호출 fail 시).
    async fn get_available_ai_models(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<AvailableAiModelListPb>, TonicStatus> {
        let models = crate::llm::config::builtin_models()
            .into_iter()
            .map(|m| AvailableAiModelPb {
                id: m.id,
                display_name: m.display_name,
                provider: m.provider,
                format: m.format,
            })
            .collect::<Vec<_>>();
        Ok(Response::new(AvailableAiModelListPb { models }))
    }
}

// Tests 이관 — `infra/tests/svc_settings_test.rs` (integration test).

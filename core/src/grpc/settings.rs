//! gRPC SettingsService impl — Vault `system:*` 키 직접 wrapper.
//!
//! 옛 TS Core facade 의 settings 메서드들 (timezone / aiModel / userPrompt / anthropicCache 등)
//! Rust 재현. Vault 위 thin wrapper — 어드민 설정 모달 backend.
//!
//! 매 RPC unique Request / Response — buf STANDARD 정공.
//! 옛 공유 타입 (StringRequest / BoolRequest / Empty 등) 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IVaultPort;
use crate::proto::{
    settings_service_server::SettingsService, AiAssistantModelPb, AvailableAiModelPb,
    SettingsGetAiAssistantDefaultRequest, SettingsGetAiAssistantDefaultResponse,
    SettingsGetAiAssistantModelRequest, SettingsGetAiAssistantModelResponse,
    SettingsGetAiModelRequest, SettingsGetAiModelResponse, SettingsGetAiThinkingLevelRequest,
    SettingsGetAiThinkingLevelResponse, SettingsGetAnthropicCacheEnabledRequest,
    SettingsGetAnthropicCacheEnabledResponse, SettingsGetAvailableAiAssistantModelsRequest,
    SettingsGetAvailableAiAssistantModelsResponse, SettingsGetAvailableAiModelsRequest,
    SettingsGetAvailableAiModelsResponse, SettingsGetLastModelByCategoryRequest,
    SettingsGetLastModelByCategoryResponse, SettingsGetTimezoneRequest,
    SettingsGetTimezoneResponse, SettingsGetUserPromptRequest, SettingsGetUserPromptResponse,
    SettingsSetAiAssistantModelRequest, SettingsSetAiAssistantModelResponse,
    SettingsSetAiModelRequest, SettingsSetAiModelResponse, SettingsSetAiThinkingLevelRequest,
    SettingsSetAiThinkingLevelResponse, SettingsSetAnthropicCacheEnabledRequest,
    SettingsSetAnthropicCacheEnabledResponse, SettingsSetLastModelByCategoryRequest,
    SettingsSetLastModelByCategoryResponse, SettingsSetTimezoneRequest,
    SettingsSetTimezoneResponse, SettingsSetUserPromptRequest, SettingsSetUserPromptResponse,
    ThinkingConfigPb, ThinkingLevelPb,
};
use crate::vault_keys::{
    DEFAULT_LLM_MODEL_FALLBACK, DEFAULT_THINKING_LEVEL, USER_PROMPT_MAX_CHARS,
    VK_LLM_ANTHROPIC_CACHE, VK_SYSTEM_AI_ASSISTANT_MODEL, VK_SYSTEM_AI_MODEL,
    VK_SYSTEM_AI_THINKING_LEVEL, VK_SYSTEM_LAST_MODEL_BY_CATEGORY, VK_SYSTEM_TIMEZONE,
    VK_SYSTEM_USER_PROMPT,
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
    async fn get_timezone(
        &self,
        _req: Request<SettingsGetTimezoneRequest>,
    ) -> Result<Response<SettingsGetTimezoneResponse>, TonicStatus> {
        Ok(Response::new(SettingsGetTimezoneResponse {
            timezone: self.get_or_default(VK_SYSTEM_TIMEZONE, "Asia/Seoul"),
        }))
    }

    async fn set_timezone(
        &self,
        req: Request<SettingsSetTimezoneRequest>,
    ) -> Result<Response<SettingsSetTimezoneResponse>, TonicStatus> {
        let tz = req.into_inner().timezone;
        let ok = self.vault.set_secret(VK_SYSTEM_TIMEZONE, &tz);
        Ok(Response::new(SettingsSetTimezoneResponse { ok }))
    }

    async fn get_ai_model(
        &self,
        _req: Request<SettingsGetAiModelRequest>,
    ) -> Result<Response<SettingsGetAiModelResponse>, TonicStatus> {
        let model = self.get_or_default(VK_SYSTEM_AI_MODEL, DEFAULT_LLM_MODEL_FALLBACK);
        Ok(Response::new(SettingsGetAiModelResponse { model }))
    }

    async fn set_ai_model(
        &self,
        req: Request<SettingsSetAiModelRequest>,
    ) -> Result<Response<SettingsSetAiModelResponse>, TonicStatus> {
        let model = req.into_inner().model;
        let ok = self.vault.set_secret(VK_SYSTEM_AI_MODEL, &model);
        Ok(Response::new(SettingsSetAiModelResponse { ok }))
    }

    async fn get_ai_thinking_level(
        &self,
        _req: Request<SettingsGetAiThinkingLevelRequest>,
    ) -> Result<Response<SettingsGetAiThinkingLevelResponse>, TonicStatus> {
        Ok(Response::new(SettingsGetAiThinkingLevelResponse {
            level: self.get_or_default(VK_SYSTEM_AI_THINKING_LEVEL, DEFAULT_THINKING_LEVEL),
        }))
    }

    async fn set_ai_thinking_level(
        &self,
        req: Request<SettingsSetAiThinkingLevelRequest>,
    ) -> Result<Response<SettingsSetAiThinkingLevelResponse>, TonicStatus> {
        let level = req.into_inner().level;
        let ok = self.vault.set_secret(VK_SYSTEM_AI_THINKING_LEVEL, &level);
        Ok(Response::new(SettingsSetAiThinkingLevelResponse { ok }))
    }

    async fn get_user_prompt(
        &self,
        _req: Request<SettingsGetUserPromptRequest>,
    ) -> Result<Response<SettingsGetUserPromptResponse>, TonicStatus> {
        Ok(Response::new(SettingsGetUserPromptResponse {
            prompt: self.get_or_default(VK_SYSTEM_USER_PROMPT, ""),
        }))
    }

    async fn set_user_prompt(
        &self,
        req: Request<SettingsSetUserPromptRequest>,
    ) -> Result<Response<SettingsSetUserPromptResponse>, TonicStatus> {
        let prompt = req.into_inner().prompt;
        // 옛 TS 와 동일 — USER_PROMPT_MAX_CHARS (2000자) 제한
        if prompt.chars().count() > USER_PROMPT_MAX_CHARS {
            return Ok(Response::new(SettingsSetUserPromptResponse { ok: false }));
        }
        let ok = self.vault.set_secret(VK_SYSTEM_USER_PROMPT, &prompt);
        Ok(Response::new(SettingsSetUserPromptResponse { ok }))
    }

    async fn get_anthropic_cache_enabled(
        &self,
        _req: Request<SettingsGetAnthropicCacheEnabledRequest>,
    ) -> Result<Response<SettingsGetAnthropicCacheEnabledResponse>, TonicStatus> {
        let enabled = self
            .vault
            .get_secret(VK_LLM_ANTHROPIC_CACHE)
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        Ok(Response::new(SettingsGetAnthropicCacheEnabledResponse {
            enabled,
        }))
    }

    async fn set_anthropic_cache_enabled(
        &self,
        req: Request<SettingsSetAnthropicCacheEnabledRequest>,
    ) -> Result<Response<SettingsSetAnthropicCacheEnabledResponse>, TonicStatus> {
        let enabled = req.into_inner().enabled;
        let value = if enabled { "true" } else { "false" };
        let ok = self.vault.set_secret(VK_LLM_ANTHROPIC_CACHE, value);
        Ok(Response::new(SettingsSetAnthropicCacheEnabledResponse { ok }))
    }

    async fn get_last_model_by_category(
        &self,
        _req: Request<SettingsGetLastModelByCategoryRequest>,
    ) -> Result<Response<SettingsGetLastModelByCategoryResponse>, TonicStatus> {
        let raw = self.get_or_default(VK_SYSTEM_LAST_MODEL_BY_CATEGORY, "{}");
        // valid JSON 인지 검증만 — 항상 정규화된 JSON 반환
        let raw_json = serde_json::from_str::<serde_json::Value>(&raw)
            .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string()))
            .unwrap_or_else(|_| "{}".to_string());
        Ok(Response::new(SettingsGetLastModelByCategoryResponse {
            raw_json,
        }))
    }

    async fn set_last_model_by_category(
        &self,
        req: Request<SettingsSetLastModelByCategoryRequest>,
    ) -> Result<Response<SettingsSetLastModelByCategoryResponse>, TonicStatus> {
        let args = req.into_inner();
        // valid JSON 검증 후 저장
        let parsed: serde_json::Value = match serde_json::from_str(&args.by_category_json) {
            Ok(v) => v,
            Err(_) => {
                return Ok(Response::new(SettingsSetLastModelByCategoryResponse {
                    ok: false,
                }));
            }
        };
        let ok = self.vault.set_secret(
            VK_SYSTEM_LAST_MODEL_BY_CATEGORY,
            &serde_json::to_string(&parsed).unwrap_or_default(),
        );
        Ok(Response::new(SettingsSetLastModelByCategoryResponse { ok }))
    }

    async fn get_ai_assistant_model(
        &self,
        _req: Request<SettingsGetAiAssistantModelRequest>,
    ) -> Result<Response<SettingsGetAiAssistantModelResponse>, TonicStatus> {
        Ok(Response::new(SettingsGetAiAssistantModelResponse {
            model: self.get_or_default(
                VK_SYSTEM_AI_ASSISTANT_MODEL,
                crate::llm::registry::assistant_default_model(),
            ),
        }))
    }

    async fn set_ai_assistant_model(
        &self,
        req: Request<SettingsSetAiAssistantModelRequest>,
    ) -> Result<Response<SettingsSetAiAssistantModelResponse>, TonicStatus> {
        let model = req.into_inner().model;
        let ok = self.vault.set_secret(VK_SYSTEM_AI_ASSISTANT_MODEL, &model);
        Ok(Response::new(SettingsSetAiAssistantModelResponse { ok }))
    }

    async fn get_ai_assistant_default(
        &self,
        _req: Request<SettingsGetAiAssistantDefaultRequest>,
    ) -> Result<Response<SettingsGetAiAssistantDefaultResponse>, TonicStatus> {
        Ok(Response::new(SettingsGetAiAssistantDefaultResponse {
            model: crate::llm::registry::assistant_default_model().to_string(),
        }))
    }

    async fn get_available_ai_assistant_models(
        &self,
        _req: Request<SettingsGetAvailableAiAssistantModelsRequest>,
    ) -> Result<Response<SettingsGetAvailableAiAssistantModelsResponse>, TonicStatus> {
        // models.json `assistantModels` 지정 목록을 단일 소스로. 미지정 시 non-CLI 전체로 폴백.
        let all = crate::llm::config::builtin_models();
        let allowed = crate::llm::registry::assistant_models();
        let models = if allowed.is_empty() {
            all.into_iter()
                .filter(|m| !m.format.starts_with("cli-"))
                .map(|m| AiAssistantModelPb {
                    id: m.id,
                    display_name: m.display_name,
                })
                .collect::<Vec<_>>()
        } else {
            // 지정 순서 보존, display_name 은 레지스트리 lookup.
            allowed
                .iter()
                .filter_map(|id| {
                    all.iter().find(|m| &m.id == id).map(|m| AiAssistantModelPb {
                        id: m.id.clone(),
                        display_name: m.display_name.clone(),
                    })
                })
                .collect::<Vec<_>>()
        };
        Ok(Response::new(
            SettingsGetAvailableAiAssistantModelsResponse { models },
        ))
    }

    /// 전체 AI 모델 carousel — frontend cascade UI single source.
    /// frontend types.ts AI_MODELS 가 fallback (Rust 호출 fail 시 사용).
    async fn get_available_ai_models(
        &self,
        _req: Request<SettingsGetAvailableAiModelsRequest>,
    ) -> Result<Response<SettingsGetAvailableAiModelsResponse>, TonicStatus> {
        let models = crate::llm::config::builtin_models()
            .into_iter()
            .map(|m| AvailableAiModelPb {
                id: m.id,
                display_name: m.display_name,
                provider: m.provider,
                format: m.format,
                thinking: m.thinking.map(|t| ThinkingConfigPb {
                    kind: t.kind,
                    levels: t
                        .levels
                        .into_iter()
                        .map(|l| ThinkingLevelPb {
                            value: l.value,
                            labels: l.labels,
                        })
                        .collect(),
                }),
                exec_mode: m.exec_mode,
                cli_provider: m.cli_provider.unwrap_or_default(),
                category: m.category,
            })
            .collect::<Vec<_>>();
        Ok(Response::new(SettingsGetAvailableAiModelsResponse {
            models,
        }))
    }
}

// Tests 이관 — `infra/tests/svc_settings_test.rs` (integration test).

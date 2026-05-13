//! Vault key constants — 옛 TS `core/vault-keys.ts` 의 Rust port.
//!
//! 모든 vault key 의 single source of truth — magic string hardcode 회피.
//! Phase B 진행하며 매니저별 key 추가.

pub const VK_SYSTEM_TIMEZONE: &str = "system:timezone";
/// LLM 메인 모델 — 실 Vault 저장 키 `system:llm:model`.
pub const VK_SYSTEM_AI_MODEL: &str = "system:llm:model";
/// LLM 사고 깊이 — 실 Vault 저장 키 `system:llm:thinking-level`.
pub const VK_SYSTEM_AI_THINKING_LEVEL: &str = "system:llm:thinking-level";
pub const VK_SYSTEM_USER_PROMPT: &str = "system:user-prompt";
pub const VK_SYSTEM_AI_ASSISTANT_MODEL: &str = "system:ai-router:model";
/// AI Assistant 토글 — Vault 의 `'true'` / `'1'` 만 ON. ToolRouter 가 이 키 검사.
pub const VK_SYSTEM_AI_ROUTER_ENABLED: &str = "system:ai-router:enabled";
/// AI Assistant default 모델 — Vault 미설정 시 폴백. 사용자 결정 (2026-05-09):
/// Gemini 3.1 Flash Lite (저렴·빠름) — Tool Router / search_history 보조용으로 적합.
/// `LlmModelConfig.builtin_models` 에 등록되어야 함 (config.rs).
pub const AI_ASSISTANT_DEFAULT_MODEL: &str = "gemini-3.1-flash-lite";
pub const VK_LLM_ANTHROPIC_CACHE: &str = "system:llm:anthropic-cache";
/// 카테고리별 마지막 선택 모델 — 실 Vault 저장 키 `system:llm:last-by-category`.
pub const VK_SYSTEM_LAST_MODEL_BY_CATEGORY: &str = "system:llm:last-by-category";
pub const VK_ADMIN_ID: &str = "FIREBAT_ADMIN_ID";
pub const VK_ADMIN_PASSWORD: &str = "FIREBAT_ADMIN_PASSWORD";

/// 메인 LLM 모델 미설정 시 폴백 — settings.rs get_ai_model 기본값 single source.
pub const DEFAULT_LLM_MODEL_FALLBACK: &str = "claude-sonnet-4-6";
/// 사고 수준 미설정 시 폴백 — settings.rs get_ai_thinking_level 기본값 single source.
pub const DEFAULT_THINKING_LEVEL: &str = "medium";
/// 사용자 지시사항 최대 글자 수 — settings.rs + frontend SettingsModal 공통 single source.
pub const USER_PROMPT_MAX_CHARS: usize = 2000;

/// LLM 비용 예산 설정 — 일/월 한도 + 알림 threshold. CostManager.
pub const VK_COST_BUDGET: &str = "system:cost:budget";

/// 세션 토큰 Vault key 접두사 — `auth:session:<token>` 형식. AuthManager / VaultAuthAdapter.
pub const AUTH_SESSION_PREFIX: &str = "auth:session:";

pub const USER_SECRET_PREFIX: &str = "user:";

/// 사용자 시크릿 key — `user:<name>` 형식. AI 가 모듈 호출 시 이 prefix 의 시크릿 자동 주입.
pub fn vk_user_secret(name: &str) -> String {
    format!("{}{}", USER_SECRET_PREFIX, name)
}

/// Capability 설정 key — `system:capability:<id>:settings` 형식. CapabilityManager 가 사용.
pub fn vk_capability_settings(cap_id: &str) -> String {
    format!("system:capability:{}:settings", cap_id)
}

/// Module 설정 key — `system:module:<name>:settings` 형식. ModuleManager / CapabilityManager 가 활성화 검사 시 사용.
pub fn vk_module_settings(name: &str) -> String {
    format!("system:module:{}:settings", name)
}

// Phase B-18 Step 2d 설정 — MediaManager 의 이미지 모델·기본값 (옛 TS 1:1).
pub const VK_IMAGE_MODEL: &str = "system:image-model";
pub const VK_IMAGE_SIZE: &str = "system:image-size";
pub const VK_IMAGE_QUALITY: &str = "system:image-quality";

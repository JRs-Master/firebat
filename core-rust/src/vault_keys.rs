//! Vault key constants — 옛 TS `core/vault-keys.ts` 의 Rust port.
//!
//! 모든 vault key 의 single source of truth — magic string hardcode 회피.
//! Phase B 진행하며 매니저별 key 추가.

pub const VK_SYSTEM_TIMEZONE: &str = "system:timezone";
pub const VK_SYSTEM_AI_MODEL: &str = "system:ai-model";
pub const VK_SYSTEM_AI_THINKING_LEVEL: &str = "system:ai-thinking-level";
pub const VK_SYSTEM_USER_PROMPT: &str = "system:user-prompt";
pub const VK_SYSTEM_AI_ASSISTANT_MODEL: &str = "system:ai-router:model";
pub const VK_LLM_ANTHROPIC_CACHE: &str = "system:llm:anthropic-cache";
pub const VK_SYSTEM_LAST_MODEL_BY_CATEGORY: &str = "system:last-model-by-category";
pub const VK_ADMIN_ID: &str = "FIREBAT_ADMIN_ID";
pub const VK_ADMIN_PASSWORD: &str = "FIREBAT_ADMIN_PASSWORD";

pub const USER_SECRET_PREFIX: &str = "user:";

/// 사용자 시크릿 key — `user:<name>` 형식. AI 가 모듈 호출 시 이 prefix 의 시크릿 자동 주입.
pub fn vk_user_secret(name: &str) -> String {
    format!("{}{}", USER_SECRET_PREFIX, name)
}

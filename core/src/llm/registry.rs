//! LLM model registry — Phase 5 정공 (2026-05-13).
//!
//! 옛 `builtin_models()` 의 Rust 하드코드 폐기. JSON 파일 (`system/llm/models.json`) 에서
//! 로드 → infra 가 startup 에 본 모듈의 `init()` 호출 → core 매니저들이 `registry()` 로 접근.
//!
//! BIBLE Hexagonal 준수 — core 는 파일 I/O 0. infra 가 로드 + 본 모듈 OnceLock 채움.
//!
//! 사용:
//!   // infra/src/main.rs 시작 부분:
//!   firebat_core::llm::registry::init(loaded_registry);
//!
//!   // core/manager 안:
//!   let registry = firebat_core::llm::registry::current();
//!   let model = registry.find_model("gemini-3.1-flash-lite");
//!
//! 새 모델 추가:
//!   1. system/llm/models.json 수정 (모델 entry 추가)
//!   2. systemctl restart firebat (재빌드 0)
//!
//! 새 default assistant model:
//!   1. JSON 의 `default_assistant_model` 변경
//!   2. restart

use crate::llm::config::LlmModelConfig;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// LLM 모델 + assistant default — JSON 산출물 schema. infra 가 파일 파싱 후 인스턴스 생성.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRegistry {
    /// AI Assistant default model — Vault 미설정 시 폴백.
    pub default_assistant_model: String,
    pub models: Vec<LlmModelConfig>,
}

impl LlmRegistry {
    /// 모델 id 로 검색.
    pub fn find_model(&self, id: &str) -> Option<&LlmModelConfig> {
        self.models.iter().find(|m| m.id == id)
    }
}

/// process-wide 단일 instance. infra 의 main.rs 가 startup 에 채움.
static REGISTRY: OnceLock<LlmRegistry> = OnceLock::new();

/// Registry 초기화 — infra 가 startup 에 1회 호출. 두 번째 호출은 무시 (이미 설정됨).
pub fn init(reg: LlmRegistry) {
    let _ = REGISTRY.set(reg);
}

/// 현재 registry 접근. infra `init` 미호출 시 빈 폴백 반환 (테스트 + early boot 안전망).
///
/// 운영 코드는 항상 init 후 호출. 빈 폴백 = 모델 list 0 / default = `gemini-3.1-flash-lite`.
pub fn current() -> &'static LlmRegistry {
    REGISTRY.get_or_init(|| LlmRegistry {
        models: Vec::new(),
        default_assistant_model: "gemini-3.1-flash-lite".to_string(),
    })
}

/// builtin_models 옛 호환 — registry().models clone. 핫 코드 X 라 clone 부담 0.
pub fn builtin_models() -> Vec<LlmModelConfig> {
    current().models.clone()
}

/// AI Assistant default model — 옛 `vault_keys::AI_ASSISTANT_DEFAULT_MODEL` 대체.
pub fn assistant_default_model() -> &'static str {
    &current().default_assistant_model
}

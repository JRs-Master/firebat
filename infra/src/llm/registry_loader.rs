//! LLM model registry JSON loader — Phase 5 정공 (2026-05-13).
//!
//! `system/llm/models.json` 파일 → `firebat_core::llm::registry::LlmRegistry` 로드.
//! infra crate 만 파일 I/O 책임 (BIBLE Hexagonal).
//!
//! main.rs 가 startup 에 `init_from_file()` 1회 호출 → core registry 채움.
//!
//! 파일 위치 override: env `FIREBAT_LLM_MODELS_PATH`. 기본 = workspace root 기준 system/llm/models.json
//! 후보 chain. (옛 위치 `infra/data/llm-models.json` 도 fallback 으로 잠시 보존 — 운영 서버
//! 갱신 race 보호. 2026-06+ 제거 안전.)

use firebat_core::llm::registry::{init, LlmRegistry};
use std::path::PathBuf;

/// 옛 builtin_models() 호환 — 폴백 stub registry (모델 0개, default = gemini-3.1-flash-lite).
fn stub_registry() -> LlmRegistry {
    LlmRegistry {
        default_assistant_model: "gemini-3.1-flash-lite".to_string(),
        assistant_models: Vec::new(),
        default_library_extraction_model: "gemini-3.5-flash".to_string(),
        library_extraction_pro_model: "gemini-3.1-pro-preview".to_string(),
        models: Vec::new(),
    }
    // 실제 값은 models.json 에서 로드 — 이건 파일 부재 시 폴백 stub.
}

/// 표준 위치 후보 — env override 또는 CWD-relative fallback chain.
fn default_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Ok(env_path) = std::env::var("FIREBAT_LLM_MODELS_PATH") {
        paths.push(PathBuf::from(env_path));
    }
    // 개발 환경 — workspace root 기준 (새 위치)
    paths.push(PathBuf::from("system/llm/models.json"));
    // production 운영 — 설치 디렉토리 (새 위치)
    paths.push(PathBuf::from("/opt/firebat/system/llm/models.json"));
    // 옛 위치 — 운영 서버 갱신 race 보호 fallback
    paths.push(PathBuf::from("infra/data/llm-models.json"));
    paths.push(PathBuf::from("/opt/firebat/infra/data/llm-models.json"));
    paths.push(PathBuf::from("data/llm-models.json"));
    paths
}

/// 파일에서 LlmRegistry 로드 후 core::llm::registry::init 호출.
///
/// 실패 시 stub registry 로 fallback + 에러 로그 (panic X — 운영 안정성). 진단:
/// `FIREBAT_LLM_MODELS_PATH=/path/llm-models.json` env 로 명시 가능.
pub fn init_from_file() {
    for path in default_paths() {
        if !path.exists() {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<LlmRegistry>(&text) {
                Ok(reg) => {
                    tracing::info!(
                        path = %path.display(),
                        models = reg.models.len(),
                        default = %reg.default_assistant_model,
                        "LLM registry 로드 완료"
                    );
                    init(reg);
                    return;
                }
                Err(e) => {
                    tracing::error!(
                        path = %path.display(),
                        error = %e,
                        "LLM registry JSON 파싱 실패 — 다음 후보 시도"
                    );
                }
            },
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "LLM registry 읽기 실패 — 다음 후보");
            }
        }
    }
    tracing::warn!("LLM registry JSON 미발견 — stub registry 폴백 (모델 0). FIREBAT_LLM_MODELS_PATH env 으로 명시 가능");
    init(stub_registry());
}

//! Image generation — IImageGenPort 의 ConfigDrivenAdapter 패턴 모듈.
//!
//! 옛 TS `infra/image/` 1:1 port. LLM 모듈 (`crate::llm`) 과 병렬 구조:
//!   - `config.rs` — ImageGenModelConfig + Registry + computeImageCost
//!   - `format_handler.rs` — ImageFormatHandler trait
//!   - `formats/` — openai_image / gemini_native_image / cli_codex_image
//!   - `adapter.rs` — ConfigDrivenImageGenAdapter (IImageGenPort 구현)
//!   - `configs/*.json` — builtin carousel (빌드 타임 박힘)
//!
//! 사용:
//!   ```ignore
//!   let adapter = ConfigDrivenImageGenAdapter::with_configs_dir(
//!       vault.clone(),
//!       "gpt-image-1".to_string(),
//!       Some(Path::new("system/image/configs")),
//!   );
//!   ```
//!
//! 새 모델 도입 시:
//!   - 기존 format 재사용 → JSON 파일 1개 (`configs/<id>.json`) 추가만
//!   - 신규 format → `formats/<format>.rs` + adapter.rs 의 `handlers` 등록

pub mod adapter;
pub mod config;
pub mod format_handler;
pub mod formats;

pub use adapter::ConfigDrivenImageGenAdapter;
pub use config::{
    build_registry, builtin_configs, compute_image_cost, ImageGenFormat, ImageGenModelConfig,
    ImageGenRegistry,
};
pub use format_handler::{ImageFormatHandler, ImageFormatHandlerContext};

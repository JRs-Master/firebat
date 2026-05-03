//! StubImageGenAdapter — 진짜 ConfigDrivenImageGenAdapter 박기 전 wiring 어댑터.
//!
//! Step 2c 에서 4 format (openai / gemini / codex CLI / 추가 provider) 으로 swap.
//! 그 시점엔 IImageGenPort 인터페이스 그대로 — main.rs env 토글 한 줄로 활성.
//!
//! 현재 동작:
//!   - get_model_id: 고정 "stub-image"
//!   - list_models: 단일 stub 모델 1개
//!   - generate: 1x1 회색 PNG + revised_prompt 그대로 + cost_usd None (구독 흉내)
//!
//! 사용처 — wiring 검증 + tool_registry image_gen 도구 e2e (real network 의존성 0).

use crate::ports::{
    IImageGenPort, ImageGenCallOpts, ImageGenOpts, ImageGenResult, ImageModelInfo, InfraResult,
};

/// 1x1 grey PNG — image_processor::stub 과 동일. 단순 valid PNG 바이트열.
const STUB_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x08, 0x99, 0x63, 0xF8, 0xCF, 0xCF, 0xCF, 0x07, 0x00, 0x03, 0x10, 0x01, 0x01, 0xC8, 0xD8,
    0x9F, 0x03, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

const STUB_MODEL_ID: &str = "stub-image";

#[derive(Debug, Default)]
pub struct StubImageGenAdapter;

impl StubImageGenAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl IImageGenPort for StubImageGenAdapter {
    fn get_model_id(&self) -> String {
        STUB_MODEL_ID.to_string()
    }

    fn list_models(&self) -> Vec<ImageModelInfo> {
        vec![ImageModelInfo {
            id: STUB_MODEL_ID.to_string(),
            display_name: "Stub Image (1x1 grey)".to_string(),
            provider: "stub".to_string(),
            format: "stub".to_string(),
            requires_organization_verification: None,
            sizes: vec!["1x1".to_string()],
            qualities: vec!["standard".to_string()],
            subscription: Some(true), // 비용 0
        }]
    }

    async fn generate(
        &self,
        opts: &ImageGenOpts,
        _call_opts: &ImageGenCallOpts,
    ) -> InfraResult<ImageGenResult> {
        if opts.prompt.trim().is_empty() {
            return Err("이미지 생성 prompt 비어있음".to_string());
        }
        Ok(ImageGenResult {
            binary: STUB_PNG.to_vec(),
            content_type: "image/png".to_string(),
            width: Some(1),
            height: Some(1),
            revised_prompt: Some(opts.prompt.clone()),
            cost_usd: None, // stub = 구독 흉내, 비용 미박음
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_generate_returns_png() {
        let g = StubImageGenAdapter::new();
        let result = g
            .generate(
                &ImageGenOpts {
                    prompt: "고양이".to_string(),
                    ..Default::default()
                },
                &ImageGenCallOpts::default(),
            )
            .await
            .unwrap();
        assert_eq!(result.content_type, "image/png");
        assert_eq!(&result.binary[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(result.cost_usd, None);
        assert_eq!(result.revised_prompt.as_deref(), Some("고양이"));
    }

    #[tokio::test]
    async fn stub_generate_empty_prompt_errors() {
        let g = StubImageGenAdapter::new();
        let r = g
            .generate(
                &ImageGenOpts {
                    prompt: "".to_string(),
                    ..Default::default()
                },
                &ImageGenCallOpts::default(),
            )
            .await;
        assert!(r.is_err());
    }

    #[test]
    fn stub_list_models_returns_single() {
        let g = StubImageGenAdapter::new();
        let models = g.list_models();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "stub-image");
    }
}

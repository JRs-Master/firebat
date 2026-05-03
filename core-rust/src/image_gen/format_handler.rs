//! ImageFormatHandler trait — format 별 어댑터의 공통 인터페이스.
//!
//! 옛 TS `infra/image/format-handler.ts` 1:1 port.

use async_trait::async_trait;

use crate::image_gen::config::ImageGenModelConfig;
use crate::ports::{ImageGenCallOpts, ImageGenOpts, ImageGenResult, InfraResult};

/// Handler 가 generate 시 받는 컨텍스트 — config + API 키 resolver.
pub struct ImageFormatHandlerContext<'a> {
    pub config: &'a ImageGenModelConfig,
    /// Vault 등에서 API 키 lazy resolve. 미설정 시 None.
    pub resolve_api_key: Box<dyn Fn() -> Option<String> + Send + Sync + 'a>,
}

#[async_trait]
pub trait ImageFormatHandler: Send + Sync {
    async fn generate(
        &self,
        opts: &ImageGenOpts,
        call_opts: &ImageGenCallOpts,
        ctx: ImageFormatHandlerContext<'_>,
    ) -> InfraResult<ImageGenResult>;
}

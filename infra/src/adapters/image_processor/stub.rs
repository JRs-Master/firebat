//! StubImageProcessorAdapter — 진짜 image-rs / blurhash 박기 전 wiring 어댑터.
//!
//! Step 2b 에서 ImageRsProcessorAdapter (image-rs + fast_image_resize + blurhash crate) 로 swap.
//! 그 시점엔 IImageProcessorPort 인터페이스 그대로 — main.rs env 토글 한 줄로 활성.
//!
//! 현재 동작:
//!   - get_metadata: image::guess_format 없이 단순 `bytes` 만 반환 (width/height = 0).
//!   - process: binary 그대로 반환 (format 변환 X).
//!   - blurhash: 고정 회색 LQIP 문자열.
//!   - create_placeholder: 1x1 회색 PNG (최소 valid PNG 바이트).
//!
//! 사용처 — wiring 검증 + 단위 테스트. 실 운영에는 ImageRsProcessorAdapter 박을 것.

use firebat_core::ports::{IImageProcessorPort, ImageMetadata, InfraResult, ResizeOpts};

/// 1x1 grey PNG — 최소 valid PNG 바이트열. placeholder default.
/// 8비트 RGB grey (0x80, 0x80, 0x80) + zlib deflate + IDAT/IEND.
const GREY_1X1_PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, // IHDR length (13)
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x02, // 8-bit RGB
    0x00, 0x00, 0x00, // compression / filter / interlace
    0x90, 0x77, 0x53, 0xDE, // CRC
    0x00, 0x00, 0x00, 0x0C, // IDAT length (12)
    0x49, 0x44, 0x41, 0x54, // "IDAT"
    0x08, 0x99, 0x63, 0xF8, 0xCF, 0xCF, 0xCF, 0x07, 0x00, 0x03, 0x10, 0x01, 0x01, // zlib + grey RGB
    0xC8, 0xD8, 0x9F, 0x03, // CRC (placeholder — image-rs swap 시 정확 byte 박음)
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4E, 0x44, // "IEND"
    0xAE, 0x42, 0x60, 0x82, // CRC
];

/// Stub blurhash — Step 2b ImageRsProcessorAdapter 박힐 때까지 placeholder.
/// 4x4 base83 회색 (옛 TS `LEHV6nWB2yk8pyo0adR*.7kCMdnj` 같은 형식 흉내).
const STUB_BLURHASH: &str = "L00000fQfQfQfQfQfQfQfQfQfQfQ";

#[derive(Debug, Default)]
pub struct StubImageProcessorAdapter;

impl StubImageProcessorAdapter {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl IImageProcessorPort for StubImageProcessorAdapter {
    async fn get_metadata(&self, binary: &[u8]) -> InfraResult<ImageMetadata> {
        // bytes 만 알고 width/height/format 미감지 — Step 2b 에서 image::io::Reader 박을 것.
        Ok(ImageMetadata {
            width: 0,
            height: 0,
            format: "unknown".to_string(),
            bytes: binary.len() as u64,
            has_alpha: None,
        })
    }

    async fn process(&self, binary: &[u8], _opts: &ResizeOpts) -> InfraResult<Vec<u8>> {
        // no-op — 원본 binary 그대로 반환. Step 2b 에서 fast_image_resize + image-rs 처리.
        Ok(binary.to_vec())
    }

    async fn blurhash(
        &self,
        _binary: &[u8],
        _components: Option<(u32, u32)>,
    ) -> InfraResult<String> {
        Ok(STUB_BLURHASH.to_string())
    }

    async fn create_placeholder(&self, _width: u32, _height: u32) -> InfraResult<Vec<u8>> {
        // Stub — 1x1 회색 PNG 반환. Step 2b 에서 실제 width/height 회색 사각형 박음.
        Ok(GREY_1X1_PNG.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_get_metadata_returns_bytes() {
        let p = StubImageProcessorAdapter::new();
        let m = p.get_metadata(&[1, 2, 3, 4, 5]).await.unwrap();
        assert_eq!(m.bytes, 5);
        assert_eq!(m.format, "unknown");
    }

    #[tokio::test]
    async fn stub_process_returns_input_unchanged() {
        let p = StubImageProcessorAdapter::new();
        let input = vec![10, 20, 30];
        let out = p.process(&input, &ResizeOpts::default()).await.unwrap();
        assert_eq!(out, input);
    }

    #[tokio::test]
    async fn stub_blurhash_returns_grey() {
        let p = StubImageProcessorAdapter::new();
        let h = p.blurhash(&[], None).await.unwrap();
        assert!(h.starts_with("L00000"));
    }

    #[tokio::test]
    async fn stub_placeholder_returns_valid_png_signature() {
        let p = StubImageProcessorAdapter::new();
        let png = p.create_placeholder(100, 100).await.unwrap();
        // PNG magic bytes
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    }
}

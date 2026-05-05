//! ImageRsProcessorAdapter — image-rs + fast_image_resize + blurhash crate 기반.
//!
//! 옛 TS `infra/image-processor/sharp-adapter.ts` (sharp/libvips) 1:1 port.
//! Rust 측에서는 image-rs (decode/encode) + fast_image_resize (SIMD 가속 resize) +
//! blurhash crate (Base83 LQIP) 조합. CPU 만 — Windows / Linux / macOS 모두 동작.
//!
//! 지원 포맷 (현재 enabled): png / jpeg / webp.
//! avif: image-rs 의 avif feature 박는 순간 ravif crate (libdav1d) 빌드 의존성 큼 → 후속 commit
//! 에서 사용자 트리거 시 (자동매매 운영 중 avif 필요성 도달 시) 박을 예정.

use std::io::Cursor;

use blurhash::encode as blurhash_encode;
use fast_image_resize::images::Image as FirImage;
use fast_image_resize::{PixelType, Resizer};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::{
    DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat as ImgRsFormat, ImageReader,
    RgbaImage,
};

use firebat_core::ports::{
    CropPosition, FitMode, IImageProcessorPort, ImageFormat, ImageMetadata, InfraResult,
    ResizeOpts,
};

#[derive(Debug, Default)]
pub struct ImageRsProcessorAdapter;

impl ImageRsProcessorAdapter {
    pub fn new() -> Self {
        Self
    }

    /// image-rs 의 ImageReader 로 decode — 자동 포맷 감지.
    fn decode(binary: &[u8]) -> Result<DynamicImage, String> {
        let cursor = Cursor::new(binary);
        let reader = ImageReader::new(cursor)
            .with_guessed_format()
            .map_err(|e| format!("이미지 포맷 감지 실패: {e}"))?;
        reader
            .decode()
            .map_err(|e| format!("이미지 decode 실패: {e}"))
    }

    /// image-rs format → string (옛 TS sharp.metadata().format 1:1).
    fn format_str(fmt: ImgRsFormat) -> &'static str {
        match fmt {
            ImgRsFormat::Png => "png",
            ImgRsFormat::Jpeg => "jpeg",
            ImgRsFormat::WebP => "webp",
            ImgRsFormat::Gif => "gif",
            ImgRsFormat::Avif => "avif",
            ImgRsFormat::Bmp => "bmp",
            ImgRsFormat::Tiff => "tiff",
            ImgRsFormat::Ico => "ico",
            _ => "unknown",
        }
    }

    /// fit + position → fast_image_resize 의 SrcCropping 변환.
    /// 'attention' / 'entropy' 는 image-rs 자체 미지원 → 일반 로직: center fallback.
    /// (옛 TS sharp 의 libvips saliency 등가 미존재. 향후 saliency crate 추가 시 swap.)
    fn compute_crop_box(
        src_w: u32,
        src_h: u32,
        target_w: u32,
        target_h: u32,
        position: &Option<CropPosition>,
    ) -> (u32, u32, u32, u32) {
        // target ratio 와 src ratio 비교 → cover 시 crop 영역 산정.
        let src_ratio = src_w as f32 / src_h as f32;
        let tgt_ratio = target_w as f32 / target_h as f32;

        let (crop_w, crop_h) = if src_ratio > tgt_ratio {
            // src 가 가로로 더 김 → 가로 crop
            ((src_h as f32 * tgt_ratio) as u32, src_h)
        } else {
            // src 가 세로로 더 김 → 세로 crop
            (src_w, (src_w as f32 / tgt_ratio) as u32)
        };

        // position 에 따라 crop 시작점 (x, y) 산정.
        // 일반 로직: 모든 position → focus(x, y) 정규화 후 ratio 기반 산정.
        let (fx, fy) = match position {
            Some(CropPosition::Focus { x, y }) => (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)),
            // attention / entropy / center / 미박음 → 정중앙 (일반 로직 — 향후 entropy 박을 때 분기)
            _ => (0.5, 0.5),
        };

        let max_x = src_w.saturating_sub(crop_w);
        let max_y = src_h.saturating_sub(crop_h);
        let x = (max_x as f32 * fx) as u32;
        let y = (max_y as f32 * fy) as u32;
        (x, y, crop_w, crop_h)
    }

    /// fast_image_resize 로 RgbaImage → 새 크기 RgbaImage.
    /// fast_image_resize 의 `image` feature 가 RgbaImage 의 IntoImageView impl 자동 박음.
    fn fir_resize(src: &RgbaImage, new_w: u32, new_h: u32) -> Result<RgbaImage, String> {
        let mut dst = FirImage::new(new_w, new_h, PixelType::U8x4);
        let mut resizer = Resizer::new();
        resizer
            .resize(src, &mut dst, None)
            .map_err(|e| format!("fast_image_resize: {e}"))?;
        let buf = dst.into_vec();
        RgbaImage::from_raw(new_w, new_h, buf)
            .ok_or_else(|| "RgbaImage::from_raw 실패".to_string())
    }

    /// image-rs FilterType (legacy resize) — fit=inside fallback 시.
    fn _filter_inside() -> FilterType {
        FilterType::Lanczos3
    }
}

#[async_trait::async_trait]
impl IImageProcessorPort for ImageRsProcessorAdapter {
    async fn get_metadata(&self, binary: &[u8]) -> InfraResult<ImageMetadata> {
        let cursor = Cursor::new(binary);
        let reader = ImageReader::new(cursor)
            .with_guessed_format()
            .map_err(|e| format!("이미지 포맷 감지 실패: {e}"))?;
        let format = reader
            .format()
            .map(Self::format_str)
            .unwrap_or("unknown")
            .to_string();
        let dims = reader
            .into_dimensions()
            .map_err(|e| format!("이미지 dimensions 파싱 실패: {e}"))?;
        // alpha 감지 — color type 정확 파싱은 별도 decode 필요. 현재는 미파싱 (None).
        // 향후 사용자가 alpha 정보 의존하는 시점에 decode 도입.
        Ok(ImageMetadata {
            width: dims.0,
            height: dims.1,
            format,
            bytes: binary.len() as u64,
            has_alpha: None,
        })
    }

    async fn process(&self, binary: &[u8], opts: &ResizeOpts) -> InfraResult<Vec<u8>> {
        let img = Self::decode(binary)?;
        // strip_metadata: image-rs 의 ImageReader 자체가 EXIF 보존 안 함 → strip 자동.
        // (옛 TS sharp 도 default strip — withMetadata 호출 안 하면 제거. 동일 동작.)
        let mut rgba = img.to_rgba8();
        let (src_w, src_h) = (rgba.width(), rgba.height());

        // resize — width / height 박혔을 때
        let target_w = opts.width;
        let target_h = opts.height;
        if target_w.is_some() || target_h.is_some() {
            let fit = opts.fit.clone().unwrap_or(FitMode::Inside);
            let (final_w, final_h) = compute_target_dims(src_w, src_h, target_w, target_h, &fit);

            match fit {
                FitMode::Cover | FitMode::Outside => {
                    // 1단계: position 기반 crop (cover/outside 시만 의미)
                    let (cx, cy, cw, ch) =
                        Self::compute_crop_box(src_w, src_h, final_w, final_h, &opts.position);
                    let cropped = image::imageops::crop_imm(&rgba, cx, cy, cw, ch).to_image();
                    // 2단계: 최종 크기로 resize (SIMD 가속)
                    rgba = Self::fir_resize(&cropped, final_w, final_h)?;
                }
                FitMode::Fill => {
                    rgba = Self::fir_resize(&rgba, final_w, final_h)?;
                }
                FitMode::Contain | FitMode::Inside => {
                    // contain/inside — aspect 보존 + withoutEnlargement
                    let no_enlarge = (final_w > src_w) || (final_h > src_h);
                    if no_enlarge && matches!(fit, FitMode::Inside) {
                        // 원본보다 크게 resize 안 함 (옛 TS withoutEnlargement: true 1:1)
                    } else {
                        rgba = Self::fir_resize(&rgba, final_w, final_h)?;
                    }
                }
            }
        }

        // 포맷 변환 + 인코딩
        let format = opts.format.clone().unwrap_or_else(|| {
            // 미박음 시 원본 포맷 유지 — image-rs format 추정
            let cursor = Cursor::new(binary);
            ImageReader::new(cursor)
                .with_guessed_format()
                .ok()
                .and_then(|r| r.format())
                .map(|f| match f {
                    ImgRsFormat::Png => ImageFormat::Png,
                    ImgRsFormat::Jpeg => ImageFormat::Jpeg,
                    ImgRsFormat::WebP => ImageFormat::Webp,
                    _ => ImageFormat::Png,
                })
                .unwrap_or(ImageFormat::Png)
        });
        let quality = opts.quality.unwrap_or(85);

        let mut out = Vec::new();
        let (w, h) = (rgba.width(), rgba.height());
        match format {
            ImageFormat::Png => {
                let encoder = PngEncoder::new_with_quality(
                    &mut out,
                    CompressionType::Best,
                    PngFilter::default(),
                );
                encoder
                    .write_image(rgba.as_raw(), w, h, ExtendedColorType::Rgba8)
                    .map_err(|e| format!("PNG encode: {e}"))?;
            }
            ImageFormat::Jpeg => {
                // JPEG 는 RGB (alpha drop). image-rs 가 자동 변환.
                let rgb = DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
                let encoder = JpegEncoder::new_with_quality(&mut out, quality);
                let mut e = encoder;
                e.encode(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
                    .map_err(|err| format!("JPEG encode: {err}"))?;
            }
            ImageFormat::Webp => {
                // image-rs 의 WebPEncoder 는 lossless 만 — 옛 TS 의 quality+effort 와 다름.
                // 향후 webp crate (Google libwebp binding) 도입 검토. 일단 lossless 사용.
                let encoder = WebPEncoder::new_lossless(&mut out);
                encoder
                    .write_image(rgba.as_raw(), w, h, ExtendedColorType::Rgba8)
                    .map_err(|e| format!("WebP encode: {e}"))?;
            }
            ImageFormat::Avif => {
                return Err(
                    "AVIF 인코딩 미지원 — image crate avif feature 빌드 의존성 큼. \
                     사용 시점에 Cargo.toml features 추가 + 별도 batch.".to_string(),
                );
            }
        }
        Ok(out)
    }

    async fn blurhash(
        &self,
        binary: &[u8],
        components: Option<(u32, u32)>,
    ) -> InfraResult<String> {
        let img = Self::decode(binary)?;
        // 32x32 RGBA 추출 — 옛 TS sharp.resize(32,32).raw() 1:1
        let small = img.resize_exact(32, 32, FilterType::Lanczos3);
        let rgba = small.to_rgba8();
        let (cx, cy) = components.unwrap_or((4, 4));
        blurhash_encode(cx, cy, 32, 32, rgba.as_raw())
            .map_err(|e| format!("blurhash encode: {e}"))
    }

    async fn create_placeholder(&self, width: u32, height: u32) -> InfraResult<Vec<u8>> {
        // 옛 TS 동등 — 회색 RGBA 사각형 + PNG 인코딩.
        // 일반 로직: width/height clamp 1..=4096 (메모리 폭주 방어).
        let w = width.clamp(1, 4096);
        let h = height.clamp(1, 4096);
        let mut img = RgbaImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgba([230, 230, 235, 255]);
        }
        let mut out = Vec::new();
        let encoder =
            PngEncoder::new_with_quality(&mut out, CompressionType::Best, PngFilter::default());
        encoder
            .write_image(img.as_raw(), w, h, ExtendedColorType::Rgba8)
            .map_err(|e| format!("placeholder PNG encode: {e}"))?;
        Ok(out)
    }
}

/// fit 모드별 최종 width/height 산정.
/// 옛 TS sharp resize fit 옵션 1:1.
fn compute_target_dims(
    src_w: u32,
    src_h: u32,
    target_w: Option<u32>,
    target_h: Option<u32>,
    fit: &FitMode,
) -> (u32, u32) {
    match (target_w, target_h) {
        (Some(w), Some(h)) => match fit {
            FitMode::Fill | FitMode::Cover | FitMode::Outside => (w, h),
            FitMode::Contain | FitMode::Inside => {
                let scale = (w as f32 / src_w as f32).min(h as f32 / src_h as f32);
                ((src_w as f32 * scale) as u32, (src_h as f32 * scale) as u32)
            }
        },
        (Some(w), None) => {
            let scale = w as f32 / src_w as f32;
            (w, (src_h as f32 * scale).max(1.0) as u32)
        }
        (None, Some(h)) => {
            let scale = h as f32 / src_h as f32;
            ((src_w as f32 * scale).max(1.0) as u32, h)
        }
        (None, None) => (src_w, src_h),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 256x256 회색 RGBA 테스트 이미지 → PNG 바이트.
    fn sample_png() -> Vec<u8> {
        let mut img = RgbaImage::new(256, 256);
        for px in img.pixels_mut() {
            *px = image::Rgba([200, 100, 50, 255]);
        }
        let mut buf = Vec::new();
        let enc =
            PngEncoder::new_with_quality(&mut buf, CompressionType::Default, PngFilter::default());
        enc.write_image(img.as_raw(), 256, 256, ExtendedColorType::Rgba8)
            .unwrap();
        buf
    }

    #[tokio::test]
    async fn metadata_returns_correct_dims_format() {
        let p = ImageRsProcessorAdapter::new();
        let m = p.get_metadata(&sample_png()).await.unwrap();
        assert_eq!(m.width, 256);
        assert_eq!(m.height, 256);
        assert_eq!(m.format, "png");
    }

    #[tokio::test]
    async fn process_resize_inside_keeps_aspect() {
        let p = ImageRsProcessorAdapter::new();
        let out = p
            .process(
                &sample_png(),
                &ResizeOpts {
                    width: Some(128),
                    height: Some(64),
                    fit: Some(FitMode::Inside),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let m = p.get_metadata(&out).await.unwrap();
        // inside fit + 256x256 → max 64 (h 제한이 더 작음) → 64x64
        assert_eq!(m.width, 64);
        assert_eq!(m.height, 64);
    }

    #[tokio::test]
    async fn process_resize_cover_crops_to_target() {
        let p = ImageRsProcessorAdapter::new();
        let out = p
            .process(
                &sample_png(),
                &ResizeOpts {
                    width: Some(100),
                    height: Some(50),
                    fit: Some(FitMode::Cover),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let m = p.get_metadata(&out).await.unwrap();
        assert_eq!(m.width, 100);
        assert_eq!(m.height, 50);
    }

    #[tokio::test]
    async fn process_format_convert_jpeg() {
        let p = ImageRsProcessorAdapter::new();
        let out = p
            .process(
                &sample_png(),
                &ResizeOpts {
                    format: Some(ImageFormat::Jpeg),
                    quality: Some(80),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let m = p.get_metadata(&out).await.unwrap();
        assert_eq!(m.format, "jpeg");
    }

    #[tokio::test]
    async fn blurhash_returns_base83_string() {
        let p = ImageRsProcessorAdapter::new();
        let h = p.blurhash(&sample_png(), Some((4, 4))).await.unwrap();
        // base83 blurhash — 일반적으로 20+ chars.
        assert!(h.len() >= 6, "blurhash len {} too short", h.len());
    }

    #[tokio::test]
    async fn placeholder_correct_dims() {
        let p = ImageRsProcessorAdapter::new();
        let png = p.create_placeholder(320, 200).await.unwrap();
        let m = p.get_metadata(&png).await.unwrap();
        assert_eq!(m.width, 320);
        assert_eq!(m.height, 200);
        assert_eq!(m.format, "png");
    }

    #[tokio::test]
    async fn placeholder_clamps_extreme_dims() {
        let p = ImageRsProcessorAdapter::new();
        // 0 → 1, 99999 → 4096 — 일반 로직 (메모리 폭주 방어)
        let png_small = p.create_placeholder(0, 0).await.unwrap();
        let m1 = p.get_metadata(&png_small).await.unwrap();
        assert_eq!(m1.width, 1);
        assert_eq!(m1.height, 1);

        let png_huge = p.create_placeholder(99_999, 99_999).await.unwrap();
        let m2 = p.get_metadata(&png_huge).await.unwrap();
        assert_eq!(m2.width, 4096);
        assert_eq!(m2.height, 4096);
    }

    #[tokio::test]
    async fn avif_format_returns_clear_error() {
        let p = ImageRsProcessorAdapter::new();
        let r = p
            .process(
                &sample_png(),
                &ResizeOpts {
                    format: Some(ImageFormat::Avif),
                    ..Default::default()
                },
            )
            .await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("AVIF"));
    }
}

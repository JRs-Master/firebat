//! OpenAI Images API — gpt-image-1 / gpt-image-2.
//!
//! 옛 TS `infra/image/formats/openai-image.ts` 1:1 port. 두 endpoint 분기:
//!   - 일반 생성: POST `/v1/images/generations` + JSON body
//!   - image-to-image: POST `/v1/images/edits` + multipart/form-data
//!
//! gpt-image-1 / gpt-image-2 양쪽 지원 — config.id 만 다름.
//! reference_image 박혀있으면 자동 edits endpoint.

use std::collections::HashSet;

use base64::Engine;
use reqwest::multipart;
use serde::Deserialize;

use crate::image_gen::config::compute_image_cost;
use crate::image_gen::format_handler::{ImageFormatHandler, ImageFormatHandlerContext};
use firebat_core::ports::{ImageGenCallOpts, ImageGenOpts, ImageGenResult, InfraResult};

const DEFAULT_SIZE: &str = "1024x1024";
const DEFAULT_QUALITY: &str = "medium";

fn supported_sizes() -> HashSet<&'static str> {
    ["1024x1024", "1536x1024", "1024x1536", "auto"]
        .iter()
        .copied()
        .collect()
}

/// AI 가 DALL-E 3 시절 사이즈 박으면 gpt-image-1 호환 값으로 매핑.
/// 옛 TS `normalizeSize` 1:1 — 일반 로직 (특정 사이즈만 매핑, 나머지는 default).
fn normalize_size(size: Option<&str>) -> &str {
    match size {
        None => DEFAULT_SIZE,
        Some(s) if supported_sizes().contains(s) => s,
        Some("1792x1024") => "1536x1024",
        Some("1024x1792") => "1024x1536",
        _ => DEFAULT_SIZE,
    }
}

fn parse_size(size: &str) -> (Option<u32>, Option<u32>) {
    if size == "auto" {
        return (None, None);
    }
    let parts: Vec<&str> = size.split('x').collect();
    if parts.len() != 2 {
        return (None, None);
    }
    (parts[0].parse().ok(), parts[1].parse().ok())
}

/// `/v1/images/generations` → `/v1/images/edits` path 교체. 도메인·basepath 보존.
fn to_edits_endpoint(generations_endpoint: &str) -> String {
    generations_endpoint.replace("/images/generations", "/images/edits")
}

/// content-type → 파일 확장자. multipart filename 파라미터에 필요 (없으면 OpenAI 가 거부).
fn ext_from_content_type(ct: &str) -> &'static str {
    if ct.contains("jpeg") || ct.contains("jpg") {
        "jpg"
    } else if ct.contains("webp") {
        "webp"
    } else {
        "png"
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiImagesResponse {
    data: Option<Vec<OpenAiImageData>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageData {
    b64_json: Option<String>,
    revised_prompt: Option<String>,
}

pub struct OpenAiImageFormat;

impl OpenAiImageFormat {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OpenAiImageFormat {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ImageFormatHandler for OpenAiImageFormat {
    async fn generate(
        &self,
        opts: &ImageGenOpts,
        _call_opts: &ImageGenCallOpts,
        ctx: ImageFormatHandlerContext<'_>,
    ) -> InfraResult<ImageGenResult> {
        let api_key = (ctx.resolve_api_key)().ok_or_else(|| {
            format!(
                "API 키가 설정되지 않았습니다: {}",
                ctx.config.api_key_vault_key
            )
        })?;

        let size = normalize_size(opts.size.as_deref());
        let quality = opts.quality.as_deref().unwrap_or(DEFAULT_QUALITY);
        let n = opts.n.unwrap_or(1);

        // ctx.config.id 우선 — resolveConfig 가 registry 기반 정규화한 값 (권위).
        // opts.model 은 힌트 (registry 미박힌 ID 박혀도 fallback 으로 호출 가능).
        let client = crate::llm::formats::common::http_client();

        let resp = if let Some(ref_img) = &opts.reference_image {
            // image-to-image: /v1/images/edits + multipart
            let endpoint = to_edits_endpoint(&ctx.config.endpoint);
            let ext = ext_from_content_type(&ref_img.content_type);
            let part = multipart::Part::bytes(ref_img.binary.clone())
                .file_name(format!("reference.{}", ext))
                .mime_str(&ref_img.content_type)
                .map_err(|e| format!("multipart mime: {e}"))?;
            let mut form = multipart::Form::new()
                .text("model", ctx.config.id.clone())
                .text("prompt", opts.prompt.clone())
                .text("n", n.to_string())
                .text("size", size.to_string())
                .text("quality", quality.to_string());
            form = form.part("image", part);

            let mut req = client
                .post(&endpoint)
                .header("Authorization", format!("Bearer {}", api_key));
            for (k, v) in &ctx.config.extra_headers {
                req = req.header(k, v);
            }
            req.multipart(form)
                .send()
                .await
                .map_err(|e| format!("OpenAI edits 요청: {e}"))?
        } else {
            // 일반 생성: /v1/images/generations + JSON body
            let body = serde_json::json!({
                "model": ctx.config.id,
                "prompt": opts.prompt,
                "n": n,
                "size": size,
                "quality": quality,
            });
            let mut req = client
                .post(&ctx.config.endpoint)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", api_key));
            for (k, v) in &ctx.config.extra_headers {
                req = req.header(k, v);
            }
            req.json(&body)
                .send()
                .await
                .map_err(|e| format!("OpenAI generations 요청: {e}"))?
        };

        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            // 개행 제거 — 옛 TS 와 동일 (로그 파서 라인 끊김 방지)
            let flat: String = txt.split_whitespace().collect::<Vec<_>>().join(" ");
            let truncated: String = flat.chars().take(2000).collect();
            return Err(format!(
                "OpenAI Images API {}{}: {}",
                status,
                if opts.reference_image.is_some() {
                    " (edits)"
                } else {
                    ""
                },
                truncated
            ));
        }
        let json: OpenAiImagesResponse = resp
            .json()
            .await
            .map_err(|e| format!("OpenAI 응답 JSON: {e}"))?;
        let first = json
            .data
            .and_then(|mut v| v.drain(..).next())
            .ok_or_else(|| "응답에 이미지 데이터가 없습니다".to_string())?;
        let b64 = first
            .b64_json
            .ok_or_else(|| "응답에 b64_json 없음".to_string())?;
        let binary = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("base64 decode: {e}"))?;

        let (width, height) = parse_size(size);
        let cost_usd = compute_image_cost(ctx.config, opts.quality.as_deref());

        Ok(ImageGenResult {
            binary,
            content_type: "image/png".to_string(),
            width,
            height,
            revised_prompt: first.revised_prompt,
            cost_usd,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_size_dalle_legacy_maps_to_gpt_image_1() {
        assert_eq!(normalize_size(None), "1024x1024");
        assert_eq!(normalize_size(Some("1024x1024")), "1024x1024");
        assert_eq!(normalize_size(Some("auto")), "auto");
        // DALL-E 3 legacy → gpt-image-1 호환
        assert_eq!(normalize_size(Some("1792x1024")), "1536x1024");
        assert_eq!(normalize_size(Some("1024x1792")), "1024x1536");
        // 무효 값 → default
        assert_eq!(normalize_size(Some("invalid")), "1024x1024");
    }

    #[test]
    fn parse_size_extracts_dims() {
        assert_eq!(parse_size("1024x1024"), (Some(1024), Some(1024)));
        assert_eq!(parse_size("1536x1024"), (Some(1536), Some(1024)));
        assert_eq!(parse_size("auto"), (None, None));
        assert_eq!(parse_size("invalid"), (None, None));
    }

    #[test]
    fn to_edits_swaps_path_only() {
        assert_eq!(
            to_edits_endpoint("https://api.openai.com/v1/images/generations"),
            "https://api.openai.com/v1/images/edits"
        );
        // proxy 도메인도 path 만 교체
        assert_eq!(
            to_edits_endpoint("https://my-proxy.example.com/v1/images/generations"),
            "https://my-proxy.example.com/v1/images/edits"
        );
    }

    #[test]
    fn ext_from_content_type_recognizes_common() {
        assert_eq!(ext_from_content_type("image/png"), "png");
        assert_eq!(ext_from_content_type("image/jpeg"), "jpg");
        assert_eq!(ext_from_content_type("image/jpg"), "jpg");
        assert_eq!(ext_from_content_type("image/webp"), "webp");
        // unknown → png (안전 default)
        assert_eq!(ext_from_content_type("application/octet-stream"), "png");
    }
}

//! Gemini Native API 이미지 생성 — gemini-3.1-flash-image-preview (Nano Banana 후속).
//!
//! 옛 TS `infra/image/formats/gemini-native-image.ts` 1:1 port.
//! POST `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
//! 인증: `?key=<API_KEY>` query param.
//! Multimodal contents — reference_image 박혀있으면 inline_data part 자동 추가.

use base64::Engine;
use serde::Deserialize;

use crate::image_gen::config::compute_image_cost;
use crate::image_gen::format_handler::{ImageFormatHandler, ImageFormatHandlerContext};
use crate::ports::{ImageGenCallOpts, ImageGenOpts, ImageGenResult, InfraResult};

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

/// Gemini 응답은 snake_case (`inline_data`) 또는 camelCase (`inlineData`) — 둘 다 허용.
#[derive(Debug, Deserialize)]
struct GeminiPart {
    #[serde(rename = "inline_data", default)]
    inline_data: Option<GeminiInlineData>,
    #[serde(rename = "inlineData", default)]
    inline_data_camel: Option<GeminiInlineData>,
}

#[derive(Debug, Deserialize)]
struct GeminiInlineData {
    #[serde(rename = "mime_type", default)]
    mime_type_snake: Option<String>,
    #[serde(rename = "mimeType", default)]
    mime_type_camel: Option<String>,
    data: Option<String>,
}

impl GeminiInlineData {
    fn mime_type(&self) -> String {
        self.mime_type_snake
            .clone()
            .or_else(|| self.mime_type_camel.clone())
            .unwrap_or_else(|| "image/png".to_string())
    }
}

pub struct GeminiNativeImageFormat;

impl GeminiNativeImageFormat {
    pub fn new() -> Self {
        Self
    }
}

impl Default for GeminiNativeImageFormat {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ImageFormatHandler for GeminiNativeImageFormat {
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

        // Gemini 는 size 직접 X — 프롬프트에 aspect ratio 힌트 주입 (사용자 의도 보존).
        let mut prompt = opts.prompt.clone();
        if let Some(size) = opts.size.as_deref() {
            if size != "auto" {
                let hint = size.replace('x', ":");
                prompt.push_str(&format!("\n\n(Aspect ratio hint: {}.)", hint));
            }
        }

        // multimodal contents.parts — reference_image 박혀있으면 inline_data 먼저, 그 다음 text.
        let mut parts: Vec<serde_json::Value> = Vec::new();
        if let Some(ref_img) = &opts.reference_image {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&ref_img.binary);
            parts.push(serde_json::json!({
                "inline_data": {
                    "mime_type": ref_img.content_type,
                    "data": b64,
                }
            }));
        }
        parts.push(serde_json::json!({ "text": prompt }));

        let url = format!(
            "{}?key={}",
            ctx.config.endpoint,
            urlencoding::encode(&api_key)
        );
        let body = serde_json::json!({
            "contents": [{ "parts": parts }],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
            },
        });

        let client = crate::llm::formats::common::http_client();
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini Images API 요청: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            let flat: String = txt.split_whitespace().collect::<Vec<_>>().join(" ");
            let truncated: String = flat.chars().take(2000).collect();
            return Err(format!("Gemini Images API {}: {}", status, truncated));
        }

        let json: GeminiResponse = resp
            .json()
            .await
            .map_err(|e| format!("Gemini 응답 JSON: {e}"))?;
        let first_part = json
            .candidates
            .and_then(|mut c| c.drain(..).next())
            .and_then(|c| c.content)
            .and_then(|c| c.parts)
            .and_then(|mut p| {
                // inline_data 가 박힌 part 우선 (text part 가 먼저 오는 경우 있음)
                p.drain(..).find(|part| {
                    part.inline_data
                        .as_ref()
                        .and_then(|d| d.data.as_ref())
                        .is_some()
                        || part
                            .inline_data_camel
                            .as_ref()
                            .and_then(|d| d.data.as_ref())
                            .is_some()
                })
            })
            .ok_or_else(|| "응답에 이미지 데이터가 없습니다".to_string())?;
        let inline_data = first_part
            .inline_data
            .or(first_part.inline_data_camel)
            .ok_or_else(|| "응답 part 의 inline_data 비어있음".to_string())?;
        let mime_type = inline_data.mime_type();
        let b64 = inline_data
            .data
            .ok_or_else(|| "응답 inline_data.data 비어있음".to_string())?;
        let binary = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("base64 decode: {e}"))?;

        // Gemini 는 quality 무관 단일 단가 (config.pricing.perImage)
        let cost_usd = compute_image_cost(ctx.config, opts.quality.as_deref());

        Ok(ImageGenResult {
            binary,
            content_type: mime_type,
            width: None,
            height: None,
            revised_prompt: None,
            cost_usd,
        })
    }
}

// urlencoding crate 의존성 회피 — 단순 percent encode 헬퍼 재사용 (LLM 의 Gemini handler 와 동일 패턴).
mod urlencoding {
    pub fn encode(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
                _ => format!("%{:02X}", c as u8),
            })
            .collect()
    }
}

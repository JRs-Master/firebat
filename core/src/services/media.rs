//! gRPC MediaService impl — MediaManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port/manager struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::media::{GenerateImageInput, GenerateImageResult, MediaManager};
use crate::ports::{
    ImageModelInfo, MediaFileRecord, MediaListOpts, MediaSaveOptions, MediaSaveResult, MediaVariant,
};
use crate::proto::{
    media_service_server::MediaService, BoolRequest, Empty, GenerateImageResultPb, ImageModelListPb,
    ImageModelPb, ImageSettingsPb, MediaFileRecordPb, MediaGenerateRequest, MediaListRequest,
    MediaListResultPb, MediaReadPb, MediaSaveRequest, MediaSaveTempAttachmentRequest,
    MediaStartGenerationRequest,
    MediaSaveResultPb, MediaVariantPb, NumberRequest, OptionalStringPb, RawJsonPb,
    StartGenerationPb, StringRequest,
};

pub struct MediaServiceImpl {
    manager: Arc<MediaManager>,
}

impl MediaServiceImpl {
    pub fn new(manager: Arc<MediaManager>) -> Self {
        Self { manager }
    }
}

// ─── proto ↔ core struct 변환 ─────────────────────────────────────────────

impl From<MediaVariant> for MediaVariantPb {
    fn from(v: MediaVariant) -> Self {
        MediaVariantPb {
            width: v.width,
            height: v.height,
            format: v.format,
            url: v.url,
            bytes: v.bytes,
        }
    }
}

impl From<MediaFileRecord> for MediaFileRecordPb {
    fn from(r: MediaFileRecord) -> Self {
        MediaFileRecordPb {
            slug: r.slug,
            ext: r.ext,
            content_type: r.content_type,
            bytes: r.bytes,
            width: r.width,
            height: r.height,
            created_at: r.created_at,
            scope: r.scope.map(|s| s.as_str().to_string()),
            filename_hint: r.filename_hint,
            prompt: r.prompt,
            revised_prompt: r.revised_prompt,
            model: r.model,
            size: r.size,
            quality: r.quality,
            aspect_ratio: r.aspect_ratio,
            variants: r.variants.into_iter().map(Into::into).collect(),
            thumbnail_url: r.thumbnail_url,
            blurhash: r.blurhash,
            status: r.status,
            error_msg: r.error_msg,
            source: r.source,
        }
    }
}

impl From<MediaSaveResult> for MediaSaveResultPb {
    fn from(r: MediaSaveResult) -> Self {
        MediaSaveResultPb {
            slug: r.slug,
            url: r.url,
            thumbnail_url: r.thumbnail_url,
            variants: r.variants.into_iter().map(Into::into).collect(),
            blurhash: r.blurhash,
            width: r.width,
            height: r.height,
            bytes: r.bytes,
        }
    }
}

impl From<GenerateImageResult> for GenerateImageResultPb {
    fn from(r: GenerateImageResult) -> Self {
        GenerateImageResultPb {
            url: r.url,
            thumbnail_url: r.thumbnail_url,
            variants: r.variants.into_iter().map(Into::into).collect(),
            blurhash: r.blurhash,
            width: r.width,
            height: r.height,
            slug: r.slug,
            revised_prompt: r.revised_prompt,
            model_id: r.model_id,
            aspect_ratio: r.aspect_ratio,
            cost_usd: r.cost_usd,
        }
    }
}

impl From<ImageModelInfo> for ImageModelPb {
    fn from(m: ImageModelInfo) -> Self {
        ImageModelPb {
            id: m.id,
            display_name: m.display_name,
            provider: m.provider,
            format: m.format,
            sizes: m.sizes,
            qualities: m.qualities,
            subscription: m.subscription,
            requires_organization_verification: m.requires_organization_verification,
        }
    }
}

#[tonic::async_trait]
impl MediaService for MediaServiceImpl {
    async fn read(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<MediaReadPb>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.read(&slug).await {
            Ok(Some((binary, content_type, record))) => {
                Ok(Response::new(MediaReadPb {
                    binary_base64: base64_simple_encode(&binary),
                    content_type,
                    record: Some(record.into()),
                }))
            }
            Ok(None) => Ok(Response::new(MediaReadPb::default())),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list(
        &self,
        req: Request<MediaListRequest>,
    ) -> Result<Response<MediaListResultPb>, TonicStatus> {
        let args = req.into_inner();
        let opts: MediaListOpts = if args.opts_json.trim().is_empty() {
            MediaListOpts::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        match self.manager.list(opts).await {
            Ok(result) => Ok(Response::new(MediaListResultPb {
                items: result.items.into_iter().map(Into::into).collect(),
                total: result.total as i64,
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn remove(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let slug = req.into_inner().value;
        self.manager
            .remove(&slug)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(Empty {}))
    }

    async fn is_ready(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let slug = req.into_inner().value;
        Ok(Response::new(BoolRequest {
            value: self.manager.is_ready(&slug).await,
        }))
    }

    async fn start_generation(
        &self,
        req: Request<MediaStartGenerationRequest>,
    ) -> Result<Response<StartGenerationPb>, TonicStatus> {
        let args = req.into_inner();
        let input: GenerateImageInput = serde_json::from_str(&args.input_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("input_json: {e}")))?;
        match self.manager.start_generate(input).await {
            Ok((slug, url)) => Ok(Response::new(StartGenerationPb { slug, url })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn generate(
        &self,
        req: Request<MediaGenerateRequest>,
    ) -> Result<Response<GenerateImageResultPb>, TonicStatus> {
        let args = req.into_inner();
        let input: GenerateImageInput = serde_json::from_str(&args.input_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("input_json: {e}")))?;
        match self.manager.generate_image(input, None).await {
            Ok(result) => Ok(Response::new(result.into())),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn regenerate(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<GenerateImageResultPb>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.regenerate_image_by_slug(&slug).await {
            Ok((result, _new_slug)) => Ok(Response::new(result.into())),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn save(
        &self,
        req: Request<MediaSaveRequest>,
    ) -> Result<Response<MediaSaveResultPb>, TonicStatus> {
        let args = req.into_inner();
        let opts: MediaSaveOptions = if args.opts_json.is_empty() {
            MediaSaveOptions::default()
        } else {
            serde_json::from_str(&args.opts_json)
                .map_err(|e| TonicStatus::invalid_argument(format!("opts_json: {e}")))?
        };
        let binary = base64_simple_decode(&args.binary_base64).map_err(|e| {
            TonicStatus::invalid_argument(format!("base64 decode 실패: {e}"))
        })?;
        match self.manager.save(&binary, &args.content_type, opts).await {
            Ok(result) => Ok(Response::new(result.into())),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_image_model(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        Ok(Response::new(StringRequest {
            value: self.manager.get_image_model(),
        }))
    }

    async fn set_image_model(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let model_id = req.into_inner().value;
        self.manager
            .set_image_model(&model_id)
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(Empty {}))
    }

    async fn get_available_image_models(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<ImageModelListPb>, TonicStatus> {
        let models = self
            .manager
            .list_image_models()
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(ImageModelListPb { models }))
    }

    async fn get_image_default_size(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<OptionalStringPb>, TonicStatus> {
        let val = self.manager.get_image_default_size();
        Ok(Response::new(OptionalStringPb {
            value: val.clone().unwrap_or_default(),
            present: val.is_some(),
        }))
    }

    async fn set_image_default_size(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let size = req.into_inner().value;
        let arg = if size.is_empty() { None } else { Some(size.as_str()) };
        self.manager
            .set_image_default_size(arg)
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(Empty {}))
    }

    async fn get_image_default_quality(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<OptionalStringPb>, TonicStatus> {
        let val = self.manager.get_image_default_quality();
        Ok(Response::new(OptionalStringPb {
            value: val.clone().unwrap_or_default(),
            present: val.is_some(),
        }))
    }

    async fn set_image_default_quality(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Empty>, TonicStatus> {
        let q = req.into_inner().value;
        let arg = if q.is_empty() { None } else { Some(q.as_str()) };
        self.manager
            .set_image_default_quality(arg)
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(Empty {}))
    }

    async fn get_image_settings(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<ImageSettingsPb>, TonicStatus> {
        let settings = self.manager.get_image_settings();
        let raw_json = serde_json::to_string(&settings)
            .unwrap_or_else(|_| "{}".to_string());
        Ok(Response::new(ImageSettingsPb { raw_json }))
    }

    async fn save_temp_attachment(
        &self,
        req: Request<MediaSaveTempAttachmentRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        match self.manager.save_temp_attachment(&args.data_url).await {
            Ok(url) => {
                // slug 추출 — /user/attachments/<slug>.<ext>
                let slug = url
                    .rsplit('/')
                    .next()
                    .and_then(|f| f.rsplit_once('.'))
                    .map(|(s, _)| s.to_string())
                    .unwrap_or_default();
                let body = serde_json::json!({ "slug": slug, "url": url });
                Ok(Response::new(RawJsonPb {
                    raw_json: body.to_string(),
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn cleanup_old_attachments(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<NumberRequest>, TonicStatus> {
        // 30일 retention — internal cron 이 호출. 응답: 삭제된 파일 개수.
        const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
        match self.manager.cleanup_old_attachments(RETENTION_MS).await {
            Ok(n) => Ok(Response::new(NumberRequest { value: n })),
            Err(_) => Ok(Response::new(NumberRequest { value: 0 })),
        }
    }
}

// 의존성 0 base64 — std::base64 미지원이라 직접 구현. binary 가 있는 read/save 에만 사용.
fn base64_simple_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let b1 = bytes[i];
        let b2 = bytes[i + 1];
        let b3 = bytes[i + 2];
        out.push(CHARS[(b1 >> 2) as usize] as char);
        out.push(CHARS[(((b1 & 0x03) << 4) | (b2 >> 4)) as usize] as char);
        out.push(CHARS[(((b2 & 0x0f) << 2) | (b3 >> 6)) as usize] as char);
        out.push(CHARS[(b3 & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let b1 = bytes[i];
        out.push(CHARS[(b1 >> 2) as usize] as char);
        out.push(CHARS[((b1 & 0x03) << 4) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let b1 = bytes[i];
        let b2 = bytes[i + 1];
        out.push(CHARS[(b1 >> 2) as usize] as char);
        out.push(CHARS[(((b1 & 0x03) << 4) | (b2 >> 4)) as usize] as char);
        out.push(CHARS[((b2 & 0x0f) << 2) as usize] as char);
        out.push('=');
    }
    out
}

fn base64_simple_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 char: {}", c as char)),
        }
    }
    let bytes: Vec<u8> = s
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    if bytes.len() % 4 == 1 {
        return Err("invalid base64 length".to_string());
    }
    let mut out: Vec<u8> = Vec::with_capacity((bytes.len() * 3) / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let v1 = val(bytes[i])?;
        let v2 = val(bytes[i + 1])?;
        let v3 = val(bytes[i + 2])?;
        let v4 = val(bytes[i + 3])?;
        out.push((v1 << 2) | (v2 >> 4));
        out.push((v2 << 4) | (v3 >> 2));
        out.push((v3 << 6) | v4);
        i += 4;
    }
    let rem = bytes.len() - i;
    if rem == 2 {
        let v1 = val(bytes[i])?;
        let v2 = val(bytes[i + 1])?;
        out.push((v1 << 2) | (v2 >> 4));
    } else if rem == 3 {
        let v1 = val(bytes[i])?;
        let v2 = val(bytes[i + 1])?;
        let v3 = val(bytes[i + 2])?;
        out.push((v1 << 2) | (v2 >> 4));
        out.push((v2 << 4) | (v3 >> 2));
    }
    Ok(out)
}

// 외부 API 테스트 이관 — `infra/tests/svc_media_test.rs` (integration test).
// 아래 inline 테스트는 private fn (`base64_simple_encode` / `base64_simple_decode`) 사용이라 유지.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        let encoded = base64_simple_encode(b"hello world");
        let decoded = base64_simple_decode(&encoded).unwrap();
        assert_eq!(decoded, b"hello world");
    }
}

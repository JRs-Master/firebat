//! gRPC MediaService impl — MediaManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port/manager struct ↔ proto generated struct 변환.
//!
//! 2026-05-15 unique RPC message — Empty/StringRequest/BoolRequest/NumberRequest/OptionalStringPb/
//! RawJsonPb shared 폐기. RPC 별 명시 message + 의미적 필드명 (slug / model / size 등).

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::media::{GenerateImageInput, GenerateImageResult, MediaManager};
use crate::ports::{
    ITtsPort, ImageModelInfo, MediaFileRecord, MediaListOpts, MediaSaveOptions, MediaSaveResult,
    MediaVariant, TtsRequest,
};
use crate::proto::{
    media_service_server::MediaService, ImageModelListPb, ImageModelPb, MediaGenerateResponse,
    MediaRegenerateResponse,
    ImageSettingsPb, MediaCleanupOldAttachmentsRequest, MediaCleanupOldAttachmentsResponse,
    MediaFileRecordPb, MediaGenerateRequest, MediaGetAvailableImageModelsRequest,
    MediaGetImageDefaultQualityRequest, MediaGetImageDefaultQualityResponse,
    MediaGetImageDefaultSizeRequest, MediaGetImageDefaultSizeResponse, MediaGetImageModelRequest,
    MediaGetImageModelResponse, MediaGetImageSettingsRequest, MediaIsReadyRequest,
    MediaIsReadyResponse, MediaListRequest, MediaListResultPb, MediaReadPb, MediaReadRequest,
    MediaReadConvAttachmentRequest, MediaReadConvAttachmentResponse,
    MediaReadTempAttachmentRequest, MediaReadTempAttachmentResponse,
    MediaRegenerateRequest, MediaRemoveRequest, MediaRemoveResponse, MediaSaveRequest,
    MediaSaveResultPb, MediaSaveTempAttachmentRequest, MediaSaveTempAttachmentResponse,
    MediaSetImageDefaultQualityRequest, MediaSetImageDefaultQualityResponse,
    MediaSetImageDefaultSizeRequest, MediaSetImageDefaultSizeResponse, MediaSetImageModelRequest,
    MediaSetImageModelResponse, MediaStartGenerationRequest, MediaVariantPb, StartGenerationPb,
    TtsSampleRequest, TtsSampleResponse,
};

pub struct MediaServiceImpl {
    manager: Arc<MediaManager>,
    tts: Option<Arc<dyn ITtsPort>>,
}

impl MediaServiceImpl {
    pub fn new(manager: Arc<MediaManager>) -> Self {
        Self {
            manager,
            tts: None,
        }
    }

    /// TTS 어댑터 주입 — 보이스 샘플 미리듣기(SynthesizeSample) 용. 미주입 시 unavailable.
    pub fn with_tts(mut self, tts: Arc<dyn ITtsPort>) -> Self {
        self.tts = Some(tts);
        self
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

impl From<GenerateImageResult> for MediaGenerateResponse {
    fn from(r: GenerateImageResult) -> Self {
        MediaGenerateResponse {
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

impl From<GenerateImageResult> for MediaRegenerateResponse {
    fn from(r: GenerateImageResult) -> Self {
        MediaRegenerateResponse {
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
        req: Request<MediaReadRequest>,
    ) -> Result<Response<MediaReadPb>, TonicStatus> {
        let slug = req.into_inner().slug;
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
        req: Request<MediaRemoveRequest>,
    ) -> Result<Response<MediaRemoveResponse>, TonicStatus> {
        let args = req.into_inner();
        // hub_owner 지정(hub) → remove_owned(소유 검사) / None(admin) → 무검사.
        self.manager
            .remove_owned(&args.slug, args.hub_owner.as_deref())
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(MediaRemoveResponse {}))
    }

    async fn is_ready(
        &self,
        req: Request<MediaIsReadyRequest>,
    ) -> Result<Response<MediaIsReadyResponse>, TonicStatus> {
        let slug = req.into_inner().slug;
        Ok(Response::new(MediaIsReadyResponse {
            ready: self.manager.is_ready(&slug).await,
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
    ) -> Result<Response<MediaGenerateResponse>, TonicStatus> {
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
        req: Request<MediaRegenerateRequest>,
    ) -> Result<Response<MediaRegenerateResponse>, TonicStatus> {
        let args = req.into_inner();
        // hub_owner 지정(hub) → regenerate_image_owned(소유 검사 + 같은 scope 저장) / None(admin) → 무검사.
        match self
            .manager
            .regenerate_image_owned(&args.slug, args.hub_owner.as_deref())
            .await
        {
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
            TonicStatus::invalid_argument(crate::i18n::t(
                "core.error.media.base64_decode_failed",
                None,
                &[("detail", &e)],
            ))
        })?;
        match self.manager.save(&binary, &args.content_type, opts).await {
            Ok(result) => Ok(Response::new(result.into())),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_image_model(
        &self,
        _req: Request<MediaGetImageModelRequest>,
    ) -> Result<Response<MediaGetImageModelResponse>, TonicStatus> {
        Ok(Response::new(MediaGetImageModelResponse {
            model: self.manager.get_image_model(),
        }))
    }

    async fn set_image_model(
        &self,
        req: Request<MediaSetImageModelRequest>,
    ) -> Result<Response<MediaSetImageModelResponse>, TonicStatus> {
        let model_id = req.into_inner().model;
        self.manager
            .set_image_model(&model_id)
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(MediaSetImageModelResponse {}))
    }

    async fn get_available_image_models(
        &self,
        _req: Request<MediaGetAvailableImageModelsRequest>,
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
        _req: Request<MediaGetImageDefaultSizeRequest>,
    ) -> Result<Response<MediaGetImageDefaultSizeResponse>, TonicStatus> {
        let val = self.manager.get_image_default_size();
        Ok(Response::new(MediaGetImageDefaultSizeResponse {
            size: val.clone().unwrap_or_default(),
            present: val.is_some(),
        }))
    }

    async fn set_image_default_size(
        &self,
        req: Request<MediaSetImageDefaultSizeRequest>,
    ) -> Result<Response<MediaSetImageDefaultSizeResponse>, TonicStatus> {
        let size = req.into_inner().size;
        let arg = if size.is_empty() { None } else { Some(size.as_str()) };
        self.manager
            .set_image_default_size(arg)
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(MediaSetImageDefaultSizeResponse {}))
    }

    async fn get_image_default_quality(
        &self,
        _req: Request<MediaGetImageDefaultQualityRequest>,
    ) -> Result<Response<MediaGetImageDefaultQualityResponse>, TonicStatus> {
        let val = self.manager.get_image_default_quality();
        Ok(Response::new(MediaGetImageDefaultQualityResponse {
            quality: val.clone().unwrap_or_default(),
            present: val.is_some(),
        }))
    }

    async fn set_image_default_quality(
        &self,
        req: Request<MediaSetImageDefaultQualityRequest>,
    ) -> Result<Response<MediaSetImageDefaultQualityResponse>, TonicStatus> {
        let q = req.into_inner().quality;
        let arg = if q.is_empty() { None } else { Some(q.as_str()) };
        self.manager
            .set_image_default_quality(arg)
            .map_err(TonicStatus::invalid_argument)?;
        Ok(Response::new(MediaSetImageDefaultQualityResponse {}))
    }

    async fn get_image_settings(
        &self,
        _req: Request<MediaGetImageSettingsRequest>,
    ) -> Result<Response<ImageSettingsPb>, TonicStatus> {
        let settings = self.manager.get_image_settings();
        let raw_json = serde_json::to_string(&settings)
            .unwrap_or_else(|_| "{}".to_string());
        Ok(Response::new(ImageSettingsPb { raw_json }))
    }

    async fn save_temp_attachment(
        &self,
        req: Request<MediaSaveTempAttachmentRequest>,
    ) -> Result<Response<MediaSaveTempAttachmentResponse>, TonicStatus> {
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
                Ok(Response::new(MediaSaveTempAttachmentResponse {
                    raw_json: body.to_string(),
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn cleanup_old_attachments(
        &self,
        _req: Request<MediaCleanupOldAttachmentsRequest>,
    ) -> Result<Response<MediaCleanupOldAttachmentsResponse>, TonicStatus> {
        // 30일 retention — internal cron 이 호출. 응답: 삭제된 파일 개수.
        const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
        match self.manager.cleanup_old_attachments(RETENTION_MS).await {
            Ok(n) => Ok(Response::new(MediaCleanupOldAttachmentsResponse {
                deleted_count: n,
            })),
            Err(_) => Ok(Response::new(MediaCleanupOldAttachmentsResponse {
                deleted_count: 0,
            })),
        }
    }

    async fn read_temp_attachment(
        &self,
        req: Request<MediaReadTempAttachmentRequest>,
    ) -> Result<Response<MediaReadTempAttachmentResponse>, TonicStatus> {
        let args = req.into_inner();
        match self.manager.read_temp_attachment(&args.filename).await {
            Ok(Some((binary, content_type))) => {
                Ok(Response::new(MediaReadTempAttachmentResponse {
                    found: true,
                    binary,
                    content_type,
                }))
            }
            Ok(None) => Ok(Response::new(MediaReadTempAttachmentResponse {
                found: false,
                binary: Vec::new(),
                content_type: String::new(),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn read_conv_attachment(
        &self,
        req: Request<MediaReadConvAttachmentRequest>,
    ) -> Result<Response<MediaReadConvAttachmentResponse>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .read_conv_attachment(&args.conv, &args.name)
            .await
        {
            Ok(Some((binary, content_type))) => Ok(Response::new(MediaReadConvAttachmentResponse {
                found: true,
                binary,
                content_type,
            })),
            Ok(None) => Ok(Response::new(MediaReadConvAttachmentResponse {
                found: false,
                binary: Vec::new(),
                content_type: String::new(),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn synthesize_sample(
        &self,
        req: Request<TtsSampleRequest>,
    ) -> Result<Response<TtsSampleResponse>, TonicStatus> {
        let args = req.into_inner();
        let tts = self
            .tts
            .as_ref()
            .ok_or_else(|| TonicStatus::unavailable("TTS 어댑터 미구성"))?;
        // generate-once 캐시 — 같은 (provider, voice) 샘플은 파일 1개 재사용 → 재생 즉시(딜레이 0).
        // 서버 리셋 시 _tts-samples 디렉토리 통째 소멸(찌꺼기 자동 정리). 30일 cleanup 은 subdir 제외라 유지.
        let provider = args.provider.clone();
        let ext = if provider == "openai" { "mp3" } else { "wav" };
        let content_type = if ext == "mp3" { "audio/mpeg" } else { "audio/wav" };
        let safe_voice: String = args
            .voice
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect();
        let voice_key = if safe_voice.is_empty() { "default".to_string() } else { safe_voice };
        let name = format!("sample-{provider}-{voice_key}.{ext}");
        let conv = "_tts-samples";
        // 1. 파일 체크 — 있으면 그 URL(합성·API 콜 0).
        if let Ok(Some(url)) = self.manager.conv_attachment_url(conv, &name).await {
            return Ok(Response::new(TtsSampleResponse {
                url,
                content_type: content_type.to_string(),
            }));
        }
        // 2. 없으면 API 호출 → 저장 → URL.
        let text = if args.text.trim().is_empty() {
            "Hello, this is a sample of my voice.".to_string()
        } else {
            args.text
        };
        let request = TtsRequest {
            provider,
            model: args.model,
            text,
            voice: args.voice,
            speakers: Vec::new(),
            // 기본 억양 = 미국식(설정 보이스 리스트는 미국 억양 기준 큐레이션). OpenAI=instructions / Gemini=프롬프트.
            style: Some("Speak naturally with a standard American English accent.".to_string()),
            align: false, // 보이스 샘플 미리듣기 — 짧은 문장, LRC 정렬 불필요
        };
        match tts.synthesize(&request).await {
            Ok(r) => {
                let url = self
                    .manager
                    .save_conv_attachment(conv, &name, &r.audio)
                    .await
                    .map_err(TonicStatus::internal)?;
                Ok(Response::new(TtsSampleResponse {
                    url,
                    content_type: r.content_type,
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
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

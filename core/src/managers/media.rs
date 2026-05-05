//! MediaManager — 미디어 도메인 단일 매니저.
//!
//! 옛 TS `core/managers/media-manager.ts` 1:1 port. Phase B-18 Step 2d 박힘.
//!
//! 책임:
//!   1) 이미지 생성 오케스트레이션 + 후처리 파이프라인 (resolve reference + imageGen.generate +
//!      aspectRatio crop + variants/blurhash/thumbnail/메타 업데이트)
//!   2) 미디어 CRUD (read/list/remove/stat) — IMediaPort thin wrapper
//!   3) 갤러리 재생성 (regenerate_image_by_slug) — 기존 메타에서 prompt/model/aspectRatio 그대로
//!   4) 외부 노출 안전성 (is_media_ready) — og:image 등 SNS 캐싱 보호
//!   5) 이미지 모델·기본 size/quality 설정 (Vault `system:image-model` 등)
//!   6) SEO 이미지 후처리 설정 (variants, blurhash, thumbnail 등)
//!
//! 향후 확장: 동영상 (generate_video), 오디오 등도 같은 매니저에서 — generate_image 와 일관 인터페이스.
//!
//! BIBLE 준수:
//!   - SSE 발행 X (Core facade 의 책임 — generate_image / regenerate_image / remove_media 결과로 emit)
//!   - 매니저 간 직접 호출 X — Core 가 status_mgr 와 연결

use std::sync::Arc;
use std::time::SystemTime;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::managers::cost::CostManager;
use crate::managers::episodic::EpisodicManager;
use crate::managers::event::EventManager;
use crate::managers::status::StatusManager;
use crate::ports::{
    FitMode, IImageGenPort, IImageProcessorPort, ILogPort, IMediaPort, IVaultPort, ImageFormat,
    ImageGenCallOpts, ImageGenOpts, ImageModelInfo, ImageReferenceImage, InfraResult,
    MediaFileRecord, MediaListOpts, MediaListResult, MediaSaveOptions, MediaSaveResult,
    MediaScope, MediaVariant, MediaVariantMeta, ResizeOpts, SaveEventInput,
};
use crate::vault_keys::{vk_module_settings, VK_IMAGE_MODEL, VK_IMAGE_QUALITY, VK_IMAGE_SIZE};

// ── SeoImageSettings (옛 TS DEFAULT_IMAGE_SETTINGS 1:1) ────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeoImageSettings {
    pub webp: bool,
    pub avif: bool,
    pub thumbnail: bool,
    pub variants: Vec<i64>,
    pub blurhash: bool,
    pub strip_exif: bool,
    pub progressive: bool,
    pub default_quality: u8,
    pub keep_original: bool,
}

impl Default for SeoImageSettings {
    fn default() -> Self {
        Self {
            webp: true,
            avif: true,
            thumbnail: true,
            variants: vec![480, 768, 1024],
            blurhash: true,
            strip_exif: true,
            progressive: true,
            default_quality: 85,
            keep_original: true,
        }
    }
}

// ── GenerateImageInput / Result (옛 TS 1:1) ────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GenerateImageInput {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "filenameHint", default, skip_serializing_if = "Option::is_none")]
    pub filename_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MediaScope>,
    #[serde(rename = "aspectRatio", default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    /// `"attention" | "entropy" | "center"` 또는 `{"x": 0.5, "y": 0.5}` (옛 TS 1:1).
    /// 직렬화 일반화: focus_point 는 string 또는 object — Value 그대로 보존.
    #[serde(rename = "focusPoint", default, skip_serializing_if = "Option::is_none")]
    pub focus_point: Option<serde_json::Value>,
    #[serde(rename = "referenceImage", default, skip_serializing_if = "Option::is_none")]
    pub reference_image: Option<ReferenceImageInput>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReferenceImageInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GenerateImageResult {
    pub url: String,
    #[serde(rename = "thumbnailUrl", default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<MediaVariant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blurhash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    pub slug: String,
    #[serde(rename = "revisedPrompt", default, skip_serializing_if = "Option::is_none")]
    pub revised_prompt: Option<String>,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "aspectRatio", default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(rename = "costUsd", default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

// ── 헬퍼 함수 (옛 TS 1:1) ────────────────────────────────────────────────────

/// `"1024x1024"` / `"1024"` / `None` → `(width, height)`.
/// 미박음 시 1024x1024 default — placeholder 용 (백그라운드에서 실제 크기로 교체).
fn parse_size_hint(size: Option<&str>) -> (u32, u32) {
    let s = match size {
        Some(s) => s,
        None => return (1024, 1024),
    };
    if let Some((w_str, h_str)) = s.split_once('x') {
        if let (Ok(w), Ok(h)) = (w_str.parse::<u32>(), h_str.parse::<u32>()) {
            return (w, h);
        }
    }
    if let Ok(single) = s.parse::<u32>() {
        if single > 0 {
            return (single, single);
        }
    }
    (1024, 1024)
}

/// `"16:9"` → `Some((16, 9))` / 잘못된 포맷은 `None`.
fn parse_aspect_ratio(s: &str) -> Option<(u32, u32)> {
    let trimmed = s.trim();
    let (w_str, h_str) = trimmed.split_once(':')?;
    let w = w_str.trim().parse::<u32>().ok()?;
    let h = h_str.trim().parse::<u32>().ok()?;
    if w == 0 || h == 0 {
        return None;
    }
    Some((w, h))
}

/// 원본 치수에 target ratio 적용 — 한 축 고정, 다른 축 깎음 (옛 TS computeCropDims 1:1).
fn compute_crop_dims(orig_w: u32, orig_h: u32, rw: u32, rh: u32) -> (u32, u32) {
    let orig_ratio = orig_w as f32 / orig_h as f32;
    let target_ratio = rw as f32 / rh as f32;
    if orig_ratio > target_ratio {
        // 원본이 더 가로로 넓음 → height 기준 width 깎음
        ((orig_h as f32 * target_ratio).round() as u32, orig_h)
    } else {
        // 원본이 더 세로로 김 → width 기준 height 깎음
        (orig_w, (orig_w as f32 / target_ratio).round() as u32)
    }
}

/// `"png"` / `"image/png"` → ImageFormat. 미지원 시 `Png` 폴백 (일반 로직).
/// 헬퍼 — 외부 호출 시점에 사용 (현재 generate_image 안 format_to_string 으로 충분).
#[allow(dead_code)]
fn parse_format(s: &str) -> ImageFormat {
    match s.to_lowercase().as_str() {
        "webp" | "image/webp" => ImageFormat::Webp,
        "avif" | "image/avif" => ImageFormat::Avif,
        "jpeg" | "jpg" | "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        _ => ImageFormat::Png,
    }
}

/// content_type → 확장자. 옛 TS finalizeBase 의 ext 결정 1:1.
fn ext_from_content_type(ct: &str) -> &'static str {
    if ct.contains("jpeg") || ct.contains("jpg") {
        "jpg"
    } else if ct.contains("webp") {
        "webp"
    } else if ct.contains("avif") {
        "avif"
    } else {
        "png"
    }
}

/// `serde_json::Value` (string 또는 object) → CropPosition. 옛 TS focusPoint 1:1.
fn parse_focus_point(v: &serde_json::Value) -> crate::ports::CropPosition {
    use crate::ports::CropPosition;
    if let Some(s) = v.as_str() {
        return match s {
            "attention" => CropPosition::Attention,
            "entropy" => CropPosition::Entropy,
            _ => CropPosition::Center,
        };
    }
    if let Some(obj) = v.as_object() {
        let x = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.5) as f32;
        let y = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.5) as f32;
        return CropPosition::Focus { x, y };
    }
    CropPosition::Attention
}

/// `lib/media-url.ts` `parseMediaUrl` 1:1 — `/user/media/<slug>.<ext>` 형식 파싱.
/// 절대 URL 도 path 추출 후 동일 로직.
fn parse_media_url(url: &str) -> Option<(MediaScope, String, String)> {
    // 절대 URL 처리 — `https://example.com/user/media/abc.png` → path 만 추출
    let path = if let Some(idx) = url.find("//") {
        let after_scheme = &url[idx + 2..];
        match after_scheme.find('/') {
            Some(p) => &after_scheme[p..],
            None => return None,
        }
    } else {
        url
    };
    // `/user/media/<slug>.<ext>` 또는 `/system/media/<slug>.<ext>`
    let parts: Vec<&str> = path.trim_start_matches('/').splitn(3, '/').collect();
    if parts.len() < 3 {
        return None;
    }
    let scope = match parts[0] {
        "user" => MediaScope::User,
        "system" => MediaScope::System,
        _ => return None,
    };
    if parts[1] != "media" {
        return None;
    }
    let filename = parts[2];
    let (slug, ext) = filename.rsplit_once('.')?;
    Some((scope, slug.to_string(), ext.to_string()))
}

// ── MediaManager ─────────────────────────────────────────────────────────────

pub struct MediaManager {
    media: Arc<dyn IMediaPort>,
    /// IImageGenPort + IImageProcessorPort + IVaultPort + ILogPort — Step 2d 박힘.
    /// 모두 Optional builder — 박히기 전엔 thin wrapper (옛 호환).
    image_gen: Option<Arc<dyn IImageGenPort>>,
    processor: Option<Arc<dyn IImageProcessorPort>>,
    vault: Option<Arc<dyn IVaultPort>>,
    log: Option<Arc<dyn ILogPort>>,
    /// Cross-call hooks (옛 TS Core facade 의 startImageGeneration / generateImage 패턴 1:1):
    /// - cost: ImageGenResult.cost_usd 박혀있으면 자동 record_llm_cost (CostManager)
    /// - status: 이미지 생성 시작 → start, 완료 → done, 실패 → fail (StatusManager / 어드민 ActiveJobsIndicator)
    /// - event: 갤러리 SSE refresh + status 변경 broadcast (EventManager / GalleryPanel)
    /// - episodic: 'image_gen' 사건 자동 리콜 누적 (EpisodicManager / AI 미개입)
    cost: Option<Arc<CostManager>>,
    status: Option<Arc<StatusManager>>,
    event: Option<Arc<EventManager>>,
    episodic: Option<Arc<EpisodicManager>>,
}

impl MediaManager {
    pub fn new(media: Arc<dyn IMediaPort>) -> Self {
        Self {
            media,
            image_gen: None,
            processor: None,
            vault: None,
            log: None,
            cost: None,
            status: None,
            event: None,
            episodic: None,
        }
    }

    pub fn with_image_gen(mut self, image_gen: Arc<dyn IImageGenPort>) -> Self {
        self.image_gen = Some(image_gen);
        self
    }

    pub fn with_processor(mut self, processor: Arc<dyn IImageProcessorPort>) -> Self {
        self.processor = Some(processor);
        self
    }

    pub fn with_vault(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.vault = Some(vault);
        self
    }

    pub fn with_log(mut self, log: Arc<dyn ILogPort>) -> Self {
        self.log = Some(log);
        self
    }

    /// Cross-call hooks (옛 TS Core facade 패턴 1:1) — 박히면 자동 forward.
    pub fn with_cost(mut self, cost: Arc<CostManager>) -> Self {
        self.cost = Some(cost);
        self
    }

    pub fn with_status(mut self, status: Arc<StatusManager>) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_event(mut self, event: Arc<EventManager>) -> Self {
        self.event = Some(event);
        self
    }

    pub fn with_episodic(mut self, episodic: Arc<EpisodicManager>) -> Self {
        self.episodic = Some(episodic);
        self
    }

    fn log_info(&self, msg: &str) {
        if let Some(log) = &self.log {
            log.info(msg);
        }
    }

    fn log_error(&self, msg: &str) {
        if let Some(log) = &self.log {
            log.error(msg);
        }
    }

    // ── 이미지 모델·기본값 (Vault 영속) ─────────────────────────────────────

    pub fn get_image_model(&self) -> String {
        if let Some(vault) = &self.vault {
            if let Some(stored) = vault.get_secret(VK_IMAGE_MODEL).filter(|s| !s.is_empty()) {
                return stored;
            }
        }
        self.image_gen
            .as_ref()
            .map(|g| g.get_model_id())
            .unwrap_or_default()
    }

    pub fn set_image_model(&self, model_id: &str) -> InfraResult<()> {
        let vault = self.vault.as_ref().ok_or_else(|| "Vault 미박음".to_string())?;
        if vault.set_secret(VK_IMAGE_MODEL, model_id) {
            Ok(())
        } else {
            Err("Vault 저장 실패".to_string())
        }
    }

    pub fn get_image_default_size(&self) -> Option<String> {
        self.vault
            .as_ref()
            .and_then(|v| v.get_secret(VK_IMAGE_SIZE))
            .filter(|s| !s.is_empty())
    }

    pub fn set_image_default_size(&self, size: Option<&str>) -> InfraResult<()> {
        let vault = self.vault.as_ref().ok_or_else(|| "Vault 미박음".to_string())?;
        let ok = match size {
            None => vault.delete_secret(VK_IMAGE_SIZE),
            Some(s) => vault.set_secret(VK_IMAGE_SIZE, s),
        };
        if ok { Ok(()) } else { Err("Vault 저장 실패".to_string()) }
    }

    pub fn get_image_default_quality(&self) -> Option<String> {
        self.vault
            .as_ref()
            .and_then(|v| v.get_secret(VK_IMAGE_QUALITY))
            .filter(|s| !s.is_empty())
    }

    pub fn set_image_default_quality(&self, quality: Option<&str>) -> InfraResult<()> {
        let vault = self.vault.as_ref().ok_or_else(|| "Vault 미박음".to_string())?;
        let ok = match quality {
            None => vault.delete_secret(VK_IMAGE_QUALITY),
            Some(q) => vault.set_secret(VK_IMAGE_QUALITY, q),
        };
        if ok { Ok(()) } else { Err("Vault 저장 실패".to_string()) }
    }

    pub fn list_image_models(&self) -> Vec<ImageModelInfo> {
        self.image_gen
            .as_ref()
            .map(|g| g.list_models())
            .unwrap_or_default()
    }

    /// SEO 설정 `system:module:seo:settings` 의 image_* 필드 1:1 — 옛 TS getImageSettings.
    /// 미박음 / 파싱 실패 시 default 폴백.
    pub fn get_image_settings(&self) -> SeoImageSettings {
        let Some(vault) = &self.vault else {
            return SeoImageSettings::default();
        };
        let Some(raw) = vault.get_secret(&vk_module_settings("seo")) else {
            return SeoImageSettings::default();
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => return SeoImageSettings::default(),
        };
        let Some(obj) = parsed.as_object() else {
            return SeoImageSettings::default();
        };
        let mut s = SeoImageSettings::default();
        if let Some(v) = obj.get("imageWebp").and_then(|v| v.as_bool()) {
            s.webp = v;
        }
        if let Some(v) = obj.get("imageAvif").and_then(|v| v.as_bool()) {
            s.avif = v;
        }
        if let Some(v) = obj.get("imageThumbnail").and_then(|v| v.as_bool()) {
            s.thumbnail = v;
        }
        if let Some(v) = obj.get("imageBlurhash").and_then(|v| v.as_bool()) {
            s.blurhash = v;
        }
        if let Some(v) = obj.get("imageStripExif").and_then(|v| v.as_bool()) {
            s.strip_exif = v;
        }
        if let Some(v) = obj.get("imageProgressive").and_then(|v| v.as_bool()) {
            s.progressive = v;
        }
        if let Some(v) = obj.get("imageKeepOriginal").and_then(|v| v.as_bool()) {
            s.keep_original = v;
        }
        if let Some(q) = obj.get("imageDefaultQuality") {
            if let Some(n) = q.as_u64() {
                s.default_quality = n.min(100) as u8;
            } else if let Some(s_str) = q.as_str() {
                if let Ok(n) = s_str.parse::<u8>() {
                    s.default_quality = n;
                }
            }
        }
        // imageVariants — 옛 TS 의 array OR CSV string 둘 다 허용 (일반 로직).
        if let Some(v) = obj.get("imageVariants") {
            let parsed_variants: Vec<i64> = if let Some(arr) = v.as_array() {
                arr.iter()
                    .filter_map(|x| x.as_i64().filter(|n| *n > 0))
                    .collect()
            } else if let Some(s_str) = v.as_str() {
                s_str
                    .split(',')
                    .filter_map(|t| t.trim().parse::<i64>().ok().filter(|n| *n > 0))
                    .collect()
            } else {
                Vec::new()
            };
            if !parsed_variants.is_empty() {
                s.variants = parsed_variants;
            }
        }
        s
    }

    // ── 미디어 CRUD (IMediaPort thin wrapper) ───────────────────────────────

    pub async fn save(
        &self,
        binary: &[u8],
        content_type: &str,
        opts: MediaSaveOptions,
    ) -> InfraResult<MediaSaveResult> {
        self.media.save(binary, content_type, &opts).await
    }

    pub async fn save_error_record(
        &self,
        opts: MediaSaveOptions,
        error_msg: &str,
    ) -> InfraResult<String> {
        self.media.save_error_record(&opts, error_msg).await
    }

    pub async fn read(
        &self,
        slug: &str,
    ) -> InfraResult<Option<(Vec<u8>, String, MediaFileRecord)>> {
        self.media.read(slug).await
    }

    pub async fn stat(&self, slug: &str) -> InfraResult<Option<MediaFileRecord>> {
        self.media.stat(slug).await
    }

    pub async fn remove(&self, slug: &str) -> InfraResult<()> {
        self.media.remove(slug).await
    }

    pub async fn list(&self, opts: MediaListOpts) -> InfraResult<MediaListResult> {
        self.media.list(&opts).await
    }

    pub async fn update_meta(
        &self,
        slug: &str,
        patch: &serde_json::Value,
    ) -> InfraResult<()> {
        self.media.update_meta(slug, patch).await
    }

    /// og:image 외부 노출 안전성 — 미디어 URL 인 경우 status='done' && bytes>0 일 때만.
    /// 외부 URL 은 항상 true (우리 책임 X). 옛 TS `isMediaReady` 1:1.
    pub async fn is_media_ready(&self, url: &str) -> bool {
        if url.trim().is_empty() {
            return false;
        }
        let Some((_, slug, _)) = parse_media_url(url) else {
            return true; // 외부 URL — 통과
        };
        match self.media.stat(&slug).await {
            Ok(Some(record)) => {
                let status = record.status.as_deref().unwrap_or("done");
                status == "done" && record.bytes > 0
            }
            _ => false,
        }
    }

    /// `slug` 직접 — og:image 가드 단순화 버전 (옛 호환).
    pub async fn is_ready(&self, slug: &str) -> bool {
        match self.media.stat(slug).await {
            Ok(Some(record)) => {
                let done = record.status.as_deref().unwrap_or("done") == "done";
                done && record.bytes > 0
            }
            _ => false,
        }
    }

    // ── 이미지 생성·재생성 (옛 TS 1:1) ──────────────────────────────────────

    /// 갤러리에서 재생성 — 기존 메타의 prompt/model/size/quality/aspectRatio 재추출 → 재실행.
    /// prompt 미박음 (legacy record) → error.
    pub async fn regenerate_image_by_slug(
        self: &Arc<Self>,
        slug: &str,
    ) -> InfraResult<(GenerateImageResult, String)> {
        let stat = self
            .media
            .stat(slug)
            .await?
            .ok_or_else(|| "미디어를 찾을 수 없습니다.".to_string())?;
        let prompt = stat
            .prompt
            .clone()
            .ok_or_else(|| "프롬프트 정보가 없어 재생성할 수 없습니다.".to_string())?;
        let input = GenerateImageInput {
            prompt,
            model: stat.model.clone(),
            size: stat.size.clone(),
            quality: stat.quality.clone(),
            filename_hint: stat.filename_hint.clone(),
            scope: stat.scope,
            aspect_ratio: stat.aspect_ratio.clone(),
            ..Default::default()
        };
        let result = self.generate_image(input, None).await?;
        Ok((result, slug.to_string()))
    }

    /// 비동기 image_gen — 즉시 placeholder 저장 + slug/url 반환, 실제 생성은 백그라운드.
    /// AI image_gen 도구가 호출 → 즉시 URL 받아 page spec 박고 save_page 발행 가능.
    /// 사용자 페이지 reload 시 placeholder → 실제 이미지로 swap.
    ///
    /// Cross-call hooks (옛 TS Core facade 1:1):
    ///   - status.start (type='image', meta=async/promptPreview/model/scope)
    ///   - 백그라운드 완료: status.done + event.notify_gallery + cost.record (cost_usd 박혀있으면)
    ///   - 백그라운드 실패: status.fail + event.notify_gallery (error)
    ///   - placeholder 등장 즉시 event.notify_gallery (사용자가 "렌더링중" 카드 봄)
    pub async fn start_generate(
        self: &Arc<Self>,
        input: GenerateImageInput,
    ) -> InfraResult<(String, String)> {
        let processor = self
            .processor
            .as_ref()
            .ok_or_else(|| "image_processor 미박음 — placeholder 생성 불가".to_string())?;
        let scope = input.scope.unwrap_or(MediaScope::User);

        // Cross-call hook 1: status.start — 어드민 ActiveJobsIndicator 가시화 (옛 TS 1:1)
        let status_job_id: Option<String> = if let Some(status) = &self.status {
            let prompt_preview: String = input.prompt.chars().take(80).collect();
            let model = input.model.clone().unwrap_or_else(|| self.get_image_model());
            let job = status.start(
                None,
                "image".to_string(),
                Some("이미지 생성 시작 (백그라운드)...".to_string()),
                None,
                serde_json::json!({
                    "promptPreview": prompt_preview,
                    "model": model,
                    "scope": scope.as_str(),
                    "async": true,
                }),
            );
            Some(job.id)
        } else {
            None
        };

        let (ph_w, ph_h) = parse_size_hint(input.size.as_deref());
        let placeholder = processor.create_placeholder(ph_w, ph_h).await?;

        let save_opts = MediaSaveOptions {
            ext: None,
            filename_hint: input.filename_hint.clone(),
            scope: Some(scope),
            prompt: Some(input.prompt.clone()),
            revised_prompt: None,
            model: Some(self.get_image_model()),
            size: input.size.clone(),
            quality: input.quality.clone(),
            aspect_ratio: input.aspect_ratio.clone(),
            source: Some("ai-generated".to_string()),
        };
        let saved = self
            .media
            .save(&placeholder, "image/png", &save_opts)
            .await?;
        // status='rendering' 마킹 — 갤러리 UI 가 spinner / 빨간 테두리 분기
        let _ = self
            .media
            .update_meta(
                &saved.slug,
                &serde_json::json!({"status": "rendering"}),
            )
            .await;

        // Cross-call hook: placeholder 등장 즉시 갤러리 SSE — "렌더링중" 카드 가시화 (옛 TS 1:1)
        if let Some(event) = &self.event {
            event.notify_gallery(serde_json::json!({
                "slug": saved.slug,
                "scope": scope.as_str(),
            }));
        }

        self.log_info(&format!(
            "[MediaManager] startGenerate: placeholder slug={} url={} — 백그라운드 생성 시작",
            saved.slug, saved.url
        ));

        // 백그라운드 — generate_image existing_slug 모드. caller 즉시 반환.
        let mgr = self.clone();
        let bg_input = input.clone();
        let bg_slug = saved.slug.clone();
        let bg_scope = scope;
        let bg_status_id = status_job_id.clone();
        tokio::spawn(async move {
            let result = mgr.generate_image(bg_input, Some(&bg_slug)).await;
            match result {
                Ok(success) => {
                    // Cross-call hook 2: status.complete — 백그라운드 완료 (옛 TS 1:1)
                    if let (Some(status), Some(jid)) = (&mgr.status, &bg_status_id) {
                        status.complete(
                            jid,
                            Some(serde_json::json!({
                                "slug": success.slug,
                                "url": success.url,
                            })),
                        );
                    }
                    // Cross-call hook 3: event.notify_gallery — placeholder → 실제 이미지 swap 알림
                    if let Some(event) = &mgr.event {
                        event.notify_gallery(serde_json::json!({
                            "slug": success.slug,
                            "scope": bg_scope.as_str(),
                        }));
                    }
                    // Cross-call hook 4: cost.record — 비동기 흐름 (AiManager 못 받음, MediaManager 가 박음)
                    if let (Some(cost), Some(usd)) = (&mgr.cost, success.cost_usd) {
                        if usd > 0.0 {
                            cost.record(&success.model_id, 0, 0, 0, usd, Some("image_gen"));
                        }
                    }
                    // Cross-call hook 5: episodic.save_event — image_gen 사건 자동 리콜 (AI 미개입)
                    if let Some(episodic) = &mgr.episodic {
                        let prompt_preview: String =
                            mgr.recall_prompt_for(&success.slug).await.unwrap_or_default();
                        let _ = episodic
                            .save_event(SaveEventInput {
                                event_type: "image_gen".to_string(),
                                title: format!(
                                    "이미지 생성: {}",
                                    prompt_preview.chars().take(60).collect::<String>()
                                ),
                                description: None,
                                who: Some("media:start_generate".to_string()),
                                context: Some(serde_json::json!({
                                    "slug": success.slug,
                                    "model": success.model_id,
                                    "scope": bg_scope.as_str(),
                                    "promptPreview": prompt_preview.chars().take(200).collect::<String>(),
                                    "costUsd": success.cost_usd,
                                })),
                                occurred_at: None,
                                entity_ids: vec![],
                                source_conv_id: None,
                                ttl_days: None,
                                dedup_threshold: None,
                            })
                            .await;
                    }
                }
                Err(e) => {
                    // Cross-call hook 2 (실패): status.fail
                    if let (Some(status), Some(jid)) = (&mgr.status, &bg_status_id) {
                        status.fail(jid, e.clone());
                    }
                    // Cross-call hook 3 (실패): event.notify_gallery error
                    if let Some(event) = &mgr.event {
                        event.notify_gallery(serde_json::json!({
                            "error": e,
                            "scope": bg_scope.as_str(),
                        }));
                    }
                    let _ = mgr
                        .media
                        .update_meta(
                            &bg_slug,
                            &serde_json::json!({"status": "error", "errorMsg": e}),
                        )
                        .await;
                    mgr.log_error(&format!(
                        "[MediaManager] 백그라운드 generate_image 실패 (slug={} scope={}): {e}",
                        bg_slug,
                        bg_scope.as_str()
                    ));
                }
            }
        });

        Ok((saved.slug, saved.url))
    }

    /// `recall_prompt_for(slug)` — episodic 리콜 시 prompt 메타 추출 (실패 시 빈 string).
    async fn recall_prompt_for(&self, slug: &str) -> Option<String> {
        self.media
            .stat(slug)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.prompt)
    }

    /// AI image_gen 도구 → MediaManager.generate_image → 생성 + 후처리 + 저장.
    /// existing_slug 박혀있으면 placeholder 파일을 finalize_base 로 교체 (비동기 모드 완료 단계).
    pub async fn generate_image(
        self: &Arc<Self>,
        input: GenerateImageInput,
        existing_slug: Option<&str>,
    ) -> InfraResult<GenerateImageResult> {
        let started_at = SystemTime::now();
        let image_gen = self
            .image_gen
            .as_ref()
            .ok_or_else(|| "image_gen 미박음 — 이미지 생성 불가".to_string())?;
        let processor = self
            .processor
            .as_ref()
            .ok_or_else(|| "image_processor 미박음 — 후처리 불가".to_string())?;

        let model_id = input
            .model
            .clone()
            .unwrap_or_else(|| self.get_image_model());
        let scope = input.scope.unwrap_or(MediaScope::User);
        let settings = self.get_image_settings();
        let size = input
            .size
            .clone()
            .or_else(|| self.get_image_default_size());
        let quality = input
            .quality
            .clone()
            .or_else(|| self.get_image_default_quality());
        self.log_info(&format!(
            "[MediaManager] [{model_id}] generate_image 시작: prompt={} size={} quality={}",
            input.prompt.chars().take(100).collect::<String>(),
            size.as_deref().unwrap_or("handler-default"),
            quality.as_deref().unwrap_or("handler-default")
        ));

        // 1) referenceImage resolve (image-to-image)
        let reference_image = self.resolve_reference_image(input.reference_image.as_ref()).await;

        // 2) image_gen.generate
        let gen_opts = ImageGenOpts {
            prompt: input.prompt.clone(),
            size: size.clone(),
            quality: quality.clone(),
            style: None,
            n: None,
            model: Some(model_id.clone()),
            reference_image,
        };
        let call_opts = ImageGenCallOpts {
            model: Some(model_id.clone()),
            corr_id: None,
        };
        let gen_result = match image_gen.generate(&gen_opts, &call_opts).await {
            Ok(r) => r,
            Err(e) => {
                self.log_error(&format!("[MediaManager] [{model_id}] 생성 실패: {e}"));
                // 실패 기록 — 갤러리에서 사용자가 prompt 보고 재시도/삭제 가능
                let err_opts = MediaSaveOptions {
                    filename_hint: input.filename_hint.clone(),
                    scope: Some(scope),
                    prompt: Some(input.prompt.clone()),
                    model: Some(model_id.clone()),
                    size: size.clone(),
                    quality: quality.clone(),
                    aspect_ratio: input.aspect_ratio.clone(),
                    source: Some("ai-generated".to_string()),
                    ..Default::default()
                };
                let _ = self.media.save_error_record(&err_opts, &e).await;
                return Err(e);
            }
        };
        let elapsed_ms = started_at.elapsed().map(|d| d.as_millis()).unwrap_or(0);
        self.log_info(&format!(
            "[MediaManager] [{model_id}] binary 수신 ({}ms, {} bytes, {})",
            elapsed_ms,
            gen_result.binary.len(),
            gen_result.content_type
        ));

        // 3) aspectRatio crop — 지정 시 base binary 교체
        let mut base_binary = gen_result.binary.clone();
        let base_content_type = gen_result.content_type.clone();
        let mut applied_aspect_ratio: Option<String> = None;
        let focus_point_value = input
            .focus_point
            .clone()
            .unwrap_or_else(|| serde_json::Value::String("attention".to_string()));
        if let Some(ar_str) = &input.aspect_ratio {
            if let Some((rw, rh)) = parse_aspect_ratio(ar_str) {
                if let Ok(meta) = processor.get_metadata(&base_binary).await {
                    if meta.width > 0 && meta.height > 0 {
                        let target = compute_crop_dims(meta.width, meta.height, rw, rh);
                        let diff = (meta.width as f32 / meta.height as f32
                            - rw as f32 / rh as f32)
                            .abs();
                        if diff < 0.01 {
                            applied_aspect_ratio = Some(ar_str.clone());
                        } else {
                            let crop_opts = ResizeOpts {
                                width: Some(target.0),
                                height: Some(target.1),
                                fit: Some(FitMode::Cover),
                                position: Some(parse_focus_point(&focus_point_value)),
                                strip_metadata: Some(settings.strip_exif),
                                ..Default::default()
                            };
                            match processor.process(&base_binary, &crop_opts).await {
                                Ok(cropped) => {
                                    base_binary = cropped;
                                    applied_aspect_ratio = Some(ar_str.clone());
                                }
                                Err(e) => self.log_info(&format!(
                                    "[MediaManager] crop 실패 ({e}) — 원본 유지"
                                )),
                            }
                        }
                    }
                }
            }
        }

        // 4) base 저장 또는 placeholder 교체
        let saved = if let Some(slug) = existing_slug {
            self.media
                .finalize_base(slug, scope.as_str(), &base_binary, &base_content_type, None)
                .await?;
            let final_ext = ext_from_content_type(&base_content_type);
            // revised_prompt 만 추가 갱신 — 다른 메타는 startGenerate 가 박음, 마지막 update_meta 에서 status='done'
            if let Some(rp) = &gen_result.revised_prompt {
                let _ = self
                    .media
                    .update_meta(slug, &serde_json::json!({"revisedPrompt": rp}))
                    .await;
            }
            MediaSaveResult {
                slug: slug.to_string(),
                url: format!("/{}/media/{}.{}", scope.as_str(), slug, final_ext),
                thumbnail_url: None,
                variants: Vec::new(),
                blurhash: None,
                width: None,
                height: None,
                bytes: base_binary.len() as i64,
            }
        } else {
            let save_opts = MediaSaveOptions {
                filename_hint: input.filename_hint.clone(),
                scope: Some(scope),
                prompt: Some(input.prompt.clone()),
                revised_prompt: gen_result.revised_prompt.clone(),
                model: Some(model_id.clone()),
                size: size.clone(),
                quality: quality.clone(),
                aspect_ratio: applied_aspect_ratio.clone(),
                source: Some("ai-generated".to_string()),
                ..Default::default()
            };
            self.media
                .save(&base_binary, &base_content_type, &save_opts)
                .await?
        };

        // 5) 메타데이터 파싱
        let meta = processor.get_metadata(&base_binary).await.ok();
        let original_width = meta.as_ref().map(|m| m.width as i64);
        let original_height = meta.as_ref().map(|m| m.height as i64);

        // 6) variants 생성 — settings 기반
        let mut variants: Vec<MediaVariant> = Vec::new();
        let mut thumbnail_url: Option<String> = None;
        let mut blurhash: Option<String> = None;

        // 6-1) 원본 크기 WebP/AVIF (settings.webp/avif 활성 시)
        let mut full_formats: Vec<ImageFormat> = Vec::new();
        if settings.webp {
            full_formats.push(ImageFormat::Webp);
        }
        if settings.avif {
            full_formats.push(ImageFormat::Avif);
        }
        for format in &full_formats {
            let opts = ResizeOpts {
                format: Some(format.clone()),
                quality: Some(settings.default_quality),
                progressive: Some(settings.progressive),
                strip_metadata: Some(settings.strip_exif),
                ..Default::default()
            };
            let buf = match processor.process(&base_binary, &opts).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            let format_str = format_to_string(format);
            let v_meta = MediaVariantMeta {
                width: original_width.unwrap_or(0),
                height: original_height,
                format: format_str.to_string(),
                bytes: buf.len() as i64,
            };
            if let Ok(url) = self
                .media
                .save_variant(&saved.slug, scope.as_str(), "full", format_str, &buf, &v_meta)
                .await
            {
                variants.push(MediaVariant {
                    width: original_width.unwrap_or(0),
                    height: original_height,
                    format: format_str.to_string(),
                    url,
                    bytes: buf.len() as i64,
                });
            }
        }

        // 6-2) 반응형 variants — 원본보다 작은 width 만
        for w in &settings.variants {
            if let Some(ow) = original_width {
                if *w >= ow {
                    continue;
                }
            }
            for format in &full_formats {
                let opts = ResizeOpts {
                    width: Some(*w as u32),
                    fit: Some(FitMode::Inside),
                    format: Some(format.clone()),
                    quality: Some(settings.default_quality),
                    progressive: Some(settings.progressive),
                    strip_metadata: Some(settings.strip_exif),
                    ..Default::default()
                };
                let buf = match processor.process(&base_binary, &opts).await {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let format_str = format_to_string(format);
                let suffix = format!("{}w", w);
                let v_meta = MediaVariantMeta {
                    width: *w,
                    height: None,
                    format: format_str.to_string(),
                    bytes: buf.len() as i64,
                };
                if let Ok(url) = self
                    .media
                    .save_variant(&saved.slug, scope.as_str(), &suffix, format_str, &buf, &v_meta)
                    .await
                {
                    variants.push(MediaVariant {
                        width: *w,
                        height: None,
                        format: format_str.to_string(),
                        url,
                        bytes: buf.len() as i64,
                    });
                }
            }
        }

        // 6-3) 썸네일 256px webp (settings.thumbnail 활성 시)
        if settings.thumbnail {
            let opts = ResizeOpts {
                width: Some(256),
                fit: Some(FitMode::Inside),
                format: Some(ImageFormat::Webp),
                quality: Some(80),
                strip_metadata: Some(settings.strip_exif),
                ..Default::default()
            };
            if let Ok(buf) = processor.process(&base_binary, &opts).await {
                let v_meta = MediaVariantMeta {
                    width: 256,
                    height: None,
                    format: "webp".to_string(),
                    bytes: buf.len() as i64,
                };
                if let Ok(url) = self
                    .media
                    .save_variant(&saved.slug, scope.as_str(), "thumb", "webp", &buf, &v_meta)
                    .await
                {
                    thumbnail_url = Some(url);
                }
            }
        }

        // 6-4) blurhash LQIP
        if settings.blurhash {
            if let Ok(b) = processor.blurhash(&base_binary, None).await {
                blurhash = Some(b);
            }
        }

        // 7) 메타 update — variants/thumbnail/blurhash/width/height + status='done'
        let mut patch = serde_json::Map::new();
        patch.insert("status".to_string(), serde_json::json!("done"));
        if let Some(w) = original_width {
            patch.insert("width".to_string(), serde_json::json!(w));
        }
        if let Some(h) = original_height {
            patch.insert("height".to_string(), serde_json::json!(h));
        }
        if !variants.is_empty() {
            patch.insert(
                "variants".to_string(),
                serde_json::to_value(&variants).unwrap_or(serde_json::Value::Null),
            );
        }
        if let Some(t) = &thumbnail_url {
            patch.insert("thumbnailUrl".to_string(), serde_json::json!(t));
        }
        if let Some(b) = &blurhash {
            patch.insert("blurhash".to_string(), serde_json::json!(b));
        }
        let _ = self
            .media
            .update_meta(&saved.slug, &serde_json::Value::Object(patch))
            .await;

        let total_ms = started_at.elapsed().map(|d| d.as_millis()).unwrap_or(0);
        self.log_info(&format!(
            "[MediaManager] [{model_id}] 완료 ({}ms, slug={}, variants={})",
            total_ms,
            saved.slug,
            variants.len()
        ));

        let result = GenerateImageResult {
            url: saved.url.clone(),
            thumbnail_url,
            variants,
            blurhash,
            width: original_width.or(gen_result.width.map(|w| w as i64)),
            height: original_height.or(gen_result.height.map(|h| h as i64)),
            slug: saved.slug.clone(),
            revised_prompt: gen_result.revised_prompt.clone(),
            model_id: model_id.clone(),
            aspect_ratio: applied_aspect_ratio,
            cost_usd: gen_result.cost_usd,
        };

        // sync 경로 cross-call hooks (옛 TS Core.generateImage 1:1).
        // existing_slug 박힌 (start_generate 백그라운드) 경로는 caller 가 wrap 하므로 skip —
        // 본 hook 은 직접 호출 (채팅 이미지 모드 등) 에서만.
        if existing_slug.is_none() {
            // event.notify_gallery — 갤러리 즉시 갱신
            if let Some(event) = &self.event {
                event.notify_gallery(serde_json::json!({
                    "slug": result.slug,
                    "scope": scope.as_str(),
                }));
            }
            // cost.record — costUsd 박혀있으면 LLM 비용 통계 누적 (옛 TS Core.recordLlmCost 1:1)
            if let (Some(cost), Some(usd)) = (&self.cost, result.cost_usd) {
                if usd > 0.0 {
                    cost.record(&result.model_id, 0, 0, 0, usd, Some("image_gen"));
                }
            }
            // episodic.save_event — image_gen 사건 자동 리콜 (AI 미개입)
            if let Some(episodic) = &self.episodic {
                let prompt_preview: String = input.prompt.chars().take(60).collect();
                let prompt_full: String = input.prompt.chars().take(200).collect();
                let _ = episodic
                    .save_event(SaveEventInput {
                        event_type: "image_gen".to_string(),
                        title: format!("이미지 생성: {prompt_preview}"),
                        description: None,
                        who: Some("media:generate_image".to_string()),
                        context: Some(serde_json::json!({
                            "slug": result.slug,
                            "model": result.model_id,
                            "scope": scope.as_str(),
                            "promptPreview": prompt_full,
                            "costUsd": result.cost_usd,
                        })),
                        occurred_at: None,
                        entity_ids: vec![],
                        source_conv_id: None,
                        ttl_days: None,
                        dedup_threshold: None,
                    })
                    .await;
            }
        }

        Ok(result)
    }

    /// reference image resolve — slug / url / base64 → binary.
    /// 옛 TS `resolveReferenceImage` 1:1. 실패 시 `None` (caller 가 reference 무시).
    /// 일반 로직: 모든 입력 형태 동등 처리 (특정 도메인·확장자 hardcode X).
    async fn resolve_reference_image(
        &self,
        ref_input: Option<&ReferenceImageInput>,
    ) -> Option<ImageReferenceImage> {
        let r = ref_input?;

        // 1) base64 — data URI 또는 raw base64 (가장 빠름)
        if let Some(b64) = &r.base64 {
            // `data:image/png;base64,XXX` 매칭
            if let Some(rest) = b64.strip_prefix("data:") {
                if let Some(comma_idx) = rest.find(",") {
                    let header = &rest[..comma_idx];
                    let body = &rest[comma_idx + 1..];
                    if let Some(semi_idx) = header.find(";base64") {
                        let mime = header[..semi_idx].to_string();
                        if let Ok(binary) = base64::engine::general_purpose::STANDARD.decode(body) {
                            return Some(ImageReferenceImage {
                                binary,
                                content_type: mime,
                            });
                        }
                    }
                }
            }
            // raw base64 — content_type unknown → png 기본
            if let Ok(binary) = base64::engine::general_purpose::STANDARD.decode(b64) {
                return Some(ImageReferenceImage {
                    binary,
                    content_type: "image/png".to_string(),
                });
            }
        }

        // 2) slug — 갤러리에서 직접 read
        if let Some(slug) = &r.slug {
            if let Ok(Some((binary, content_type, _))) = self.media.read(slug).await {
                return Some(ImageReferenceImage {
                    binary,
                    content_type,
                });
            }
            return None;
        }

        // 3) url — 미디어 URL 또는 외부 URL (https://)
        if let Some(url) = &r.url {
            // 미디어 URL 인지 먼저 검사 (parse_media_url) — slug 추출 후 read
            if let Some((_, slug, _)) = parse_media_url(url) {
                if let Ok(Some((binary, content_type, _))) = self.media.read(&slug).await {
                    return Some(ImageReferenceImage {
                        binary,
                        content_type,
                    });
                }
                return None;
            }
            // 외부 URL fetch
            if url.starts_with("http://") || url.starts_with("https://") {
                let client = crate::utils::http_client::http_client();
                if let Ok(resp) = client.get(url).send().await {
                    if resp.status().is_success() {
                        let content_type = resp
                            .headers()
                            .get("content-type")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("image/png")
                            .to_string();
                        if let Ok(bytes) = resp.bytes().await {
                            return Some(ImageReferenceImage {
                                binary: bytes.to_vec(),
                                content_type,
                            });
                        }
                    }
                }
            }
        }

        None
    }
}

fn format_to_string(format: &ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Webp => "webp",
        ImageFormat::Avif => "avif",
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::embedder::StubEmbedderAdapter;
    use firebat_infra::adapters::image_gen::StubImageGenAdapter;
    use firebat_infra::adapters::image_processor::StubImageProcessorAdapter;
    use firebat_infra::adapters::media::LocalMediaAdapter;
    use firebat_infra::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    fn _silence_unused_imports() {
        // StubEmbedderAdapter / parse_format — 다른 시점 테스트에서 사용 (참고용 import 보존)
        let _ = StubEmbedderAdapter::new();
        let _ = parse_format("png");
    }

    fn make_manager() -> (Arc<MediaManager>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let media: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        let image_gen: Arc<dyn IImageGenPort> = Arc::new(StubImageGenAdapter::new());
        let processor: Arc<dyn IImageProcessorPort> = Arc::new(StubImageProcessorAdapter::new());
        let mgr = MediaManager::new(media)
            .with_vault(vault)
            .with_image_gen(image_gen)
            .with_processor(processor);
        (Arc::new(mgr), dir)
    }

    #[tokio::test]
    async fn save_and_is_ready_done() {
        let (mgr, _dir) = make_manager();
        let r = mgr
            .save(b"x", "image/png", MediaSaveOptions::default())
            .await
            .unwrap();
        assert!(mgr.is_ready(&r.slug).await);
    }

    #[tokio::test]
    async fn error_record_is_not_ready() {
        let (mgr, _dir) = make_manager();
        let slug = mgr
            .save_error_record(MediaSaveOptions::default(), "fail")
            .await
            .unwrap();
        assert!(!mgr.is_ready(&slug).await);
    }

    #[test]
    fn parse_size_hint_recognizes_formats() {
        assert_eq!(parse_size_hint(None), (1024, 1024));
        assert_eq!(parse_size_hint(Some("1024x1024")), (1024, 1024));
        assert_eq!(parse_size_hint(Some("1536x1024")), (1536, 1024));
        assert_eq!(parse_size_hint(Some("512")), (512, 512));
        // 무효 입력 → default
        assert_eq!(parse_size_hint(Some("invalid")), (1024, 1024));
        assert_eq!(parse_size_hint(Some("")), (1024, 1024));
    }

    #[test]
    fn parse_aspect_ratio_recognizes_common() {
        assert_eq!(parse_aspect_ratio("16:9"), Some((16, 9)));
        assert_eq!(parse_aspect_ratio("1:1"), Some((1, 1)));
        assert_eq!(parse_aspect_ratio(" 4:5 "), Some((4, 5)));
        assert_eq!(parse_aspect_ratio("invalid"), None);
        assert_eq!(parse_aspect_ratio("0:9"), None);
        assert_eq!(parse_aspect_ratio("16:0"), None);
    }

    #[test]
    fn compute_crop_dims_landscape_to_square() {
        // 1024x768 (4:3) → 1:1 → 768x768 (height 기준)
        let (w, h) = compute_crop_dims(1024, 768, 1, 1);
        assert_eq!((w, h), (768, 768));
        // 768x1024 (3:4) → 1:1 → 768x768 (width 기준)
        let (w2, h2) = compute_crop_dims(768, 1024, 1, 1);
        assert_eq!((w2, h2), (768, 768));
    }

    #[test]
    fn parse_media_url_extracts_slug() {
        // 절대 URL
        assert_eq!(
            parse_media_url("https://firebat.co.kr/user/media/abc.png"),
            Some((MediaScope::User, "abc".to_string(), "png".to_string()))
        );
        // 상대 URL
        assert_eq!(
            parse_media_url("/system/media/x.webp"),
            Some((MediaScope::System, "x".to_string(), "webp".to_string()))
        );
        // 외부 URL — None (parseMediaUrl 외부 미디어 X)
        assert_eq!(parse_media_url("https://example.com/image.png"), None);
    }

    #[test]
    fn ext_from_content_type_recognizes() {
        assert_eq!(ext_from_content_type("image/png"), "png");
        assert_eq!(ext_from_content_type("image/jpeg"), "jpg");
        assert_eq!(ext_from_content_type("image/webp"), "webp");
        assert_eq!(ext_from_content_type("image/avif"), "avif");
        assert_eq!(ext_from_content_type("application/octet-stream"), "png");
    }

    #[tokio::test]
    async fn is_media_ready_external_url_passes() {
        let (mgr, _dir) = make_manager();
        // 외부 URL — 통과 (우리 책임 X)
        assert!(mgr.is_media_ready("https://example.com/img.png").await);
    }

    #[tokio::test]
    async fn is_media_ready_blank_returns_false() {
        let (mgr, _dir) = make_manager();
        assert!(!mgr.is_media_ready("").await);
    }

    #[tokio::test]
    async fn vault_image_model_set_get_roundtrip() {
        let (mgr, _dir) = make_manager();
        // 미박음 시 image_gen.get_model_id() fallback
        assert_eq!(mgr.get_image_model(), "stub-image");
        mgr.set_image_model("gpt-image-1").unwrap();
        assert_eq!(mgr.get_image_model(), "gpt-image-1");
    }

    #[tokio::test]
    async fn vault_image_default_size_quality() {
        let (mgr, _dir) = make_manager();
        assert!(mgr.get_image_default_size().is_none());
        mgr.set_image_default_size(Some("1536x1024")).unwrap();
        assert_eq!(mgr.get_image_default_size(), Some("1536x1024".to_string()));
        // None 으로 삭제
        mgr.set_image_default_size(None).unwrap();
        assert!(mgr.get_image_default_size().is_none());

        mgr.set_image_default_quality(Some("high")).unwrap();
        assert_eq!(mgr.get_image_default_quality(), Some("high".to_string()));
    }

    #[tokio::test]
    async fn list_image_models_returns_stub_one() {
        let (mgr, _dir) = make_manager();
        let models = mgr.list_image_models();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "stub-image");
    }

    #[tokio::test]
    async fn get_image_settings_returns_default_if_not_set() {
        let (mgr, _dir) = make_manager();
        let s = mgr.get_image_settings();
        assert_eq!(s, SeoImageSettings::default());
    }

    #[tokio::test]
    async fn generate_image_with_stub_image_gen() {
        // Stub image_gen 은 1x1 grey PNG 반환. Stub processor 는 no-op (variants 미생성).
        let (mgr, _dir) = make_manager();
        let result = mgr
            .generate_image(
                GenerateImageInput {
                    prompt: "고양이".to_string(),
                    ..Default::default()
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.model_id, "stub-image");
        assert!(!result.slug.is_empty());
        assert_eq!(result.revised_prompt.as_deref(), Some("고양이"));
    }

    #[tokio::test]
    async fn generate_image_empty_prompt_errors() {
        let (mgr, _dir) = make_manager();
        let r = mgr
            .generate_image(GenerateImageInput::default(), None)
            .await;
        // Stub image_gen 의 빈 prompt error 가 propagate
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn regenerate_image_by_slug_extracts_meta() {
        let (mgr, _dir) = make_manager();
        // 1) save 후 prompt 박힘
        let opts = MediaSaveOptions {
            prompt: Some("원본 prompt".to_string()),
            model: Some("stub-image".to_string()),
            ..Default::default()
        };
        let saved = mgr.save(b"x", "image/png", opts).await.unwrap();
        // 2) regenerate
        let (result, regen_from) = mgr.regenerate_image_by_slug(&saved.slug).await.unwrap();
        assert_eq!(regen_from, saved.slug);
        assert!(result.revised_prompt.as_deref() == Some("원본 prompt"));
    }

    #[tokio::test]
    async fn regenerate_without_prompt_errors() {
        let (mgr, _dir) = make_manager();
        let saved = mgr
            .save(b"x", "image/png", MediaSaveOptions::default())
            .await
            .unwrap();
        // prompt 미박힘 → error
        let r = mgr.regenerate_image_by_slug(&saved.slug).await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("프롬프트"));
    }

    #[tokio::test]
    async fn resolve_reference_image_base64() {
        let (mgr, _dir) = make_manager();
        // PNG signature base64
        let b64 = base64::engine::general_purpose::STANDARD
            .encode(&[0x89, 0x50, 0x4E, 0x47]);
        let resolved = mgr
            .resolve_reference_image(Some(&ReferenceImageInput {
                base64: Some(b64),
                ..Default::default()
            }))
            .await;
        let Some(img) = resolved else {
            panic!("expected Some");
        };
        assert_eq!(img.binary, vec![0x89, 0x50, 0x4E, 0x47]);
        assert_eq!(img.content_type, "image/png"); // raw base64 default
    }

    #[tokio::test]
    async fn resolve_reference_image_data_uri() {
        let (mgr, _dir) = make_manager();
        let body = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let data_uri = format!("data:image/webp;base64,{}", body);
        let resolved = mgr
            .resolve_reference_image(Some(&ReferenceImageInput {
                base64: Some(data_uri),
                ..Default::default()
            }))
            .await;
        let img = resolved.unwrap();
        assert_eq!(img.content_type, "image/webp");
        assert_eq!(img.binary, b"hello");
    }

    #[tokio::test]
    async fn resolve_reference_image_slug_from_gallery() {
        let (mgr, _dir) = make_manager();
        let saved = mgr
            .save(b"original-bytes", "image/png", MediaSaveOptions::default())
            .await
            .unwrap();
        let resolved = mgr
            .resolve_reference_image(Some(&ReferenceImageInput {
                slug: Some(saved.slug),
                ..Default::default()
            }))
            .await;
        let img = resolved.unwrap();
        assert_eq!(img.binary, b"original-bytes");
        assert_eq!(img.content_type, "image/png");
    }

    #[tokio::test]
    async fn resolve_reference_image_unknown_slug_returns_none() {
        let (mgr, _dir) = make_manager();
        let resolved = mgr
            .resolve_reference_image(Some(&ReferenceImageInput {
                slug: Some("nonexistent-xyz".to_string()),
                ..Default::default()
            }))
            .await;
        assert!(resolved.is_none());
    }
}

// SeoImageSettings PartialEq for tests
impl PartialEq for SeoImageSettings {
    fn eq(&self, other: &Self) -> bool {
        self.webp == other.webp
            && self.avif == other.avif
            && self.thumbnail == other.thumbnail
            && self.variants == other.variants
            && self.blurhash == other.blurhash
            && self.strip_exif == other.strip_exif
            && self.progressive == other.progressive
            && self.default_quality == other.default_quality
            && self.keep_original == other.keep_original
    }
}

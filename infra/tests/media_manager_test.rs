//! MediaManager integration test — 옛 core inline tests 이관.
//!
//! private fn 사용 test (parse_size_hint / parse_aspect_ratio / compute_crop_dims /
//! parse_media_url / ext_from_content_type) 는 inline 유지.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::media::{GenerateImageInput, MediaManager, SeoImageSettings};
use firebat_core::ports::{
    IImageGenPort, IImageProcessorPort, IMediaPort, IVaultPort, MediaSaveOptions,
};
use firebat_infra::adapters::image_gen::StubImageGenAdapter;
use firebat_infra::adapters::image_processor::StubImageProcessorAdapter;
use firebat_infra::adapters::media::LocalMediaAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_manager() -> (Arc<MediaManager>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
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
    // 미설정 시 image_gen.get_model_id() fallback
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
    // 1) save 후 prompt 설정
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
    // prompt 미설정 → error
    let r = mgr.regenerate_image_by_slug(&saved.slug).await;
    assert!(r.is_err());
    assert!(r.unwrap_err().contains("프롬프트"));
}

// `resolve_reference_image_*` 4개 테스트는 `resolve_reference_image` 가 private async fn 이라
// inline 유지 — `core/src/managers/media.rs` mod tests 참조.

//! MediaManager — 이미지 생성 / 미디어 CRUD / 갤러리 facade.
//!
//! 옛 TS `core/managers/media-manager.ts` Rust 재구현 (Phase B-15 minimum).
//!
//! Phase B-15 minimum:
//! - save / read / stat / list / remove / update_meta — IMediaPort 위 thin facade
//! - save_error_record — 실패 기록 영속 (재생성 / 삭제 결정 위해 prompt·model 보존)
//!
//! Phase B-16+ 후속:
//! - generate / regenerate — IImageGenPort + ILlmPort + IImageProcessorPort 박힌 후 활성
//!   (image_gen async + variants + blurhash + attention crop)
//! - 모델 설정 (default size / quality / model id) — Vault 저장 + 어드민 설정 UI

use std::sync::Arc;

use crate::ports::{
    IMediaPort, InfraResult, MediaFileRecord, MediaListOpts, MediaListResult, MediaSaveOptions,
    MediaSaveResult,
};

pub struct MediaManager {
    media: Arc<dyn IMediaPort>,
}

impl MediaManager {
    pub fn new(media: Arc<dyn IMediaPort>) -> Self {
        Self { media }
    }

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

    /// og:image 가드 — 미디어 URL 인 경우 status='done' && bytes>0 일 때만 ready.
    /// 외부 캐싱 데미지 차단 (Facebook / Twitter / 카톡 7일 캐싱).
    pub async fn is_ready(&self, slug: &str) -> bool {
        match self.media.stat(slug).await {
            Ok(Some(record)) => {
                let done = record.status.as_deref().unwrap_or("done") == "done";
                done && record.bytes > 0
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::media::LocalMediaAdapter;
    use tempfile::tempdir;

    fn manager() -> (MediaManager, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let port: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));
        (MediaManager::new(port), dir)
    }

    #[tokio::test]
    async fn save_and_is_ready_done() {
        let (mgr, _dir) = manager();
        let r = mgr
            .save(b"x", "image/png", MediaSaveOptions::default())
            .await
            .unwrap();
        assert!(mgr.is_ready(&r.slug).await);
    }

    #[tokio::test]
    async fn error_record_is_not_ready() {
        let (mgr, _dir) = manager();
        let slug = mgr
            .save_error_record(MediaSaveOptions::default(), "fail")
            .await
            .unwrap();
        assert!(!mgr.is_ready(&slug).await);
    }
}

//! FileEmbedderCacheAdapter — IEmbedderCachePort 의 file I/O 구현 (2026-05-13 Hexagonal 정공).
//!
//! 옛 core 의 component_search_index / tool_search_index 가 std::fs / std::env 직접 호출하던 패턴 폐기.
//! 디렉토리 = FIREBAT_DATA_DIR env override 또는 "data/" (workspace root 기준).

use firebat_core::ports::IEmbedderCachePort;
use std::path::PathBuf;

pub struct FileEmbedderCacheAdapter {
    /// 캐시 디렉토리 — startup 에서 resolve. 매 호출 read 부담 0.
    dir: PathBuf,
}

impl FileEmbedderCacheAdapter {
    /// startup 시 env 보고 결정. FIREBAT_DATA_DIR 미설정 시 "data".
    pub fn discover() -> Self {
        let dir = std::env::var("FIREBAT_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data"));
        tracing::info!(dir = %dir.display(), "FileEmbedderCacheAdapter dir resolved");
        Self { dir }
    }

    /// 명시 path 받는 ctor — 테스트 + deployment 명시용.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
}

impl IEmbedderCachePort for FileEmbedderCacheAdapter {
    fn load(&self, cache_name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(cache_name)).ok()
    }

    fn save(&self, cache_name: &str, json: &str) {
        let path = self.dir.join(cache_name);
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::warn!(dir = %parent.display(), error = %e, "embedder cache mkdir failed");
                return;
            }
        }
        if let Err(e) = std::fs::write(&path, json) {
            tracing::warn!(path = %path.display(), error = %e, "embedder cache write failed");
        }
    }
}

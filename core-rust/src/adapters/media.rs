//! LocalMediaAdapter — IMediaPort 의 로컬 파일 + JSON 메타 구현체.
//!
//! 옛 TS infra/media/local-adapter.ts Rust 재구현 (Phase B-15 minimum).
//!
//! 디렉토리 구조:
//!   <root>/user/media/<slug>.<ext>      — 원본 binary
//!   <root>/user/media/<slug>.meta.json  — MediaFileRecord JSON
//!   <root>/system/media/...
//!
//! Slug 네이밍: YYYY-MM-DD-<hint-slug>-<rand4>. 한국어 hint 허용 (UTF-8).
//!
//! Phase B-15+ 후속:
//! - saveVariant / updateMeta 의 variants 처리 — IImageProcessorPort 박힌 후
//! - finalizeBase (placeholder swap) — 비동기 image_gen 패턴

use chrono::Utc;
use rand::Rng;
use std::path::{Path, PathBuf};

use crate::ports::{
    IMediaPort, InfraResult, MediaFileRecord, MediaListOpts, MediaListResult, MediaSaveOptions,
    MediaSaveResult, MediaScope, MediaVariantMeta,
};

pub struct LocalMediaAdapter {
    root: PathBuf,
}

impl LocalMediaAdapter {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }

    fn scope_dir(&self, scope: MediaScope) -> PathBuf {
        self.root.join(scope.as_str()).join("media")
    }

    fn ext_from_content_type(content_type: &str) -> &'static str {
        match content_type.to_lowercase().as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/avif" => "avif",
            "image/gif" => "gif",
            "image/svg+xml" => "svg",
            _ => "bin",
        }
    }

    fn make_slug(filename_hint: Option<&str>) -> String {
        let date = Utc::now().format("%Y-%m-%d").to_string();
        let mut rng = rand::thread_rng();
        let rand4: u32 = rng.gen_range(0..0xFFFF);
        let hint = filename_hint
            .map(|h| {
                let normalized: String = h
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                if normalized.is_empty() {
                    String::new()
                } else {
                    let truncated: String = normalized.chars().take(40).collect();
                    truncated.to_lowercase()
                }
            })
            .unwrap_or_default();
        if hint.is_empty() {
            format!("{date}-{rand4:04x}")
        } else {
            format!("{date}-{hint}-{rand4:04x}")
        }
    }

    fn meta_path(&self, scope: MediaScope, slug: &str) -> PathBuf {
        self.scope_dir(scope).join(format!("{slug}.meta.json"))
    }

    fn binary_path(&self, scope: MediaScope, slug: &str, ext: &str) -> PathBuf {
        self.scope_dir(scope).join(format!("{slug}.{ext}"))
    }

    async fn write_meta(
        &self,
        scope: MediaScope,
        slug: &str,
        record: &MediaFileRecord,
    ) -> InfraResult<()> {
        let path = self.meta_path(scope, slug);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("media meta dir 생성 실패: {e}"))?;
        }
        let raw = serde_json::to_string_pretty(record)
            .map_err(|e| format!("meta 직렬화 실패: {e}"))?;
        tokio::fs::write(&path, raw)
            .await
            .map_err(|e| format!("meta write 실패: {e}"))?;
        Ok(())
    }

    async fn find_record(&self, slug: &str) -> Option<(MediaScope, MediaFileRecord)> {
        for scope in [MediaScope::User, MediaScope::System] {
            let path = self.meta_path(scope, slug);
            if let Ok(raw) = tokio::fs::read_to_string(&path).await {
                if let Ok(record) = serde_json::from_str::<MediaFileRecord>(&raw) {
                    return Some((scope, record));
                }
            }
        }
        None
    }

    fn url_for(scope: MediaScope, slug: &str, ext: &str) -> String {
        format!("/{}/media/{}.{}", scope.as_str(), slug, ext)
    }
}

#[async_trait::async_trait]
impl IMediaPort for LocalMediaAdapter {
    async fn save(
        &self,
        binary: &[u8],
        content_type: &str,
        opts: &MediaSaveOptions,
    ) -> InfraResult<MediaSaveResult> {
        let scope = opts.scope.unwrap_or(MediaScope::User);
        let ext = opts
            .ext
            .clone()
            .unwrap_or_else(|| Self::ext_from_content_type(content_type).to_string());
        let slug = Self::make_slug(opts.filename_hint.as_deref());

        let bin_path = self.binary_path(scope, &slug, &ext);
        if let Some(parent) = bin_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("media dir 생성 실패: {e}"))?;
        }
        tokio::fs::write(&bin_path, binary)
            .await
            .map_err(|e| format!("media binary write 실패: {e}"))?;

        let record = MediaFileRecord {
            slug: slug.clone(),
            ext: ext.clone(),
            content_type: content_type.to_string(),
            bytes: binary.len() as i64,
            width: None,
            height: None,
            created_at: Utc::now().timestamp_millis(),
            scope: Some(scope),
            filename_hint: opts.filename_hint.clone(),
            prompt: opts.prompt.clone(),
            revised_prompt: opts.revised_prompt.clone(),
            model: opts.model.clone(),
            size: opts.size.clone(),
            quality: opts.quality.clone(),
            aspect_ratio: opts.aspect_ratio.clone(),
            variants: Vec::new(),
            thumbnail_url: None,
            blurhash: None,
            status: Some("done".to_string()),
            error_msg: None,
            source: opts.source.clone().or_else(|| Some("ai-generated".to_string())),
        };
        self.write_meta(scope, &slug, &record).await?;

        Ok(MediaSaveResult {
            slug: slug.clone(),
            url: Self::url_for(scope, &slug, &ext),
            thumbnail_url: None,
            variants: Vec::new(),
            blurhash: None,
            width: None,
            height: None,
            bytes: binary.len() as i64,
        })
    }

    async fn save_error_record(
        &self,
        opts: &MediaSaveOptions,
        error_msg: &str,
    ) -> InfraResult<String> {
        let scope = opts.scope.unwrap_or(MediaScope::User);
        let slug = Self::make_slug(opts.filename_hint.as_deref());
        let record = MediaFileRecord {
            slug: slug.clone(),
            ext: "png".to_string(),
            content_type: "image/png".to_string(),
            bytes: 0,
            width: None,
            height: None,
            created_at: Utc::now().timestamp_millis(),
            scope: Some(scope),
            filename_hint: opts.filename_hint.clone(),
            prompt: opts.prompt.clone(),
            revised_prompt: opts.revised_prompt.clone(),
            model: opts.model.clone(),
            size: opts.size.clone(),
            quality: opts.quality.clone(),
            aspect_ratio: opts.aspect_ratio.clone(),
            variants: Vec::new(),
            thumbnail_url: None,
            blurhash: None,
            status: Some("error".to_string()),
            error_msg: Some(error_msg.to_string()),
            source: opts.source.clone().or_else(|| Some("ai-generated".to_string())),
        };
        self.write_meta(scope, &slug, &record).await?;
        Ok(slug)
    }

    async fn read(
        &self,
        slug: &str,
    ) -> InfraResult<Option<(Vec<u8>, String, MediaFileRecord)>> {
        let Some((scope, record)) = self.find_record(slug).await else {
            return Ok(None);
        };
        let bin_path = self.binary_path(scope, slug, &record.ext);
        let binary = match tokio::fs::read(&bin_path).await {
            Ok(b) => b,
            Err(_) if record.status.as_deref() == Some("error") => Vec::new(),
            Err(e) => return Err(format!("media binary read 실패: {e}")),
        };
        let content_type = record.content_type.clone();
        Ok(Some((binary, content_type, record)))
    }

    async fn stat(&self, slug: &str) -> InfraResult<Option<MediaFileRecord>> {
        Ok(self.find_record(slug).await.map(|(_, r)| r))
    }

    async fn remove(&self, slug: &str) -> InfraResult<()> {
        let Some((scope, record)) = self.find_record(slug).await else {
            return Err(format!("media slug={} 미존재", slug));
        };
        let bin_path = self.binary_path(scope, slug, &record.ext);
        let _ = tokio::fs::remove_file(&bin_path).await;
        let meta_path = self.meta_path(scope, slug);
        tokio::fs::remove_file(&meta_path)
            .await
            .map_err(|e| format!("media meta 삭제 실패: {e}"))?;
        // variants 파일도 정리 — Phase B-15+ variant suffix 박힌 후 강화
        Ok(())
    }

    async fn list(&self, opts: &MediaListOpts) -> InfraResult<MediaListResult> {
        let scopes: Vec<MediaScope> = match opts.scope {
            Some(s) => vec![s],
            None => vec![MediaScope::User, MediaScope::System],
        };
        let mut all: Vec<MediaFileRecord> = Vec::new();
        for scope in scopes {
            let dir = self.scope_dir(scope);
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.ends_with(".meta.json") {
                    continue;
                }
                let path = entry.path();
                if let Ok(raw) = tokio::fs::read_to_string(&path).await {
                    if let Ok(record) = serde_json::from_str::<MediaFileRecord>(&raw) {
                        all.push(record);
                    }
                }
            }
        }
        // 검색 필터
        if let Some(q) = opts.search.as_deref() {
            if !q.trim().is_empty() {
                let qlow = q.to_lowercase();
                all.retain(|r| {
                    let matches_field = |field: &Option<String>| {
                        field
                            .as_deref()
                            .map(|s| s.to_lowercase().contains(&qlow))
                            .unwrap_or(false)
                    };
                    r.slug.to_lowercase().contains(&qlow)
                        || matches_field(&r.filename_hint)
                        || matches_field(&r.prompt)
                        || matches_field(&r.model)
                });
            }
        }
        // 최신순 정렬
        all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let total = all.len();
        let offset = opts.offset.unwrap_or(0);
        let limit = opts.limit.unwrap_or(50).min(500);
        let items: Vec<MediaFileRecord> = all.into_iter().skip(offset).take(limit).collect();
        Ok(MediaListResult { items, total })
    }

    async fn update_meta(&self, slug: &str, patch: &serde_json::Value) -> InfraResult<()> {
        let Some((scope, record)) = self.find_record(slug).await else {
            return Err(format!("media slug={} 미존재", slug));
        };
        // record JSON 으로 변환 → patch 머지 → 다시 record (typed serde 보존)
        let mut record_value = serde_json::to_value(&record)
            .map_err(|e| format!("record 직렬화: {e}"))?;
        if let (serde_json::Value::Object(rmap), serde_json::Value::Object(pmap)) =
            (&mut record_value, patch)
        {
            for (k, v) in pmap {
                rmap.insert(k.clone(), v.clone());
            }
        }
        let updated: MediaFileRecord = serde_json::from_value(record_value)
            .map_err(|e| format!("patched record 역직렬화: {e}"))?;
        self.write_meta(scope, slug, &updated).await?;
        Ok(())
    }

    async fn finalize_base(
        &self,
        slug: &str,
        scope: &str,
        binary: &[u8],
        content_type: &str,
        ext_override: Option<&str>,
    ) -> InfraResult<()> {
        let scope_enum = MediaScope::from_str_or_user(scope);
        let new_ext = ext_override
            .map(String::from)
            .unwrap_or_else(|| Self::ext_from_content_type(content_type).to_string());

        // 기존 record 로드 — meta 박혀있어야 finalize 가능 (placeholder 가 박은 상태)
        let Some((found_scope, mut record)) = self.find_record(slug).await else {
            return Err(format!("finalize_base: media slug={} 미존재", slug));
        };
        if found_scope != scope_enum {
            return Err(format!(
                "finalize_base: scope mismatch (요청 {} / 실제 {})",
                scope_enum.as_str(),
                found_scope.as_str()
            ));
        }

        // 옛 ext 가 다르면 옛 파일 삭제 (PNG → WebP 변환 등)
        if record.ext != new_ext {
            let old_path = self.binary_path(scope_enum, slug, &record.ext);
            let _ = tokio::fs::remove_file(&old_path).await;
        }

        // 새 binary 박음
        let new_path = self.binary_path(scope_enum, slug, &new_ext);
        if let Some(parent) = new_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("finalize_base dir 생성: {e}"))?;
        }
        tokio::fs::write(&new_path, binary)
            .await
            .map_err(|e| format!("finalize_base binary write: {e}"))?;

        // 메타 갱신 — ext / contentType / bytes (status / width / height 는 caller 의 update_meta 로)
        record.ext = new_ext;
        record.content_type = content_type.to_string();
        record.bytes = binary.len() as i64;
        self.write_meta(scope_enum, slug, &record).await?;
        Ok(())
    }

    async fn save_variant(
        &self,
        slug: &str,
        scope: &str,
        suffix: &str,
        format: &str,
        binary: &[u8],
        _variant_meta: &MediaVariantMeta,
    ) -> InfraResult<String> {
        let scope_enum = MediaScope::from_str_or_user(scope);
        // 파일명 패턴: `<slug>-<suffix>.<format>` — 옛 TS 1:1.
        // suffix 예: `'480w'` / `'thumb'` / `'full'` (도메인 결정).
        let filename = format!("{}-{}.{}", slug, suffix, format);
        let path = self.scope_dir(scope_enum).join(&filename);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("variant dir 생성: {e}"))?;
        }
        tokio::fs::write(&path, binary)
            .await
            .map_err(|e| format!("variant binary write: {e}"))?;
        // URL 반환 — `/{scope}/media/<slug>-<suffix>.<format>` (옛 TS 1:1)
        Ok(format!("/{}/media/{}", scope_enum.as_str(), filename))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn adapter() -> (LocalMediaAdapter, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let a = LocalMediaAdapter::new(dir.path());
        (a, dir)
    }

    #[tokio::test]
    async fn save_then_read_roundtrip() {
        let (a, _dir) = adapter();
        let result = a
            .save(
                b"hello bytes",
                "image/png",
                &MediaSaveOptions {
                    filename_hint: Some("test".to_string()),
                    prompt: Some("a cat".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(result.url.starts_with("/user/media/"));
        assert_eq!(result.bytes, 11);

        let read = a.read(&result.slug).await.unwrap().unwrap();
        assert_eq!(read.0, b"hello bytes");
        assert_eq!(read.1, "image/png");
        assert_eq!(read.2.prompt.as_deref(), Some("a cat"));
    }

    #[tokio::test]
    async fn save_error_record_no_binary() {
        let (a, _dir) = adapter();
        let slug = a
            .save_error_record(
                &MediaSaveOptions {
                    prompt: Some("failed prompt".to_string()),
                    ..Default::default()
                },
                "OpenAI API timeout",
            )
            .await
            .unwrap();
        let stat = a.stat(&slug).await.unwrap().unwrap();
        assert_eq!(stat.status.as_deref(), Some("error"));
        assert_eq!(stat.error_msg.as_deref(), Some("OpenAI API timeout"));
        assert_eq!(stat.bytes, 0);
    }

    #[tokio::test]
    async fn list_with_search() {
        let (a, _dir) = adapter();
        a.save(
            b"a",
            "image/png",
            &MediaSaveOptions {
                prompt: Some("cat photo".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        a.save(
            b"b",
            "image/png",
            &MediaSaveOptions {
                prompt: Some("dog photo".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let result = a
            .list(&MediaListOpts {
                search: Some("cat".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].prompt.as_deref(), Some("cat photo"));
    }

    #[tokio::test]
    async fn remove_drops_binary_and_meta() {
        let (a, _dir) = adapter();
        let r = a
            .save(b"x", "image/png", &MediaSaveOptions::default())
            .await
            .unwrap();
        assert!(a.stat(&r.slug).await.unwrap().is_some());
        a.remove(&r.slug).await.unwrap();
        assert!(a.stat(&r.slug).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn update_meta_merges_fields() {
        let (a, _dir) = adapter();
        let r = a
            .save(b"x", "image/png", &MediaSaveOptions::default())
            .await
            .unwrap();
        a.update_meta(
            &r.slug,
            &serde_json::json!({"width": 1024, "height": 768, "blurhash": "abc"}),
        )
        .await
        .unwrap();
        let stat = a.stat(&r.slug).await.unwrap().unwrap();
        assert_eq!(stat.width, Some(1024));
        assert_eq!(stat.height, Some(768));
        assert_eq!(stat.blurhash.as_deref(), Some("abc"));
    }

    #[tokio::test]
    async fn list_empty_returns_zero() {
        let (a, _dir) = adapter();
        let result = a.list(&MediaListOpts::default()).await.unwrap();
        assert_eq!(result.items.len(), 0);
        assert_eq!(result.total, 0);
    }
}

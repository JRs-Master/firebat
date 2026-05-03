//! PageManager — 페이지 CRUD + 정적 스캔 + 미디어 사용처 인덱스 + rename + redirect.
//!
//! 옛 TS PageManager (`core/managers/page-manager.ts`) Rust 재구현.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use crate::ports::{IDatabasePort, IStoragePort, InfraResult, MediaUsageEntry, PageListItem, PageRecord};

#[derive(Debug, Serialize, Deserialize)]
pub struct RenameResult {
    #[serde(rename = "oldSlug")]
    pub old_slug: String,
    #[serde(rename = "newSlug")]
    pub new_slug: String,
}

/// `/user/media/<slug>...` / `/system/media/<slug>...` URL → slug 추출.
/// 옛 TS lib/media-url.ts 와 동등 패턴.
static MEDIA_URL_RE: OnceLock<Regex> = OnceLock::new();
fn media_url_re() -> &'static Regex {
    MEDIA_URL_RE.get_or_init(|| {
        Regex::new(r"/(user|system)/media/([A-Za-z0-9가-힣\-_]+)(?:-(?:thumb|full|\d+w))?\.([a-zA-Z0-9]+)").unwrap()
    })
}

pub struct PageManager {
    db: Arc<dyn IDatabasePort>,
    storage: Arc<dyn IStoragePort>,
}

impl PageManager {
    pub fn new(db: Arc<dyn IDatabasePort>, storage: Arc<dyn IStoragePort>) -> Self {
        Self { db, storage }
    }

    pub fn list(&self) -> Vec<PageListItem> {
        self.db.list_pages()
    }

    pub fn search(&self, query: &str, limit: Option<usize>) -> Vec<PageListItem> {
        self.db.search_pages(query, limit.unwrap_or(50))
    }

    pub fn get(&self, slug: &str) -> Option<PageRecord> {
        self.db.get_page(slug)
    }

    /// 저장 — DB save + media_usage 인덱스 동기. spec 파싱 실패해도 저장 진행.
    pub fn save(
        &self,
        slug: &str,
        spec: &str,
        status: &str,
        project: Option<&str>,
        visibility: Option<&str>,
        password: Option<&str>,
    ) -> InfraResult<()> {
        if !self.db.save_page(slug, spec, status, project, visibility, password) {
            return Err(format!("페이지 저장 실패: {}", slug));
        }
        let slugs = Self::extract_media_slugs(spec);
        let slugs_vec: Vec<String> = slugs.into_iter().collect();
        self.db.replace_media_usage(slug, &slugs_vec);
        Ok(())
    }

    /// 삭제 — DB delete + media_usage 정리.
    pub fn delete(&self, slug: &str) -> InfraResult<()> {
        if !self.db.delete_page(slug) {
            return Err(format!("페이지 삭제 실패: {}", slug));
        }
        self.db.delete_media_usage_for_page(slug);
        Ok(())
    }

    pub fn set_visibility(
        &self,
        slug: &str,
        visibility: &str,
        password: Option<&str>,
    ) -> InfraResult<()> {
        if self.db.set_page_visibility(slug, visibility, password) {
            Ok(())
        } else {
            Err(format!("visibility 설정 실패: {}", slug))
        }
    }

    pub fn verify_password(&self, slug: &str, password: &str) -> bool {
        self.db.verify_page_password(slug, password)
    }

    /// slug rename — 새 slug 로 spec 복사 + 옛 slug 삭제 + 옵션 redirect.
    pub fn rename(
        &self,
        old_slug: &str,
        new_slug_input: &str,
        set_redirect: bool,
    ) -> InfraResult<RenameResult> {
        let new_slug = new_slug_input
            .trim()
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_string();
        let new_slug = Self::collapse_slashes(&new_slug);
        if new_slug.is_empty() {
            return Err("새 slug 가 비어 있습니다.".into());
        }
        if old_slug == new_slug {
            return Err("기존과 동일한 slug 입니다.".into());
        }
        if new_slug.contains(char::is_whitespace) {
            return Err("slug 에 공백을 넣을 수 없습니다.".into());
        }
        if self.db.get_page(&new_slug).is_some() {
            return Err(format!("이미 존재하는 slug: {}", new_slug));
        }
        let cur = self
            .db
            .get_page(old_slug)
            .ok_or_else(|| format!("원본 페이지 없음: {}", old_slug))?;

        // spec JSON 안의 slug / project 자동 동기
        let mut spec_value: serde_json::Value =
            serde_json::from_str(&cur.spec).unwrap_or(serde_json::json!({}));
        spec_value["slug"] = serde_json::Value::String(new_slug.clone());
        // 새 slug 의 첫 segment → project 자동 동기
        let first_segment = new_slug.split('/').next().unwrap_or("").to_string();
        let new_project = if first_segment.is_empty() {
            cur.project.clone()
        } else {
            spec_value["project"] = serde_json::Value::String(first_segment.clone());
            Some(first_segment)
        };
        let spec_str = serde_json::to_string(&spec_value)
            .map_err(|e| format!("spec 직렬화 실패: {e}"))?;

        // 새 slug 저장 → 옛 slug 삭제 (실패 시 옛 보존)
        self.save(
            &new_slug,
            &spec_str,
            &cur.status,
            new_project.as_deref(),
            cur.visibility.as_deref(),
            cur.password.as_deref(),
        )?;
        self.delete(old_slug)?;

        if set_redirect {
            self.db.upsert_page_redirect(old_slug, &new_slug);
        }

        Ok(RenameResult {
            old_slug: old_slug.to_string(),
            new_slug,
        })
    }

    /// 프로젝트 일괄 rename — old_name / 의 모든 slug → new_name / 으로 prefix 교체.
    pub fn rename_project(
        &self,
        old_name: &str,
        new_name: &str,
        set_redirect: bool,
    ) -> InfraResult<Vec<RenameResult>> {
        let new_name_trimmed = new_name.trim();
        if new_name_trimmed.is_empty() {
            return Err("새 프로젝트 이름이 비어 있습니다.".into());
        }
        if old_name == new_name {
            return Err("기존과 동일한 이름입니다.".into());
        }
        if new_name.chars().any(|c| c == '/' || c.is_whitespace()) {
            return Err("프로젝트명에는 슬래시·공백 금지.".into());
        }
        let slugs = self.db.list_pages_by_project(old_name);
        let mut renamed = Vec::new();
        for slug in slugs {
            let new_slug = if let Some(rest) = slug.strip_prefix(&format!("{}/", old_name)) {
                format!("{}/{}", new_name, rest)
            } else {
                format!("{}/{}", new_name, slug)
            };
            if let Ok(r) = self.rename(&slug, &new_slug, set_redirect) {
                renamed.push(r);
            }
        }
        Ok(renamed)
    }

    pub fn get_redirect(&self, from_slug: &str) -> Option<String> {
        self.db.get_page_redirect(from_slug)
    }

    /// app/(user)/ 하위 정적 페이지 slug 목록 (manifest.json 있는 디렉토리).
    pub async fn list_static(&self) -> Vec<String> {
        let Ok(entries) = self.storage.list_dir("app/(user)").await else {
            return vec![];
        };
        let mut result = Vec::new();
        for entry in entries {
            if !entry.is_directory {
                continue;
            }
            if entry.name.starts_with('[') {
                continue;
            }
            let manifest_path = format!("app/(user)/{}/manifest.json", entry.name);
            if self.storage.exists(&manifest_path).await {
                result.push(entry.name);
            }
        }
        result.sort();
        result
    }

    pub fn find_media_usage(&self, media_slug: &str) -> Vec<MediaUsageEntry> {
        self.db.find_media_usage(media_slug)
    }

    // ─── private helpers ───

    /// PageSpec 안 모든 미디어 URL → slug 추출. 옛 TS extractMediaSlugsFromSpec 와 동일 패턴.
    /// 일반 로직: regex 가 모든 string value 에서 / 직접 spec 문자열에서 매칭.
    fn extract_media_slugs(spec: &str) -> HashSet<String> {
        let mut found = HashSet::new();
        let re = media_url_re();
        for caps in re.captures_iter(spec) {
            if let Some(slug) = caps.get(2) {
                found.insert(slug.as_str().to_string());
            }
        }
        found
    }

    fn collapse_slashes(s: &str) -> String {
        let mut result = String::new();
        let mut prev_slash = false;
        for c in s.chars() {
            if c == '/' {
                if !prev_slash {
                    result.push(c);
                }
                prev_slash = true;
            } else {
                result.push(c);
                prev_slash = false;
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{database::SqliteDatabaseAdapter, storage::LocalStorageAdapter};
    use tempfile::tempdir;

    fn make_manager() -> (PageManager, Arc<dyn IDatabasePort>) {
        let tmp = tempdir().unwrap();
        let db: Arc<dyn IDatabasePort> = Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(tmp.path()));
        (PageManager::new(db.clone(), storage), db)
    }

    fn sample_spec(title: &str) -> String {
        serde_json::json!({
            "head": {"title": title},
            "body": [{"type": "Text", "props": {"content": "hello"}}]
        })
        .to_string()
    }

    #[test]
    fn save_get_list_delete() {
        let (mgr, _) = make_manager();
        mgr.save("p1", &sample_spec("v1"), "published", Some("blog"), None, None).unwrap();
        let got = mgr.get("p1").unwrap();
        assert_eq!(got.project.as_deref(), Some("blog"));
        assert_eq!(mgr.list().len(), 1);

        mgr.delete("p1").unwrap();
        assert!(mgr.get("p1").is_none());
    }

    #[test]
    fn extract_media_slugs_from_spec() {
        let spec = r#"{
            "head": {"og": {"image": "/user/media/hero-2026-05.png"}},
            "body": [
                {"type": "Image", "props": {"src": "/user/media/chart-foo.webp"}},
                {"type": "Image", "props": {"src": "/system/media/icon-bar-thumb.webp"}},
                {"type": "Html", "props": {"content": "<img src=\"/user/media/extra-baz-480w.jpg\" />"}}
            ]
        }"#;
        let slugs = PageManager::extract_media_slugs(spec);
        assert!(slugs.contains("hero-2026-05"));
        assert!(slugs.contains("chart-foo"));
        // 옛 TS regex 한계 — `-thumb` / `-480w` variant suffix 가 character class 의 hyphen 에
        // 흡수됨. 즉 'icon-bar-thumb' / 'extra-baz-480w' 가 그대로 추출됨.
        // 옛 동작과 spec 일치 — dual-run 검증 가능. 정확한 slug 추출은 후속 정정 영역.
        assert!(slugs.contains("icon-bar-thumb"));
        assert!(slugs.contains("extra-baz-480w"));
    }

    #[test]
    fn save_indexes_media_usage() {
        let (mgr, db) = make_manager();
        let spec = r#"{"head":{},"body":[{"type":"Image","props":{"src":"/user/media/foo.png"}}]}"#;
        mgr.save("page-a", spec, "published", None, None, None).unwrap();

        let usage = db.find_media_usage("foo");
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].page_slug, "page-a");

        // 다른 페이지에서도 같은 미디어 사용 — 두 entry
        mgr.save("page-b", spec, "published", None, None, None).unwrap();
        let usage = db.find_media_usage("foo");
        assert_eq!(usage.len(), 2);

        // page-a 의 spec 변경 (foo 안 씀) — usage 동기 갱신
        mgr.save("page-a", r#"{"body":[]}"#, "published", None, None, None).unwrap();
        let usage = db.find_media_usage("foo");
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].page_slug, "page-b");
    }

    #[test]
    fn rename_with_redirect() {
        let (mgr, _) = make_manager();
        mgr.save("blog/old", &sample_spec("v1"), "published", Some("blog"), None, None).unwrap();

        let result = mgr.rename("blog/old", "blog/new", true).unwrap();
        assert_eq!(result.new_slug, "blog/new");
        assert!(mgr.get("blog/old").is_none());
        assert!(mgr.get("blog/new").is_some());
        assert_eq!(mgr.get_redirect("blog/old").as_deref(), Some("blog/new"));
    }

    #[test]
    fn visibility_password_roundtrip() {
        let (mgr, _) = make_manager();
        mgr.save("priv", &sample_spec("v"), "published", None, None, None).unwrap();

        mgr.set_visibility("priv", "password", Some("secret123")).unwrap();
        assert!(mgr.verify_password("priv", "secret123"));
        assert!(!mgr.verify_password("priv", "wrong"));

        mgr.set_visibility("priv", "private", None).unwrap();
        // password 영역 자동 NULL
        assert!(!mgr.verify_password("priv", "secret123"));
    }

    #[test]
    fn rename_project_renames_all_pages() {
        let (mgr, _) = make_manager();
        mgr.save("blog/p1", &sample_spec("a"), "published", Some("blog"), None, None).unwrap();
        mgr.save("blog/p2", &sample_spec("b"), "published", Some("blog"), None, None).unwrap();
        mgr.save("other/x", &sample_spec("c"), "published", Some("other"), None, None).unwrap();

        let renamed = mgr.rename_project("blog", "stock-blog", false).unwrap();
        assert_eq!(renamed.len(), 2);
        assert!(mgr.get("stock-blog/p1").is_some());
        assert!(mgr.get("stock-blog/p2").is_some());
        assert!(mgr.get("other/x").is_some()); // 다른 project 영향 X
    }
}

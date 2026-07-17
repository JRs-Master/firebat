//! PageManager — 페이지 CRUD + 정적 스캔 + 미디어 사용처 인덱스 + rename + redirect.
//!
//! 옛 TS PageManager (`core/managers/page-manager.ts`) Rust 재구현.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use crate::ports::{IDatabasePort, IStoragePort, InfraResult, MediaUsageEntry, PageListItem, PageRecord};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    #[serde(rename = "oldSlug")]
    pub old_slug: String,
    #[serde(rename = "newSlug")]
    pub new_slug: String,
}

/// 태그 사용 요약 — 옛 TS `listAllTags` 반환 1:1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSummary {
    pub tag: String,
    pub count: usize,
    pub slugs: Vec<String>,
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

    /// Owner/project-scoped list — `project` Some(non-empty) → only pages with that project; admin
    /// (None) → full list. Single enforcement point for hub `list_pages` (mirrors delete's gate).
    pub fn list_scoped(&self, project: Option<&str>) -> Vec<PageListItem> {
        match project.filter(|p| !p.is_empty()) {
            Some(p) => self
                .db
                .list_pages()
                .into_iter()
                .filter(|it| it.project.as_deref() == Some(p))
                .collect(),
            None => self.db.list_pages(),
        }
    }

    pub fn search(&self, query: &str, limit: Option<usize>) -> Vec<PageListItem> {
        self.db.search_pages(query, limit.unwrap_or(50))
    }

    pub fn get(&self, slug: &str) -> Option<PageRecord> {
        self.db.get_page(slug)
    }

    /// Owner/project-scoped get — `project` Some(non-empty) → return None when the page belongs to a
    /// different scope (hide existence, like delete). admin (None) → no check. For hub `get_page`.
    pub fn get_scoped(&self, slug: &str, project: Option<&str>) -> Option<PageRecord> {
        let rec = self.db.get_page(slug)?;
        if let Some(p) = project.filter(|p| !p.is_empty()) {
            if rec.project.as_deref() != Some(p) {
                return None;
            }
        }
        Some(rec)
    }

    /// 저장 — DB save + media_usage 인덱스 동기.
    ///
    /// PageSpec schema 강제: spec.body 가 Component 배열이어야 함 (string 또는 잘못된 type
    /// 이면 reject). 옛 cutover 잔재 / AI 가 spec.body 에 raw HTML string 을 넣었던 silent
    /// fail 차단 — 페이지 접속 시 헤더만 노출되고 본문이 비어 보이던 root cause fix.
    pub fn save(
        &self,
        slug: &str,
        spec: &str,
        status: &str,
        project: Option<&str>,
        visibility: Option<&str>,
        password: Option<&str>,
    ) -> InfraResult<()> {
        Self::validate_spec(spec)?;
        // hub-scoped page (project='hub:<id>') = reserved check 생략 — 내부 영역.
        // 일반 page 만 시스템 예약 slug (api / admin / user / hub / system / login / share 등) 차단.
        let is_hub_scoped = project
            .map(|p| p.starts_with("hub:"))
            .unwrap_or(false);
        if !is_hub_scoped {
            crate::utils::slug_validator::check_reserved(slug)?;
        }
        // Overwrite scope guard — a hub visitor (project = "hub:...") must not overwrite an existing
        // page owned by a different scope (admin or another hub). db.save_page is ON CONFLICT DO UPDATE,
        // so without this a hub save_page(adminSlug) would hijack the admin page + reassign its project.
        // Only blocks a hub saver overwriting others' slugs; admin and new-slug creation are unaffected.
        if is_hub_scoped {
            if let Some(existing) = self.get(slug) {
                if existing.project.as_deref() != project {
                    return Err(crate::i18n::t("core.error.page.permission_denied", None, &[]));
                }
            }
        }
        if !self.db.save_page(slug, spec, status, project, visibility, password) {
            return Err(crate::i18n::t(
                "core.error.page.save_failed",
                None,
                &[("slug", slug)],
            ));
        }
        let slugs = Self::extract_media_slugs(spec);
        let slugs_vec: Vec<String> = slugs.into_iter().collect();
        self.db.replace_media_usage(slug, &slugs_vec);
        Ok(())
    }

    /// PageSpec schema 검증 — body 가 Component 배열인지 확인.
    /// JSON 파싱 실패 또는 body 가 string / 객체 등 잘못된 type 이면 명확한 에러 메시지 반환.
    fn validate_spec(spec: &str) -> InfraResult<()> {
        let v: serde_json::Value = serde_json::from_str(spec).map_err(|e| {
            format!("PageSpec JSON 파싱 실패: {e}")
        })?;
        if !v.is_object() {
            return Err("PageSpec 은 객체여야 합니다.".to_string());
        }
        match v.get("body") {
            None | Some(serde_json::Value::Null) => Ok(()),
            Some(b) if b.is_array() => Ok(()),
            Some(b) if b.is_string() => Err(
                "PageSpec.body 는 Component 배열이어야 합니다 (string 금지). \
                 HTML 통째 임베드는 body:[{type:\"Html\", props:{content:\"<!DOCTYPE html>...\"}}] \
                 형식으로 감싸세요."
                    .to_string(),
            ),
            Some(_) => Err(
                "PageSpec.body 는 Component 배열이어야 합니다 (string / 객체 / 숫자 금지)."
                    .to_string(),
            ),
        }
    }

    /// Delete a page by slug, then clear its media_usage. When `project` is Some(non-empty), the
    /// delete only proceeds if the page's project matches — the single owner-scoping enforcement
    /// point across every caller (gRPC PageService, MCP + FC delete_page tools, hub cascade).
    /// admin (None/empty) = no check. Mismatch = permission error. This closes the cross-tenant gap
    /// where the MCP/FC delete_page handlers deleted by slug alone while only the gRPC path guarded.
    pub fn delete(&self, slug: &str, project: Option<&str>) -> InfraResult<()> {
        if let Some(p) = project.filter(|p| !p.is_empty()) {
            match self.get(slug) {
                Some(rec) if rec.project.as_deref() == Some(p) => {}
                _ => return Err(crate::i18n::t("core.error.page.permission_denied", None, &[])),
            }
        }
        if !self.db.delete_page(slug) {
            return Err(crate::i18n::t(
                "core.error.page.delete_failed",
                None,
                &[("slug", slug)],
            ));
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
            Err(crate::i18n::t(
                "core.error.page.visibility_failed",
                None,
                &[("slug", slug)],
            ))
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
        self.rename_inner(old_slug, new_slug_input, set_redirect, None)
    }

    /// project 고정 rename — pin_project 지정 시 새 slug 첫 segment 와 무관하게 project 를 그대로 유지.
    /// hub visitor 가 자기 페이지를 admin project 이름(예: `news/x`)으로 바꿔 admin 워크스페이스에
    /// 노출시키는 cross-tenant leak 차단. hub 경로에서만 사용 (admin 은 rename 그대로).
    pub fn rename_pinned(
        &self,
        old_slug: &str,
        new_slug_input: &str,
        set_redirect: bool,
        pin_project: &str,
    ) -> InfraResult<RenameResult> {
        self.rename_inner(old_slug, new_slug_input, set_redirect, Some(pin_project))
    }

    fn rename_inner(
        &self,
        old_slug: &str,
        new_slug_input: &str,
        set_redirect: bool,
        pin_project: Option<&str>,
    ) -> InfraResult<RenameResult> {
        let new_slug = new_slug_input
            .trim()
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_string();
        let new_slug = Self::collapse_slashes(&new_slug);
        if new_slug.is_empty() {
            return Err(crate::i18n::t("core.error.page.slug_empty", None, &[]));
        }
        if old_slug == new_slug {
            return Err(crate::i18n::t("core.error.page.slug_same", None, &[]));
        }
        if new_slug.contains(char::is_whitespace) {
            return Err(crate::i18n::t("core.error.page.slug_whitespace", None, &[]));
        }
        if self.db.get_page(&new_slug).is_some() {
            return Err(crate::i18n::t(
                "core.error.page.slug_exists",
                None,
                &[("slug", new_slug.as_str())],
            ));
        }
        let cur = self.db.get_page(old_slug).ok_or_else(|| {
            crate::i18n::t(
                "core.error.page.source_not_found",
                None,
                &[("slug", old_slug)],
            )
        })?;

        // spec JSON 안의 slug / project 자동 동기
        let mut spec_value: serde_json::Value =
            serde_json::from_str(&cur.spec).unwrap_or(serde_json::json!({}));
        spec_value["slug"] = serde_json::Value::String(new_slug.clone());
        // project 결정 — pin_project 지정(hub) 시 그대로 고정, 아니면 새 slug 첫 segment 로 자동 동기.
        let new_project = if let Some(pin) = pin_project {
            spec_value["project"] = serde_json::Value::String(pin.to_string());
            Some(pin.to_string())
        } else {
            let first_segment = new_slug.split('/').next().unwrap_or("").to_string();
            if first_segment.is_empty() {
                cur.project.clone()
            } else {
                spec_value["project"] = serde_json::Value::String(first_segment.clone());
                Some(first_segment)
            }
        };
        let spec_str = serde_json::to_string(&spec_value).map_err(|e| {
            crate::i18n::t(
                "core.error.page.spec_serialize_failed",
                None,
                &[("detail", &e.to_string())],
            )
        })?;

        // 새 slug 저장 → 옛 slug 삭제 (실패 시 옛 보존)
        self.save(
            &new_slug,
            &spec_str,
            &cur.status,
            new_project.as_deref(),
            cur.visibility.as_deref(),
            cur.password.as_deref(),
        )?;
        // internal rename cleanup — scope already validated at the rename entry; old_slug is this page.
        self.delete(old_slug, None)?;

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
            return Err(crate::i18n::t("core.error.project.name_empty", None, &[]));
        }
        if old_name == new_name {
            return Err(crate::i18n::t("core.error.project.name_same", None, &[]));
        }
        if new_name.chars().any(|c| c == '/' || c.is_whitespace()) {
            return Err(crate::i18n::t(
                "core.error.project.name_invalid_chars",
                None,
                &[],
            ));
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

    /// 명시 redirect 등록 — 프로젝트 rename 시 카탈로그 URL(`/{old-project}` → `/{new-project}`)용.
    /// 개별 페이지 redirect 는 rename() 이 처리하고, 이건 bare 프로젝트 경로 몫.
    pub fn add_redirect(&self, from_slug: &str, to_slug: &str) {
        self.db.upsert_page_redirect(from_slug, to_slug);
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

    /// 관련 페이지 추천 — `head.keywords` 의 canonical 매칭 score 기반. 옛 TS findRelatedPages 1:1.
    ///
    /// 1. 현재 페이지의 head.keywords → canonical set (tag aliases 적용)
    /// 2. published + public 페이지 중 자기 자신 제외 후보
    /// 3. 각 후보의 keywords 와 current set 매칭 개수 = score
    /// 4. score > 0 인 페이지만 score 내림차순 + updated_at 내림차순 정렬
    /// 5. top-K (default 5) 반환
    pub fn find_related_pages(
        &self,
        slug: &str,
        limit: usize,
        aliases: &crate::utils::tag_utils::TagAliases,
    ) -> Vec<PageListItem> {
        let limit = if limit == 0 { 5 } else { limit };
        let Some(current) = self.db.get_page(slug) else {
            return Vec::new();
        };
        let current_set = Self::canonical_keywords(&current.spec, aliases);
        if current_set.is_empty() {
            return Vec::new();
        }

        let candidates: Vec<PageListItem> = self
            .db
            .list_pages()
            .into_iter()
            .filter(|p| {
                p.slug != slug
                    && p.status == "published"
                    && p.visibility.as_deref().unwrap_or("public") == "public"
            })
            .collect();

        let mut scored: Vec<(PageListItem, usize)> = Vec::new();
        for p in candidates {
            let Some(rec) = self.db.get_page(&p.slug) else {
                continue;
            };
            let kws = Self::canonical_keywords(&rec.spec, aliases);
            let score = kws.iter().filter(|k| current_set.contains(*k)).count();
            if score > 0 {
                scored.push((p, score));
            }
        }
        scored.sort_by(|a, b| {
            b.1.cmp(&a.1).then_with(|| {
                let au = a.0.updated_at;
                let bu = b.0.updated_at;
                bu.cmp(&au)
            })
        });
        scored.into_iter().take(limit).map(|(p, _)| p).collect()
    }

    /// 모든 published + public 페이지의 head.keywords 합집합 + 사용 빈도. 옛 TS listAllTags 1:1.
    /// `[(tag, count, slugs)]` — count 내림차순. tag 는 canonical (alias 통합).
    pub fn list_all_tags(
        &self,
        aliases: &crate::utils::tag_utils::TagAliases,
    ) -> Vec<TagSummary> {
        let mut tag_map: std::collections::HashMap<String, HashSet<String>> = Default::default();
        let visible: Vec<PageListItem> = self
            .db
            .list_pages()
            .into_iter()
            .filter(|p| {
                p.status == "published"
                    && p.visibility.as_deref().unwrap_or("public") == "public"
            })
            .collect();
        for p in visible {
            let Some(rec) = self.db.get_page(&p.slug) else {
                continue;
            };
            for k in Self::canonical_keywords(&rec.spec, aliases) {
                tag_map.entry(k).or_default().insert(p.slug.clone());
            }
        }
        let mut summaries: Vec<TagSummary> = tag_map
            .into_iter()
            .map(|(tag, slugs)| {
                let count = slugs.len();
                TagSummary {
                    tag,
                    count,
                    slugs: slugs.into_iter().collect(),
                }
            })
            .collect();
        summaries.sort_by(|a, b| b.count.cmp(&a.count));
        summaries
    }

    /// PageSpec JSON 의 head.keywords 추출 → canonical 매핑 + dedup.
    fn canonical_keywords(
        spec: &str,
        aliases: &crate::utils::tag_utils::TagAliases,
    ) -> HashSet<String> {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(spec) else {
            return HashSet::new();
        };
        let Some(keywords) = parsed
            .get("head")
            .and_then(|h| h.get("keywords"))
            .and_then(|k| k.as_array())
        else {
            return HashSet::new();
        };
        let mut set = HashSet::new();
        for kw in keywords {
            if let Some(s) = kw.as_str() {
                let canonical = crate::utils::tag_utils::normalize_tag(s, aliases);
                if !canonical.is_empty() {
                    set.insert(canonical);
                }
            }
        }
        set
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

// Tests 이관 — `infra/tests/page_manager_test.rs` (integration test).
// private fn 사용 test 만 inline 유지 — `extract_media_slugs_from_spec`
// (uses `PageManager::extract_media_slugs` private fn).
#[cfg(test)]
mod tests {
    use super::*;

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
}

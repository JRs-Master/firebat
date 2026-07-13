//! Domain catalog sources (#search-tool 확장) — skills / templates / pages / media를
//! `RefreshingCatalog`(S1 엔진) 에 얹는 CatalogSource 구현들.
//!
//! Why: these corpora grow into the hundreds — a flat `list_*` dump then becomes the same
//! anti-pattern as the 275-action enum (많은 정보 한번에), and the old `search_skills` was
//! substring-only (a "주식 리포트" query cannot find a "stock-report" manual unless the
//! literal word appears). One engine (dense + lexical boost, hash-cached embeddings), one
//! catalog per domain.
//!
//! Owner scoping: entries are indexed for the durable corpora — shipped `system:` items and
//! the admin workspace (`admin:`). Hub sessions are ephemeral and tiny (their own items are
//! fully covered by list/index tools); hub callers search with `["system:"]` only (skills) or
//! get an empty scope (templates/pages/media) — never the admin corpus. This keeps the index
//! bounded (no per-session embedding churn) with zero cross-tenant leakage.

use std::sync::Arc;

use crate::managers::ai::semantic_catalog::{CatalogEntry, CatalogSource};
use crate::managers::media::MediaManager;
use crate::managers::page::PageManager;
use crate::managers::skill_file::SkillFileManager;
use crate::managers::template::TemplateManager;
use crate::ports::MediaListOpts;

/// Skills — system ∪ admin (`list(None)` merges with owner override). id = `{scope}:{slug}`.
pub struct SkillCatalogSource {
    pub skills: Arc<SkillFileManager>,
}

#[async_trait::async_trait]
impl CatalogSource for SkillCatalogSource {
    async fn load(&self) -> Vec<CatalogEntry> {
        let entries = self.skills.list(None).await.unwrap_or_default();
        entries
            .into_iter()
            .map(|e| {
                let scope = if e.source == "system" { "system" } else { "admin" };
                CatalogEntry {
                    id: format!("{}:{}", scope, e.slug),
                    name: e.name.clone(),
                    description: format!("[{}] {}", e.kind, e.description),
                    extra: serde_json::json!({
                        "slug": e.slug,
                        "kind": e.kind,
                        "source": e.source,
                    }),
                }
            })
            .collect()
    }
}

/// Templates — system(shipped) ∪ admin workspace (`list(None)` merges). id = `{scope}:{slug}`
/// (skills 미러 — hub 는 system 스코프 + allowlist 필터로 검색). Semantic text =
/// name + description + tags (tags are the routing signal for report-style templates).
pub struct TemplateCatalogSource {
    pub templates: Arc<TemplateManager>,
}

#[async_trait::async_trait]
impl CatalogSource for TemplateCatalogSource {
    async fn load(&self) -> Vec<CatalogEntry> {
        self.templates
            .list(None)
            .await
            .into_iter()
            .map(|t| {
                let scope = if t.source == "system" { "system" } else { "admin" };
                CatalogEntry {
                    id: format!("{}:{}", scope, t.slug),
                    name: t.name.clone(),
                    description: format!("{} {}", t.description, t.tags.join(" ")).trim().to_string(),
                    extra: serde_json::json!({
                        "slug": t.slug,
                        "tags": t.tags,
                        "source": t.source,
                    }),
                }
            })
            .collect()
    }
}

/// Pages — admin pages only (hub-scoped `project=hub:*` rows are per-session, excluded).
/// id = `admin:{slug}`. Semantic text = title + excerpt + project.
pub struct PageCatalogSource {
    pub pages: Arc<PageManager>,
}

#[async_trait::async_trait]
impl CatalogSource for PageCatalogSource {
    async fn load(&self) -> Vec<CatalogEntry> {
        self.pages
            .list()
            .into_iter()
            .filter(|p| !p.project.as_deref().unwrap_or("").starts_with("hub:"))
            .map(|p| {
                let title = p.title.clone().unwrap_or_else(|| p.slug.clone());
                let desc = format!(
                    "{} {}",
                    p.excerpt.clone().unwrap_or_default(),
                    p.project.clone().unwrap_or_default()
                )
                .trim()
                .to_string();
                CatalogEntry {
                    id: format!("admin:{}", p.slug),
                    name: title,
                    description: desc,
                    extra: serde_json::json!({
                        "slug": p.slug,
                        "project": p.project,
                        "status": p.status,
                        "updatedAt": p.updated_at,
                    }),
                }
            })
            .collect()
    }
}

/// Media — admin gallery (prompt text is the semantic body: "그 우주 고양이 그림" style
/// queries). id = `admin:{slug}`. Capped at the most recent 2000 (hash cache keeps rebuilds
/// cheap; beyond that the oldest items age out of the index, not out of the gallery).
pub struct MediaCatalogSource {
    pub media: Arc<MediaManager>,
}

#[async_trait::async_trait]
impl CatalogSource for MediaCatalogSource {
    async fn load(&self) -> Vec<CatalogEntry> {
        let items = match self
            .media
            .list(MediaListOpts {
                scope: None,
                limit: Some(2000),
                offset: None,
                search: None,
                hub_owner: None,
            })
            .await
        {
            Ok(r) => r.items,
            Err(_) => return Vec::new(),
        };
        items
            .into_iter()
            .map(|m| {
                let name = m
                    .filename_hint
                    .clone()
                    .unwrap_or_else(|| m.slug.clone());
                let desc = format!(
                    "{} {}",
                    m.prompt.clone().unwrap_or_default(),
                    m.revised_prompt.clone().unwrap_or_default()
                )
                .trim()
                .to_string();
                CatalogEntry {
                    id: format!("admin:{}", m.slug),
                    name,
                    description: desc,
                    extra: serde_json::json!({
                        "slug": m.slug,
                        "contentType": m.content_type,
                        "createdAt": m.created_at,
                    }),
                }
            })
            .collect()
    }
}

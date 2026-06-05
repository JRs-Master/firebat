//! gRPC PageService impl — PageManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.
//! 2026-05-15 — 옛 공유 타입 (Empty / StringRequest / BoolRequest / OptionalStringPb / StringListPb)
//! 폐기 + 매 RPC unique Request / Response.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::page::{PageManager, TagSummary};
use crate::ports::{MediaUsageEntry, PageListItem, PageRecord};
use crate::proto::{
    page_service_server::PageService, MediaUsageEntryPb, MediaUsageListPb, PageDeleteRequest,
    PageDeleteResponse, PageFindMediaUsageRequest, PageFindRelatedRequest, PageGetRedirectRequest,
    PageGetRedirectResponse, PageGetRequest, PageListAllTagsRequest, PageListItemPb,
    PageFindRelatedResponse, PageListRequest, PageListResponse, PageListStaticRequest,
    PageListStaticResponse, PageSearchResponse,
    PageRecordPb, PageRenameRequest, PageRenameResponse, PageSaveRequest, PageSaveResultPb,
    PageSearchRequest, PageSetVisibilityRequest, PageSetVisibilityResponse, PageVerifyPasswordRequest,
    PageVerifyPasswordResponse, TagListPb, TagSummaryPb,
};

pub struct PageServiceImpl {
    manager: Arc<PageManager>,
}

impl PageServiceImpl {
    pub fn new(manager: Arc<PageManager>) -> Self {
        Self { manager }
    }

    /// hub project scoping — project 지정 시 page.project 와 일치할 때만 통과. admin(None/빈값)은 무검사.
    /// 불일치·부재 = PermissionDenied (존재 여부 노출 방지). 프론트 가드 대신 core 가 강제하는 단일 지점.
    fn ensure_page_project(&self, slug: &str, project: Option<&str>) -> Result<(), TonicStatus> {
        let project = match project {
            Some(p) if !p.is_empty() => p,
            _ => return Ok(()),
        };
        match self.manager.get(slug) {
            Some(r) if r.project.as_deref() == Some(project) => Ok(()),
            _ => Err(TonicStatus::permission_denied(
                "이 페이지에 접근할 권한이 없습니다.",
            )),
        }
    }
}

// ─── proto ↔ core port struct 변환 ─────────────────────────────────────────

impl From<PageListItem> for PageListItemPb {
    fn from(p: PageListItem) -> Self {
        PageListItemPb {
            slug: p.slug,
            status: p.status,
            project: p.project,
            visibility: p.visibility,
            title: p.title,
            updated_at: p.updated_at,
            created_at: p.created_at,
            featured_image: p.featured_image,
            excerpt: p.excerpt,
        }
    }
}

fn page_list_items_pb(items: Vec<PageListItem>) -> Vec<PageListItemPb> {
    items.into_iter().map(Into::into).collect()
}

impl From<PageRecord> for PageRecordPb {
    fn from(r: PageRecord) -> Self {
        PageRecordPb {
            slug: r.slug,
            spec: r.spec,
            status: r.status,
            project: r.project,
            visibility: r.visibility,
            password: r.password,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

impl From<MediaUsageEntry> for MediaUsageEntryPb {
    fn from(e: MediaUsageEntry) -> Self {
        MediaUsageEntryPb {
            page_slug: e.page_slug,
            used_at: e.used_at,
        }
    }
}

impl From<TagSummary> for TagSummaryPb {
    fn from(t: TagSummary) -> Self {
        TagSummaryPb {
            tag: t.tag,
            count: t.count as i64,
            slugs: t.slugs,
        }
    }
}

#[tonic::async_trait]
impl PageService for PageServiceImpl {
    async fn list(
        &self,
        _req: Request<PageListRequest>,
    ) -> Result<Response<PageListResponse>, TonicStatus> {
        Ok(Response::new(PageListResponse {
            items: page_list_items_pb(self.manager.list()),
        }))
    }

    async fn search(
        &self,
        req: Request<PageSearchRequest>,
    ) -> Result<Response<PageSearchResponse>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(PageSearchResponse {
            items: page_list_items_pb(self.manager.search(&args.query, args.limit.map(|v| v as usize))),
        }))
    }

    async fn get(
        &self,
        req: Request<PageGetRequest>,
    ) -> Result<Response<PageRecordPb>, TonicStatus> {
        let slug = req.into_inner().slug;
        match self.manager.get(&slug) {
            Some(record) => Ok(Response::new(record.into())),
            None => Err(TonicStatus::not_found(format!("page '{slug}' not found"))),
        }
    }

    async fn save(
        &self,
        req: Request<PageSaveRequest>,
    ) -> Result<Response<PageSaveResultPb>, TonicStatus> {
        let args = req.into_inner();
        let slug = args.slug.clone();
        let status = args.status.unwrap_or_else(|| "published".to_string());
        match self.manager.save(
            &args.slug,
            &args.spec,
            &status,
            args.project.as_deref(),
            args.visibility.as_deref(),
            args.password.as_deref(),
        ) {
            Ok(()) => Ok(Response::new(PageSaveResultPb {
                ok: true,
                slug,
                error: None,
            })),
            Err(e) => Ok(Response::new(PageSaveResultPb {
                ok: false,
                slug,
                error: Some(e),
            })),
        }
    }

    async fn delete(
        &self,
        req: Request<PageDeleteRequest>,
    ) -> Result<Response<PageDeleteResponse>, TonicStatus> {
        let args = req.into_inner();
        // hub project scoping — project 지정 시 page.project 일치할 때만. admin(None) 무검사.
        self.ensure_page_project(&args.slug, args.project.as_deref())?;
        self.manager
            .delete(&args.slug)
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(PageDeleteResponse {}))
    }

    async fn rename(
        &self,
        req: Request<PageRenameRequest>,
    ) -> Result<Response<PageRenameResponse>, TonicStatus> {
        let args = req.into_inner();
        // hub project scoping — project 지정 시 옛 slug 의 page.project 일치할 때만. admin(None) 무검사.
        self.ensure_page_project(&args.old_slug, args.project.as_deref())?;
        let set_redirect = args.set_redirect.unwrap_or(false);
        // hub 경로(project 지정) → project 고정 rename (새 slug 가 admin project 로 새는 leak 차단).
        // admin(None) → 기존 rename (새 slug 첫 segment 로 project 자동 동기).
        match args.project.as_deref().filter(|s| !s.is_empty()) {
            Some(pin) => self
                .manager
                .rename_pinned(&args.old_slug, &args.new_slug, set_redirect, pin),
            None => self
                .manager
                .rename(&args.old_slug, &args.new_slug, set_redirect),
        }
        .map_err(TonicStatus::internal)?;
        Ok(Response::new(PageRenameResponse {}))
    }

    async fn get_redirect(
        &self,
        req: Request<PageGetRedirectRequest>,
    ) -> Result<Response<PageGetRedirectResponse>, TonicStatus> {
        let from = req.into_inner().slug;
        let to = self.manager.get_redirect(&from);
        Ok(Response::new(PageGetRedirectResponse {
            value: to.clone().unwrap_or_default(),
            present: to.is_some(),
        }))
    }

    async fn list_static(
        &self,
        _req: Request<PageListStaticRequest>,
    ) -> Result<Response<PageListStaticResponse>, TonicStatus> {
        let slugs = self.manager.list_static().await;
        Ok(Response::new(PageListStaticResponse { slugs }))
    }

    async fn find_media_usage(
        &self,
        req: Request<PageFindMediaUsageRequest>,
    ) -> Result<Response<MediaUsageListPb>, TonicStatus> {
        let media_slug = req.into_inner().media_slug;
        let entries = self
            .manager
            .find_media_usage(&media_slug)
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(MediaUsageListPb { entries }))
    }

    async fn set_visibility(
        &self,
        req: Request<PageSetVisibilityRequest>,
    ) -> Result<Response<PageSetVisibilityResponse>, TonicStatus> {
        let args = req.into_inner();
        // hub project scoping — project 지정 시 page.project 일치할 때만. admin(None) 무검사.
        self.ensure_page_project(&args.slug, args.project.as_deref())?;
        self.manager
            .set_visibility(&args.slug, &args.visibility, args.password.as_deref())
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(PageSetVisibilityResponse {}))
    }

    async fn verify_password(
        &self,
        req: Request<PageVerifyPasswordRequest>,
    ) -> Result<Response<PageVerifyPasswordResponse>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(PageVerifyPasswordResponse {
            valid: self.manager.verify_password(&args.slug, &args.password),
        }))
    }

    async fn find_related(
        &self,
        req: Request<PageFindRelatedRequest>,
    ) -> Result<Response<PageFindRelatedResponse>, TonicStatus> {
        let args = req.into_inner();
        let aliases = crate::utils::tag_utils::parse_tag_aliases(args.tag_aliases_raw.as_deref());
        let limit = args.limit.map(|v| v as usize).unwrap_or(5);
        let related = self
            .manager
            .find_related_pages(&args.slug, limit, &aliases);
        Ok(Response::new(PageFindRelatedResponse {
            items: page_list_items_pb(related),
        }))
    }

    async fn list_all_tags(
        &self,
        _req: Request<PageListAllTagsRequest>,
    ) -> Result<Response<TagListPb>, TonicStatus> {
        let aliases = crate::utils::tag_utils::TagAliases::new();
        let tags = self
            .manager
            .list_all_tags(&aliases)
            .into_iter()
            .map(Into::into)
            .collect();
        Ok(Response::new(TagListPb { tags }))
    }
}

// Tests 이관 — `infra/tests/svc_page_test.rs` (integration test).

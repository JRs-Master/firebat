//! gRPC PageService impl — PageManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core port struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::page::{PageManager, TagSummary};
use crate::ports::{MediaUsageEntry, PageListItem, PageRecord};
use crate::proto::{
    page_service_server::PageService, BoolRequest, Empty, MediaUsageEntryPb, MediaUsageListPb,
    OptionalStringPb, PageFindRelatedRequest, PageListItemPb, PageListResponsePb, PageRecordPb,
    PageRenameRequest, PageSaveRequest, PageSaveResultPb, PageSearchRequest,
    PageSetVisibilityRequest, PageVerifyPasswordRequest, Status, StringListPb, StringRequest,
    TagListPb, TagSummaryPb,
};

pub struct PageServiceImpl {
    manager: Arc<PageManager>,
}

impl PageServiceImpl {
    pub fn new(manager: Arc<PageManager>) -> Self {
        Self { manager }
    }
}

fn ok_status() -> Response<Status> {
    Response::new(Status {
        ok: true,
        error: String::new(),
        error_code: String::new(),
    })
}

fn err_status(msg: impl Into<String>) -> Response<Status> {
    Response::new(Status {
        ok: false,
        error: msg.into(),
        error_code: String::new(),
    })
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

fn page_list_to_pb(items: Vec<PageListItem>) -> PageListResponsePb {
    PageListResponsePb {
        items: items.into_iter().map(Into::into).collect(),
    }
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
    async fn list(&self, _req: Request<Empty>) -> Result<Response<PageListResponsePb>, TonicStatus> {
        Ok(Response::new(page_list_to_pb(self.manager.list())))
    }

    async fn search(
        &self,
        req: Request<PageSearchRequest>,
    ) -> Result<Response<PageListResponsePb>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(page_list_to_pb(
            self.manager.search(&args.query, args.limit.map(|v| v as usize)),
        )))
    }

    async fn get(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<PageRecordPb>, TonicStatus> {
        let slug = req.into_inner().value;
        Ok(Response::new(
            self.manager
                .get(&slug)
                .map(Into::into)
                .unwrap_or_default(),
        ))
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
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let slug = req.into_inner().value;
        match self.manager.delete(&slug) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn rename(&self, req: Request<PageRenameRequest>) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .rename(&args.old_slug, &args.new_slug, args.set_redirect.unwrap_or(false))
        {
            Ok(_) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_redirect(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<OptionalStringPb>, TonicStatus> {
        let from = req.into_inner().value;
        let to = self.manager.get_redirect(&from);
        Ok(Response::new(OptionalStringPb {
            value: to.clone().unwrap_or_default(),
            present: to.is_some(),
        }))
    }

    async fn list_static(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringListPb>, TonicStatus> {
        let slugs = self.manager.list_static().await;
        Ok(Response::new(StringListPb { values: slugs }))
    }

    async fn find_media_usage(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<MediaUsageListPb>, TonicStatus> {
        let media_slug = req.into_inner().value;
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
    ) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .set_visibility(&args.slug, &args.visibility, args.password.as_deref())
        {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn verify_password(
        &self,
        req: Request<PageVerifyPasswordRequest>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(BoolRequest {
            value: self.manager.verify_password(&args.slug, &args.password),
        }))
    }

    async fn find_related(
        &self,
        req: Request<PageFindRelatedRequest>,
    ) -> Result<Response<PageListResponsePb>, TonicStatus> {
        let args = req.into_inner();
        let aliases = crate::utils::tag_utils::parse_tag_aliases(args.tag_aliases_raw.as_deref());
        let limit = args.limit.map(|v| v as usize).unwrap_or(5);
        let related = self
            .manager
            .find_related_pages(&args.slug, limit, &aliases);
        Ok(Response::new(page_list_to_pb(related)))
    }

    async fn list_all_tags(
        &self,
        _req: Request<Empty>,
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

//! gRPC PageService impl — PageManager wrapping.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::page::PageManager;
use crate::proto::{
    page_service_server::PageService, BoolRequest, Empty, JsonArgs, JsonValue, Status,
    StringRequest,
};

pub struct PageServiceImpl {
    manager: Arc<PageManager>,
}

impl PageServiceImpl {
    pub fn new(manager: Arc<PageManager>) -> Self {
        Self { manager }
    }
}

fn json_response<T: serde::Serialize>(value: &T) -> Result<Response<JsonValue>, TonicStatus> {
    let raw = serde_json::to_string(value)
        .map_err(|e| TonicStatus::internal(format!("JSON 직렬화 실패: {e}")))?;
    Ok(Response::new(JsonValue { raw }))
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

#[tonic::async_trait]
impl PageService for PageServiceImpl {
    async fn list(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        json_response(&self.manager.list())
    }

    async fn search(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            query: String,
            #[serde(default)]
            limit: Option<usize>,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("search args: {e}")))?;
        json_response(&self.manager.search(&args.query, args.limit))
    }

    async fn get(&self, req: Request<StringRequest>) -> Result<Response<JsonValue>, TonicStatus> {
        let slug = req.into_inner().value;
        json_response(&self.manager.get(&slug))
    }

    async fn save(&self, req: Request<JsonArgs>) -> Result<Response<JsonValue>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            slug: String,
            spec: String,
            #[serde(default = "default_published")]
            status: String,
            #[serde(default)]
            project: Option<String>,
            #[serde(default)]
            visibility: Option<String>,
            #[serde(default)]
            password: Option<String>,
        }
        fn default_published() -> String { "published".into() }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("save args: {e}")))?;
        match self.manager.save(
            &args.slug,
            &args.spec,
            &args.status,
            args.project.as_deref(),
            args.visibility.as_deref(),
            args.password.as_deref(),
        ) {
            Ok(()) => json_response(&serde_json::json!({"ok": true, "slug": args.slug})),
            Err(e) => json_response(&serde_json::json!({"ok": false, "error": e})),
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

    async fn rename(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            old_slug: String,
            new_slug: String,
            #[serde(default)]
            set_redirect: bool,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("rename args: {e}"))),
        };
        match self.manager.rename(&args.old_slug, &args.new_slug, args.set_redirect) {
            Ok(_) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn get_redirect(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let from = req.into_inner().value;
        let to = self.manager.get_redirect(&from);
        json_response(&to)
    }

    async fn list_static(&self, _req: Request<Empty>) -> Result<Response<JsonValue>, TonicStatus> {
        let slugs = self.manager.list_static().await;
        json_response(&slugs)
    }

    async fn find_media_usage(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let media_slug = req.into_inner().value;
        let usage = self.manager.find_media_usage(&media_slug);
        json_response(&usage)
    }

    async fn set_visibility(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            slug: String,
            visibility: String,
            #[serde(default)]
            password: Option<String>,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_visibility args: {e}"))),
        };
        match self.manager.set_visibility(&args.slug, &args.visibility, args.password.as_deref()) {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn verify_password(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<BoolRequest>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            slug: String,
            password: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("verify args: {e}")))?;
        Ok(Response::new(BoolRequest {
            value: self.manager.verify_password(&args.slug, &args.password),
        }))
    }

    async fn find_related(
        &self,
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-9 stub — head.keywords 매칭 알고리즘은 별 phase 에서 박힘
        json_response(&Vec::<serde_json::Value>::new())
    }

    async fn list_all_tags(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-9 stub — 모든 페이지 head.keywords 빈도 집계는 별 phase
        json_response(&Vec::<serde_json::Value>::new())
    }
}

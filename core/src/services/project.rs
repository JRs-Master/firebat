//! gRPC ProjectService impl — ProjectManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 박혀 core managers struct ↔ proto generated struct 변환.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::project::{ProjectEntry, ProjectManager, ProjectVisibility};
use crate::proto::{
    project_service_server::ProjectService, BoolRequest, Empty, JsonArgs, ProjectConfigPb,
    ProjectEntryPb, ProjectListPb, ProjectVisibilityPb, Status, StringRequest,
};

pub struct ProjectServiceImpl {
    manager: Arc<ProjectManager>,
}

impl ProjectServiceImpl {
    pub fn new(manager: Arc<ProjectManager>) -> Self {
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

// ─── proto ↔ core managers struct 변환 ────────────────────────────────────────

impl From<ProjectEntry> for ProjectEntryPb {
    fn from(e: ProjectEntry) -> Self {
        ProjectEntryPb {
            name: e.name,
            paths: e.paths,
            page_slugs: e.page_slugs,
            visibility: match e.visibility {
                ProjectVisibility::Public => "public".to_string(),
                ProjectVisibility::Password => "password".to_string(),
                ProjectVisibility::Private => "private".to_string(),
            },
        }
    }
}

fn visibility_to_pb(v: ProjectVisibility) -> ProjectVisibilityPb {
    ProjectVisibilityPb {
        visibility: match v {
            ProjectVisibility::Public => "public".to_string(),
            ProjectVisibility::Password => "password".to_string(),
            ProjectVisibility::Private => "private".to_string(),
        },
    }
}

#[tonic::async_trait]
impl ProjectService for ProjectServiceImpl {
    async fn scan(&self, _req: Request<Empty>) -> Result<Response<ProjectListPb>, TonicStatus> {
        let projects = self.manager.scan().await.into_iter().map(Into::into).collect();
        Ok(Response::new(ProjectListPb { projects }))
    }

    async fn set_visibility(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            project: String,
            visibility: ProjectVisibility,
            #[serde(default)]
            password: Option<String>,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_visibility args: {e}"))),
        };
        self.manager
            .set_visibility(&args.project, args.visibility, args.password.as_deref());
        Ok(ok_status())
    }

    async fn get_visibility(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<ProjectVisibilityPb>, TonicStatus> {
        let project = req.into_inner().value;
        Ok(Response::new(visibility_to_pb(
            self.manager.get_visibility(&project),
        )))
    }

    async fn get_config(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<ProjectConfigPb>, TonicStatus> {
        let name = req.into_inner().value;
        let config = self.manager.get_config(&name).await;
        let raw_json = config
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok())
            .unwrap_or_else(|| "null".to_string());
        Ok(Response::new(ProjectConfigPb { raw_json }))
    }

    async fn set_config(&self, req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            name: String,
            config: serde_json::Value,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("set_config args: {e}"))),
        };
        match self.manager.set_config(&args.name, &args.config).await {
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
            project: String,
            password: String,
        }
        let args: Args = serde_json::from_str(&raw)
            .map_err(|e| TonicStatus::invalid_argument(format!("verify args: {e}")))?;
        Ok(Response::new(BoolRequest {
            value: self.manager.verify_password(&args.project, &args.password),
        }))
    }

    async fn delete(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let project = req.into_inner().value;
        match self.manager.delete(&project).await {
            Ok(_) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn rename(&self, _req: Request<JsonArgs>) -> Result<Response<Status>, TonicStatus> {
        // Phase B-8 미구현 — Phase B-9 PageManager (DB) 와 함께 설정 (slug rename + redirect).
        Ok(err_status("rename — Phase B-9 와 같이 설정"))
    }
}

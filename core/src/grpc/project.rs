//! gRPC ProjectService impl — ProjectManager wrapping.
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + proto generated typed message 사용.
//! From impl 정의 — core managers struct ↔ proto generated struct 변환.
//! 2026-05-15 — 옛 공유 타입 (Empty / StringRequest / BoolRequest) 폐기 + 매 RPC unique
//! Request / Response.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::project::{ProjectEntry, ProjectManager, ProjectVisibility};
use crate::proto::{
    project_service_server::ProjectService, ProjectConfigPb, ProjectDeleteRequest,
    ProjectDeleteResponse, ProjectEntryPb, ProjectGetConfigRequest, ProjectGetVisibilityRequest,
    ProjectListPb, ProjectRenameRequest, ProjectRenameResponse, ProjectScanRequest,
    ProjectSetConfigRequest, ProjectSetConfigResponse, ProjectSetVisibilityRequest,
    ProjectSetVisibilityResponse, ProjectVerifyPasswordRequest, ProjectVerifyPasswordResponse,
    ProjectVisibilityPb,
};

pub struct ProjectServiceImpl {
    manager: Arc<ProjectManager>,
}

impl ProjectServiceImpl {
    pub fn new(manager: Arc<ProjectManager>) -> Self {
        Self { manager }
    }
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
    async fn scan(
        &self,
        _req: Request<ProjectScanRequest>,
    ) -> Result<Response<ProjectListPb>, TonicStatus> {
        let projects = self.manager.scan().await.into_iter().map(Into::into).collect();
        Ok(Response::new(ProjectListPb { projects }))
    }

    async fn set_visibility(
        &self,
        req: Request<ProjectSetVisibilityRequest>,
    ) -> Result<Response<ProjectSetVisibilityResponse>, TonicStatus> {
        let args = req.into_inner();
        let visibility = match args.visibility.as_str() {
            "public" => ProjectVisibility::Public,
            "password" => ProjectVisibility::Password,
            "private" => ProjectVisibility::Private,
            other => {
                return Err(TonicStatus::invalid_argument(format!(
                    "unknown visibility: {other}"
                )))
            }
        };
        self.manager
            .set_visibility(&args.project, visibility, args.password.as_deref());
        Ok(Response::new(ProjectSetVisibilityResponse {}))
    }

    async fn get_visibility(
        &self,
        req: Request<ProjectGetVisibilityRequest>,
    ) -> Result<Response<ProjectVisibilityPb>, TonicStatus> {
        let project = req.into_inner().project;
        Ok(Response::new(visibility_to_pb(
            self.manager.get_visibility(&project),
        )))
    }

    async fn get_config(
        &self,
        req: Request<ProjectGetConfigRequest>,
    ) -> Result<Response<ProjectConfigPb>, TonicStatus> {
        let name = req.into_inner().project;
        let config = self.manager.get_config(&name).await;
        let raw_json = config
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok())
            .unwrap_or_else(|| "null".to_string());
        Ok(Response::new(ProjectConfigPb { raw_json }))
    }

    async fn set_config(
        &self,
        req: Request<ProjectSetConfigRequest>,
    ) -> Result<Response<ProjectSetConfigResponse>, TonicStatus> {
        let args = req.into_inner();
        let config: serde_json::Value = serde_json::from_str(&args.config_json)
            .map_err(|e| TonicStatus::invalid_argument(format!("set_config json: {e}")))?;
        self.manager
            .set_config(&args.project, &config)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ProjectSetConfigResponse {}))
    }

    async fn verify_password(
        &self,
        req: Request<ProjectVerifyPasswordRequest>,
    ) -> Result<Response<ProjectVerifyPasswordResponse>, TonicStatus> {
        let args = req.into_inner();
        Ok(Response::new(ProjectVerifyPasswordResponse {
            valid: self.manager.verify_password(&args.project, &args.password),
        }))
    }

    async fn delete(
        &self,
        req: Request<ProjectDeleteRequest>,
    ) -> Result<Response<ProjectDeleteResponse>, TonicStatus> {
        let project = req.into_inner().project;
        self.manager
            .delete(&project)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(ProjectDeleteResponse {}))
    }

    async fn rename(
        &self,
        _req: Request<ProjectRenameRequest>,
    ) -> Result<Response<ProjectRenameResponse>, TonicStatus> {
        // Phase B-8 미구현 — Phase B-9 PageManager (DB) 와 함께 (slug rename + redirect).
        Err(TonicStatus::unimplemented(crate::i18n::t(
            "core.error.rpc.rename_unimplemented",
            None,
            &[],
        )))
    }
}

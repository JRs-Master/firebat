//! gRPC SkillService impl — thin delegate to `SkillFileManager`.
//!
//! Sidebar CRUD path — admin (empty owner) or hub (`hub:<inst>:<sid>`, per-session). The
//! sidebar is reused in hub, so skills (a sidebar panel, like templates) are owner-scoped here
//! too; the hub route injects the session owner. The AI `skill_*` tools call `SkillFileManager`
//! directly with their own owner. All file logic (frontmatter, kind index, system∪owner merge,
//! owner scoping) lives in the manager so both paths stay in sync. `save`/`delete` only touch the
//! writable user/owner dir; shipped system skills are repo-managed.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::skill_file::{SkillEntry, SkillFileManager};
use crate::proto::{
    skill_service_server::SkillService, SkillDeleteFileRequest, SkillDeleteFileResponse,
    SkillListFilesRequest, SkillListFilesResponse, SkillReadFileRequest, SkillReadFileResponse,
    SkillSaveFileRequest, SkillSaveFileResponse,
};

pub struct SkillServiceImpl {
    manager: Arc<SkillFileManager>,
}

impl SkillServiceImpl {
    pub fn new(manager: Arc<SkillFileManager>) -> Self {
        Self { manager }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// Empty / "admin" => admin scope (None); otherwise the hub session owner.
fn owner_opt(owner: &str) -> Option<&str> {
    match owner.trim() {
        "" | "admin" => None,
        o => Some(o),
    }
}

#[tonic::async_trait]
impl SkillService for SkillServiceImpl {
    async fn list_files(
        &self,
        req: Request<SkillListFilesRequest>,
    ) -> Result<Response<SkillListFilesResponse>, TonicStatus> {
        let owner = req.into_inner().owner;
        let entries = self
            .manager
            .list(owner_opt(&owner))
            .await
            .unwrap_or_default();
        Ok(Response::new(SkillListFilesResponse {
            raw_json: to_raw_json(&entries),
        }))
    }

    async fn read_file(
        &self,
        req: Request<SkillReadFileRequest>,
    ) -> Result<Response<SkillReadFileResponse>, TonicStatus> {
        let a = req.into_inner();
        match self.manager.read(owner_opt(&a.owner), &a.slug).await {
            Ok(entry) => Ok(Response::new(SkillReadFileResponse {
                raw_json: to_raw_json(&entry),
            })),
            Err(e) => Err(TonicStatus::not_found(e)),
        }
    }

    async fn save_file(
        &self,
        req: Request<SkillSaveFileRequest>,
    ) -> Result<Response<SkillSaveFileResponse>, TonicStatus> {
        let a = req.into_inner();
        let name = if a.name.trim().is_empty() {
            a.slug.clone()
        } else {
            a.name
        };
        let entry = SkillEntry {
            slug: a.slug,
            name,
            kind: a.kind,
            description: a.description,
            content: a.content,
            source: "user".to_string(),
        };
        self.manager
            .save(owner_opt(&a.owner), &entry)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(SkillSaveFileResponse {}))
    }

    async fn delete_file(
        &self,
        req: Request<SkillDeleteFileRequest>,
    ) -> Result<Response<SkillDeleteFileResponse>, TonicStatus> {
        let a = req.into_inner();
        self.manager
            .delete(owner_opt(&a.owner), &a.slug)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(SkillDeleteFileResponse {}))
    }
}

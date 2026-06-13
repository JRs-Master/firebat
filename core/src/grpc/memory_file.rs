//! gRPC MemoryService impl — thin delegate to `MemoryFileManager`.
//!
//! Location: `<workspace>/data/memory/`. MEMORY.md is the (dynamically built) index;
//! the other *.md files are individual entries. Four categories: user / feedback /
//! project / reference.
//!
//! This service is the admin tab's CRUD path — always admin scope (None owner). The AI
//! `memory_*` tools call `MemoryFileManager` directly with their own owner. All file logic
//! (frontmatter, index, owner scoping) lives in the manager so both paths stay in sync.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::memory_file::{MemoryEntry, MemoryFileManager};
use crate::proto::{
    memory_service_server::MemoryService, MemoryDeleteFileRequest, MemoryDeleteFileResponse,
    MemoryGetIndexRequest, MemoryGetIndexResponse, MemoryListFilesRequest,
    MemoryListFilesResponse, MemoryReadFileRequest, MemoryReadFileResponse, MemorySaveFileRequest,
    MemorySaveFileResponse,
};

pub struct MemoryServiceImpl {
    manager: Arc<MemoryFileManager>,
}

impl MemoryServiceImpl {
    pub fn new(manager: Arc<MemoryFileManager>) -> Self {
        Self { manager }
    }
}

fn to_raw_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl MemoryService for MemoryServiceImpl {
    async fn get_index(
        &self,
        _req: Request<MemoryGetIndexRequest>,
    ) -> Result<Response<MemoryGetIndexResponse>, TonicStatus> {
        let content = self.manager.get_index(None).await.unwrap_or_default();
        Ok(Response::new(MemoryGetIndexResponse { content }))
    }

    async fn read_file(
        &self,
        req: Request<MemoryReadFileRequest>,
    ) -> Result<Response<MemoryReadFileResponse>, TonicStatus> {
        let name = req.into_inner().name;
        match self.manager.read(None, &name).await {
            Ok(entry) => Ok(Response::new(MemoryReadFileResponse {
                raw_json: to_raw_json(&entry),
            })),
            Err(e) => Err(TonicStatus::not_found(e)),
        }
    }

    async fn list_files(
        &self,
        _req: Request<MemoryListFilesRequest>,
    ) -> Result<Response<MemoryListFilesResponse>, TonicStatus> {
        let entries = self.manager.list(None).await.unwrap_or_default();
        Ok(Response::new(MemoryListFilesResponse {
            raw_json: to_raw_json(&entries),
        }))
    }

    async fn save_file(
        &self,
        req: Request<MemorySaveFileRequest>,
    ) -> Result<Response<MemorySaveFileResponse>, TonicStatus> {
        let args = req.into_inner();
        let entry = MemoryEntry {
            category: args.category,
            name: args.name,
            description: args.description,
            content: args.content,
        };
        self.manager
            .save(None, &entry)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(MemorySaveFileResponse {}))
    }

    async fn delete_file(
        &self,
        req: Request<MemoryDeleteFileRequest>,
    ) -> Result<Response<MemoryDeleteFileResponse>, TonicStatus> {
        let name = req.into_inner().name;
        self.manager
            .delete(None, &name)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(MemoryDeleteFileResponse {}))
    }
}

// Tests 이관 — `infra/tests/svc_memory_file_test.rs` (integration test).

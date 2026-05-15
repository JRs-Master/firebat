//! gRPC MemoryService impl — Claude memory file system (옛 TS 설정).
//!
//! 위치: `<workspace>/data/memory/` 디렉토리. MEMORY.md 가 index, 그 외 *.md 가 individual entries.
//! 사용자 / feedback / project / reference 4 type 메모리.
//!
//! Phase B-17.5c minimum: 5 RPC (GetIndex / ReadFile / ListFiles / SaveFile / DeleteFile).
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기.
//! 2026-05-15 unique RPC message — Empty/StringRequest/RawJsonPb shared 폐기 + RPC 별 명시 message.
//! ReadFile / ListFiles 응답은 동적 schema → raw JSON 유지. GetIndex 는 단순 content string.

use std::path::PathBuf;
use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IStoragePort;
use crate::proto::{
    memory_service_server::MemoryService, MemoryDeleteFileRequest, MemoryDeleteFileResponse,
    MemoryGetIndexRequest, MemoryGetIndexResponse, MemoryListFilesRequest,
    MemoryListFilesResponse, MemoryReadFileRequest, MemoryReadFileResponse, MemorySaveFileRequest,
    MemorySaveFileResponse,
};

pub struct MemoryServiceImpl {
    storage: Arc<dyn IStoragePort>,
    /// memory 디렉토리 (workspace 상대 경로) — default `data/memory`
    memory_dir: PathBuf,
}

impl MemoryServiceImpl {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self {
            storage,
            memory_dir: PathBuf::from("data/memory"),
        }
    }

    fn resolve_path(&self, name: &str) -> Result<String, String> {
        // path traversal 방어 — `..` / 절대경로 차단
        if name.contains("..") || name.starts_with('/') || name.starts_with('\\') {
            return Err(format!("invalid memory file name: {name}"));
        }
        // .md 확장자 자동 추가
        let normalized = if name.ends_with(".md") {
            name.to_string()
        } else {
            format!("{name}.md")
        };
        Ok(self.memory_dir.join(normalized).to_string_lossy().to_string())
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
        // MEMORY.md — 인덱스 파일. 없으면 빈 string.
        let path = self.memory_dir.join("MEMORY.md").to_string_lossy().to_string();
        match self.storage.read(&path).await {
            Ok(content) => Ok(Response::new(MemoryGetIndexResponse { content })),
            Err(_) => Ok(Response::new(MemoryGetIndexResponse {
                content: String::new(),
            })),
        }
    }

    async fn read_file(
        &self,
        req: Request<MemoryReadFileRequest>,
    ) -> Result<Response<MemoryReadFileResponse>, TonicStatus> {
        let name = req.into_inner().name;
        let path = self
            .resolve_path(&name)
            .map_err(TonicStatus::invalid_argument)?;
        match self.storage.read(&path).await {
            Ok(content) => Ok(Response::new(MemoryReadFileResponse {
                raw_json: to_raw_json(&serde_json::json!({"name": name, "content": content})),
            })),
            Err(e) => Err(TonicStatus::not_found(e)),
        }
    }

    async fn list_files(
        &self,
        _req: Request<MemoryListFilesRequest>,
    ) -> Result<Response<MemoryListFilesResponse>, TonicStatus> {
        let dir = self.memory_dir.to_string_lossy().to_string();
        let entries = self
            .storage
            .list_dir(&dir)
            .await
            .unwrap_or_default();
        // *.md 만 필터, MEMORY.md 제외 (인덱스는 별도)
        let files: Vec<String> = entries
            .into_iter()
            .filter(|e| !e.is_directory && e.name.ends_with(".md") && e.name != "MEMORY.md")
            .map(|e| e.name)
            .collect();
        Ok(Response::new(MemoryListFilesResponse {
            raw_json: to_raw_json(&files),
        }))
    }

    async fn save_file(
        &self,
        req: Request<MemorySaveFileRequest>,
    ) -> Result<Response<MemorySaveFileResponse>, TonicStatus> {
        let args = req.into_inner();
        let path = self
            .resolve_path(&args.name)
            .map_err(TonicStatus::invalid_argument)?;
        self.storage
            .write(&path, &args.content)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(MemorySaveFileResponse {}))
    }

    async fn delete_file(
        &self,
        req: Request<MemoryDeleteFileRequest>,
    ) -> Result<Response<MemoryDeleteFileResponse>, TonicStatus> {
        let name = req.into_inner().name;
        let path = self
            .resolve_path(&name)
            .map_err(TonicStatus::invalid_argument)?;
        self.storage
            .delete(&path)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(MemoryDeleteFileResponse {}))
    }
}

// Tests 이관 — `infra/tests/svc_memory_file_test.rs` (integration test).

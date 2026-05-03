//! gRPC MemoryService impl — Claude memory file system (옛 TS 박힘).
//!
//! 위치: `<workspace>/data/memory/` 디렉토리. MEMORY.md 가 index, 그 외 *.md 가 individual entries.
//! 사용자 / feedback / project / reference 4 type 메모리.
//!
//! Phase B-17.5c minimum: 5 RPC (GetIndex / ReadFile / ListFiles / SaveFile / DeleteFile).

use std::path::PathBuf;
use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IStoragePort;
use crate::proto::{
    memory_service_server::MemoryService, Empty, JsonArgs, JsonValue, Status, StringRequest,
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
impl MemoryService for MemoryServiceImpl {
    async fn get_index(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<StringRequest>, TonicStatus> {
        // MEMORY.md — 인덱스 파일. 없으면 빈 string.
        let path = self.memory_dir.join("MEMORY.md").to_string_lossy().to_string();
        match self.storage.read(&path).await {
            Ok(content) => Ok(Response::new(StringRequest { value: content })),
            Err(_) => Ok(Response::new(StringRequest {
                value: String::new(),
            })),
        }
    }

    async fn read_file(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let name = req.into_inner().value;
        let path = self
            .resolve_path(&name)
            .map_err(|e| TonicStatus::invalid_argument(e))?;
        match self.storage.read(&path).await {
            Ok(content) => json_response(&serde_json::json!({"name": name, "content": content})),
            Err(e) => Err(TonicStatus::not_found(e)),
        }
    }

    async fn list_files(
        &self,
        _req: Request<Empty>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
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
        json_response(&files)
    }

    async fn save_file(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            name: String,
            content: String,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("save_file args: {e}"))),
        };
        let path = match self.resolve_path(&args.name) {
            Ok(p) => p,
            Err(e) => return Ok(err_status(e)),
        };
        match self.storage.write(&path, &args.content).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete_file(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let name = req.into_inner().value;
        let path = match self.resolve_path(&name) {
            Ok(p) => p,
            Err(e) => return Ok(err_status(e)),
        };
        match self.storage.delete(&path).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::storage::LocalStorageAdapter;
    use tempfile::tempdir;

    fn service() -> (MemoryServiceImpl, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
        (MemoryServiceImpl::new(storage), dir)
    }

    #[tokio::test]
    async fn save_then_read_roundtrip() {
        let (svc, _dir) = service();
        let body = serde_json::json!({"name": "user_role", "content": "developer"});
        svc.save_file(Request::new(JsonArgs {
            raw: body.to_string(),
        }))
        .await
        .unwrap();

        let resp = svc
            .read_file(Request::new(StringRequest {
                value: "user_role".to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(parsed["content"], "developer");
    }

    #[tokio::test]
    async fn path_traversal_rejected() {
        let (svc, _dir) = service();
        let resp = svc
            .read_file(Request::new(StringRequest {
                value: "../../../etc/passwd".to_string(),
            }))
            .await;
        assert!(resp.is_err());
    }

    #[tokio::test]
    async fn list_excludes_memory_md_and_non_md() {
        let (svc, dir) = service();
        // memory dir 박음
        let mem_dir = dir.path().join("data/memory");
        std::fs::create_dir_all(&mem_dir).unwrap();
        std::fs::write(mem_dir.join("MEMORY.md"), "index").unwrap();
        std::fs::write(mem_dir.join("user_role.md"), "x").unwrap();
        std::fs::write(mem_dir.join("feedback.md"), "y").unwrap();
        std::fs::write(mem_dir.join("readme.txt"), "z").unwrap(); // 비-md 제외

        let resp = svc.list_files(Request::new(Empty {})).await.unwrap();
        let arr: Vec<String> = serde_json::from_str(&resp.into_inner().raw).unwrap();
        assert_eq!(arr.len(), 2);
        assert!(arr.contains(&"user_role.md".to_string()));
        assert!(arr.contains(&"feedback.md".to_string()));
        assert!(!arr.contains(&"MEMORY.md".to_string()));
    }

    #[tokio::test]
    async fn get_index_returns_empty_when_missing() {
        let (svc, _dir) = service();
        let resp = svc.get_index(Request::new(Empty {})).await.unwrap();
        assert_eq!(resp.into_inner().value, "");
    }
}

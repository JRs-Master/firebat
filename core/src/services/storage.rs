//! gRPC StorageService impl — IStoragePort thin wrapper.
//!
//! Phase B-17.5 minimum: ReadFile / WriteFile / DeleteFile / ListDir / ListFiles 활성.
//! Phase B-17+ 후속: ReadFileBinary (base64) / GetFileTree (재귀 트리) / GlobFiles (glob crate)
//!
//! Step 3 (typed RPC) — JsonValue raw 폐기 + RawJsonPb 사용.
//! ReadFile / ReadFileBinary / ListDir / ListFiles / GetFileTree / GlobFiles → RawJsonPb.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::storage::StorageManager;
use crate::ports::IStoragePort;
use crate::proto::{
    storage_service_server::StorageService, RawJsonPb, Status, StorageGlobFilesRequest,
    StorageWriteFileRequest, StringRequest,
};

pub struct StorageServiceImpl {
    storage: Arc<dyn IStoragePort>,
    /// BIBLE 준수: gRPC service 가 storage adapter 를 직접 호출하지 않고 매니저 경유.
    /// 옛 TS Core facade → StorageManager 동등.
    manager: Arc<StorageManager>,
}

impl StorageServiceImpl {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        let manager = Arc::new(StorageManager::new(storage.clone()));
        Self { storage, manager }
    }
}

fn raw_json(value: &impl serde::Serialize) -> RawJsonPb {
    RawJsonPb {
        raw_json: serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
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

#[tonic::async_trait]
impl StorageService for StorageServiceImpl {
    async fn read_file(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let path = req.into_inner().value;
        match self.storage.read(&path).await {
            Ok(content) => Ok(Response::new(raw_json(&serde_json::json!({"path": path, "content": content})))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn read_file_binary(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        // 옛 TS Core.readFileBinary → StorageManager.read_binary (BIBLE Core Facade 준수).
        let path = req.into_inner().value;
        match self.manager.read_binary(&path).await {
            Ok(result) => Ok(Response::new(raw_json(&result))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn write_file(
        &self,
        req: Request<StorageWriteFileRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let args = req.into_inner();
        match self.storage.write(&args.path, &args.content).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn delete_file(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<Status>, TonicStatus> {
        let path = req.into_inner().value;
        match self.storage.delete(&path).await {
            Ok(()) => Ok(ok_status()),
            Err(e) => Ok(err_status(e)),
        }
    }

    async fn list_dir(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let path = req.into_inner().value;
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let json: Vec<serde_json::Value> = entries
                    .into_iter()
                    .map(|e| {
                        serde_json::json!({"name": e.name, "isDirectory": e.is_directory})
                    })
                    .collect();
                Ok(Response::new(raw_json(&json)))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_files(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        // 디렉토리 안 파일만 (디렉토리 제외) 필터.
        let path = req.into_inner().value;
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let files: Vec<String> = entries
                    .into_iter()
                    .filter(|e| !e.is_directory)
                    .map(|e| e.name)
                    .collect();
                Ok(Response::new(raw_json(&files)))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_file_tree(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        // 옛 TS Core.getFileTree → StorageManager.getFileTree 등가 (BIBLE Core Facade 준수).
        // root path 받아 재귀 트리 빌드. 빈 string 일 때 default ".".
        let raw_root = req.into_inner().value;
        let root = if raw_root.is_empty() { ".".to_string() } else { raw_root };
        let tree = self.manager.get_file_tree(&root).await;
        Ok(Response::new(raw_json(&tree)))
    }

    async fn glob_files(
        &self,
        req: Request<StorageGlobFilesRequest>,
    ) -> Result<Response<RawJsonPb>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .glob(&args.pattern, args.limit.map(|v| v as usize))
            .await
        {
            Ok(matches) => Ok(Response::new(raw_json(&matches))),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_storage_test.rs` (integration test).

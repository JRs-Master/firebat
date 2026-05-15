//! gRPC StorageService impl — IStoragePort thin wrapper.
//!
//! 매 RPC unique Request / Response — buf STANDARD 정공.
//! 옛 공유 타입 (StringRequest / Empty / RawJsonPb) 폐기.

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::storage::StorageManager;
use crate::ports::IStoragePort;
use crate::proto::{
    storage_service_server::StorageService, StorageDeleteFileRequest, StorageDeleteFileResponse,
    StorageGetFileTreeRequest, StorageGetFileTreeResponse, StorageGlobFilesRequest,
    StorageGlobFilesResponse, StorageListDirRequest, StorageListDirResponse,
    StorageListFilesRequest, StorageListFilesResponse, StorageReadFileBinaryRequest,
    StorageReadFileBinaryResponse, StorageReadFileRequest, StorageReadFileResponse,
    StorageWriteFileRequest, StorageWriteFileResponse,
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

fn to_raw(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[tonic::async_trait]
impl StorageService for StorageServiceImpl {
    async fn read_file(
        &self,
        req: Request<StorageReadFileRequest>,
    ) -> Result<Response<StorageReadFileResponse>, TonicStatus> {
        let path = req.into_inner().path;
        match self.storage.read(&path).await {
            Ok(content) => Ok(Response::new(StorageReadFileResponse {
                raw_json: to_raw(&serde_json::json!({"path": path, "content": content})),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn read_file_binary(
        &self,
        req: Request<StorageReadFileBinaryRequest>,
    ) -> Result<Response<StorageReadFileBinaryResponse>, TonicStatus> {
        // 옛 TS Core.readFileBinary → StorageManager.read_binary (BIBLE Core Facade 준수).
        let path = req.into_inner().path;
        match self.manager.read_binary(&path).await {
            Ok(result) => Ok(Response::new(StorageReadFileBinaryResponse {
                raw_json: to_raw(&result),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn write_file(
        &self,
        req: Request<StorageWriteFileRequest>,
    ) -> Result<Response<StorageWriteFileResponse>, TonicStatus> {
        let args = req.into_inner();
        self.storage
            .write(&args.path, &args.content)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(StorageWriteFileResponse {}))
    }

    async fn delete_file(
        &self,
        req: Request<StorageDeleteFileRequest>,
    ) -> Result<Response<StorageDeleteFileResponse>, TonicStatus> {
        let path = req.into_inner().path;
        self.storage.delete(&path).await.map_err(TonicStatus::internal)?;
        Ok(Response::new(StorageDeleteFileResponse {}))
    }

    async fn list_dir(
        &self,
        req: Request<StorageListDirRequest>,
    ) -> Result<Response<StorageListDirResponse>, TonicStatus> {
        let path = req.into_inner().path;
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let json: Vec<serde_json::Value> = entries
                    .into_iter()
                    .map(|e| serde_json::json!({"name": e.name, "isDirectory": e.is_directory}))
                    .collect();
                Ok(Response::new(StorageListDirResponse {
                    raw_json: to_raw(&json),
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_files(
        &self,
        req: Request<StorageListFilesRequest>,
    ) -> Result<Response<StorageListFilesResponse>, TonicStatus> {
        // 디렉토리 안 파일만 (디렉토리 제외) 필터.
        let path = req.into_inner().path;
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let files: Vec<String> = entries
                    .into_iter()
                    .filter(|e| !e.is_directory)
                    .map(|e| e.name)
                    .collect();
                Ok(Response::new(StorageListFilesResponse {
                    raw_json: to_raw(&files),
                }))
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_file_tree(
        &self,
        req: Request<StorageGetFileTreeRequest>,
    ) -> Result<Response<StorageGetFileTreeResponse>, TonicStatus> {
        // 옛 TS Core.getFileTree → StorageManager.getFileTree 등가 (BIBLE Core Facade 준수).
        // root path 받아 재귀 트리 빌드. 빈 string 일 때 default ".".
        let raw_root = req.into_inner().path;
        let root = if raw_root.is_empty() {
            ".".to_string()
        } else {
            raw_root
        };
        let tree = self.manager.get_file_tree(&root).await;
        Ok(Response::new(StorageGetFileTreeResponse {
            raw_json: to_raw(&tree),
        }))
    }

    async fn glob_files(
        &self,
        req: Request<StorageGlobFilesRequest>,
    ) -> Result<Response<StorageGlobFilesResponse>, TonicStatus> {
        let args = req.into_inner();
        match self
            .manager
            .glob(&args.pattern, args.limit.map(|v| v as usize))
            .await
        {
            Ok(matches) => Ok(Response::new(StorageGlobFilesResponse {
                raw_json: to_raw(&matches),
            })),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_storage_test.rs` (integration test).

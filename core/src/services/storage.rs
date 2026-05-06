//! gRPC StorageService impl — IStoragePort thin wrapper.
//!
//! Phase B-17.5 minimum: ReadFile / WriteFile / DeleteFile / ListDir / ListFiles 활성.
//! Phase B-17+ 후속: ReadFileBinary (base64) / GetFileTree (재귀 트리) / GlobFiles (glob crate)

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::managers::storage::StorageManager;
use crate::ports::IStoragePort;
use crate::proto::{
    storage_service_server::StorageService, JsonArgs, JsonValue, Status, StringRequest,
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
impl StorageService for StorageServiceImpl {
    async fn read_file(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let path = req.into_inner().value;
        match self.storage.read(&path).await {
            Ok(content) => json_response(&serde_json::json!({"path": path, "content": content})),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn read_file_binary(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS Core.readFileBinary → StorageManager.read_binary (BIBLE Core Facade 준수).
        let path = req.into_inner().value;
        match self.manager.read_binary(&path).await {
            Ok(result) => json_response(&result),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn write_file(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<Status>, TonicStatus> {
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            path: String,
            content: String,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Ok(err_status(format!("write_file args: {e}"))),
        };
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
    ) -> Result<Response<JsonValue>, TonicStatus> {
        let path = req.into_inner().value;
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let json: Vec<serde_json::Value> = entries
                    .into_iter()
                    .map(|e| {
                        serde_json::json!({"name": e.name, "isDirectory": e.is_directory})
                    })
                    .collect();
                json_response(&json)
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn list_files(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 디렉토리 안 파일만 (디렉토리 제외) 필터.
        let path = req.into_inner().value;
        match self.storage.list_dir(&path).await {
            Ok(entries) => {
                let files: Vec<String> = entries
                    .into_iter()
                    .filter(|e| !e.is_directory)
                    .map(|e| e.name)
                    .collect();
                json_response(&files)
            }
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    async fn get_file_tree(
        &self,
        req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS Core.getFileTree → StorageManager.getFileTree 등가 (BIBLE Core Facade 준수).
        // root path 받아 재귀 트리 빌드. 빈 string 일 때 default ".".
        let raw_root = req.into_inner().value;
        let root = if raw_root.is_empty() { ".".to_string() } else { raw_root };
        let tree = self.manager.get_file_tree(&root).await;
        json_response(&tree)
    }

    async fn glob_files(
        &self,
        req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // 옛 TS Core.globFiles → StorageManager.glob 등가 (BIBLE Core Facade 준수).
        // 인자: { pattern: string, limit?: number }
        let raw = req.into_inner().raw;
        #[derive(serde::Deserialize)]
        struct Args {
            pattern: String,
            #[serde(default)]
            limit: Option<usize>,
        }
        let args: Args = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => return Err(TonicStatus::invalid_argument(format!("glob args: {e}"))),
        };
        match self.manager.glob(&args.pattern, args.limit).await {
            Ok(matches) => json_response(&matches),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }
}

// Tests 이관 — `infra/tests/svc_storage_test.rs` (integration test).

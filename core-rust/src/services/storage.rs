//! gRPC StorageService impl — IStoragePort thin wrapper.
//!
//! Phase B-17.5 minimum: ReadFile / WriteFile / DeleteFile / ListDir / ListFiles 활성.
//! Phase B-17+ 후속: ReadFileBinary (base64) / GetFileTree (재귀 트리) / GlobFiles (glob crate)

use std::sync::Arc;
use tonic::{Request, Response, Status as TonicStatus};

use crate::ports::IStoragePort;
use crate::proto::{
    storage_service_server::StorageService, JsonArgs, JsonValue, Status, StringRequest,
};

pub struct StorageServiceImpl {
    storage: Arc<dyn IStoragePort>,
}

impl StorageServiceImpl {
    pub fn new(storage: Arc<dyn IStoragePort>) -> Self {
        Self { storage }
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
        _req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-17+ — base64 인코딩된 binary read. 현재는 stub.
        json_response(&serde_json::json!({"_phase": "B-17+ stub — base64 binary read"}))
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
        _req: Request<StringRequest>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-17+ — 재귀 트리. 현재는 stub.
        json_response(&serde_json::json!({"_phase": "B-17+ stub — recursive tree"}))
    }

    async fn glob_files(
        &self,
        _req: Request<JsonArgs>,
    ) -> Result<Response<JsonValue>, TonicStatus> {
        // Phase B-17+ — glob crate 박힌 후 활성.
        json_response(&serde_json::json!({"_phase": "B-17+ stub — glob 패턴 매칭"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::storage::LocalStorageAdapter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn write_then_read_via_grpc() {
        let dir = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
        let svc = StorageServiceImpl::new(storage);

        let body = serde_json::json!({"path": "test.txt", "content": "hi"});
        let resp = svc
            .write_file(Request::new(JsonArgs {
                raw: body.to_string(),
            }))
            .await
            .unwrap();
        assert!(resp.into_inner().ok);

        let read = svc
            .read_file(Request::new(StringRequest {
                value: "test.txt".to_string(),
            }))
            .await
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&read.into_inner().raw).unwrap();
        assert_eq!(parsed["content"], "hi");
    }
}

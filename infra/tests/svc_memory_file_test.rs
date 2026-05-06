//! MemoryService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::ports::IStoragePort;
use firebat_core::proto::{memory_service_server::MemoryService, Empty, JsonArgs, StringRequest};
use firebat_core::services::memory_file::MemoryServiceImpl;
use firebat_infra::adapters::storage::LocalStorageAdapter;

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

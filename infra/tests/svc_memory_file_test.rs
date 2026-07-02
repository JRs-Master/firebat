//! MemoryService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::grpc::memory_file::MemoryServiceImpl;
use firebat_core::managers::memory_file::MemoryFileManager;
use firebat_core::ports::IStoragePort;
use firebat_core::proto::{
    memory_service_server::MemoryService, MemoryGetIndexRequest, MemoryListFilesRequest,
    MemoryReadFileRequest, MemorySaveFileRequest,
};
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn service() -> (MemoryServiceImpl, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let manager = Arc::new(MemoryFileManager::new(storage));
    (MemoryServiceImpl::new(manager), dir)
}

#[tokio::test]
async fn save_then_read_roundtrip() {
    let (svc, _dir) = service();
    svc.save_file(Request::new(MemorySaveFileRequest {
        name: "user_role".to_string(),
        content: "developer".to_string(),
        category: "user".to_string(),
        description: "role".to_string(),
        owner: None,
    }))
    .await
    .unwrap();

    let resp = svc
        .read_file(Request::new(MemoryReadFileRequest {
            name: "user_role".to_string(),
            owner: None,
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(parsed["content"], "developer");
    assert_eq!(parsed["category"], "user");
    assert_eq!(parsed["description"], "role");
}

#[tokio::test]
async fn path_traversal_rejected() {
    let (svc, _dir) = service();
    let resp = svc
        .read_file(Request::new(MemoryReadFileRequest {
            name: "../../../etc/passwd".to_string(),
            owner: None,
        }))
        .await;
    assert!(resp.is_err());
}

#[tokio::test]
async fn list_excludes_memory_md_and_non_md() {
    let (svc, dir) = service();
    // memory dir 저장 (frontmatter 없는 레거시 파일 — 본문-only 파싱)
    let mem_dir = dir.path().join("data/memory");
    std::fs::create_dir_all(&mem_dir).unwrap();
    std::fs::write(mem_dir.join("MEMORY.md"), "index").unwrap();
    std::fs::write(mem_dir.join("user_role.md"), "x").unwrap();
    std::fs::write(mem_dir.join("feedback.md"), "y").unwrap();
    std::fs::write(mem_dir.join("readme.txt"), "z").unwrap(); // 비-md 제외

    let resp = svc
        .list_files(Request::new(MemoryListFilesRequest { owner: None }))
        .await
        .unwrap();
    let arr: Vec<serde_json::Value> = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert_eq!(arr.len(), 2);
    let names: Vec<&str> = arr.iter().filter_map(|e| e["name"].as_str()).collect();
    assert!(names.contains(&"user_role"));
    assert!(names.contains(&"feedback"));
    assert!(!names.contains(&"MEMORY"));
}

#[tokio::test]
async fn get_index_returns_empty_when_missing() {
    let (svc, _dir) = service();
    let resp = svc
        .get_index(Request::new(MemoryGetIndexRequest {}))
        .await
        .unwrap();
    assert_eq!(resp.into_inner().content, "");
}

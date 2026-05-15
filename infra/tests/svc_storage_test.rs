//! StorageService gRPC integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::ports::IStoragePort;
use firebat_core::proto::{
    storage_service_server::StorageService, StorageGetFileTreeRequest, StorageReadFileRequest,
    StorageWriteFileRequest,
};
use firebat_core::services::storage::StorageServiceImpl;
use firebat_infra::adapters::storage::LocalStorageAdapter;

#[tokio::test]
async fn write_then_read_via_grpc() {
    let dir = tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let svc = StorageServiceImpl::new(storage);

    svc.write_file(Request::new(StorageWriteFileRequest {
        path: "test.txt".to_string(),
        content: "hi".to_string(),
    }))
    .await
    .unwrap();

    let read = svc
        .read_file(Request::new(StorageReadFileRequest {
            path: "test.txt".to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&read.into_inner().raw_json).unwrap();
    assert_eq!(parsed["content"], "hi");
}

#[tokio::test]
async fn get_file_tree_returns_recursive_structure() {
    let dir = tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let svc = StorageServiceImpl::new(storage);

    // setup: root/sub/file.txt
    svc.write_file(Request::new(StorageWriteFileRequest {
        path: "root/sub/file.txt".to_string(),
        content: "x".to_string(),
    }))
    .await
    .unwrap();

    let resp = svc
        .get_file_tree(Request::new(StorageGetFileTreeRequest {
            path: "root".to_string(),
        }))
        .await
        .unwrap();
    let tree: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    // 옛 TS get_file_tree 결과 형식: [{name, path, isDirectory, children}]
    assert_eq!(tree[0]["name"], "root");
    assert_eq!(tree[0]["isDirectory"], true);
    assert_eq!(tree[0]["children"][0]["name"], "sub");
    assert_eq!(tree[0]["children"][0]["children"][0]["name"], "file.txt");
}

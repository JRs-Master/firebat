//! DatabaseService gRPC integration test — 옛 core inline tests 이관.

use tempfile::tempdir;
use tonic::Request;

use firebat_core::proto::{database_service_server::DatabaseService, JsonArgs};
use firebat_core::services::database::DatabaseServiceImpl;
use firebat_infra::adapters::database::SqliteDatabaseAdapter;

#[tokio::test]
async fn select_returns_rows() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    // schema 초기화
    let _ = SqliteDatabaseAdapter::new(&db_path).unwrap();

    let svc = DatabaseServiceImpl::new(db_path).unwrap();
    let resp = svc
        .query(Request::new(JsonArgs {
            raw: serde_json::json!({"sql": "SELECT COUNT(*) AS cnt FROM pages"}).to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw).unwrap();
    assert!(parsed.is_array());
    assert_eq!(parsed[0]["cnt"], 0);
}

#[tokio::test]
async fn insert_rejected() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let _ = SqliteDatabaseAdapter::new(&db_path).unwrap();

    let svc = DatabaseServiceImpl::new(db_path).unwrap();
    let resp = svc
        .query(Request::new(JsonArgs {
            raw: serde_json::json!({"sql": "INSERT INTO pages (slug) VALUES ('x')"}).to_string(),
        }))
        .await;
    assert!(resp.is_err());
}

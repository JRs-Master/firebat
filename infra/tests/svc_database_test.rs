//! DatabaseService gRPC integration test — Phase B-4 audit cleanup #4 (2026-05-06).
//!
//! 옛 raw rusqlite Connection 직접 의존 → IDatabasePort.run_select_query 위임으로 변경.
//! Service 가 Arc<dyn IDatabasePort> 받음.

use std::sync::Arc;
use tempfile::tempdir;
use tonic::Request;

use firebat_core::ports::IDatabasePort;
use firebat_core::proto::{database_service_server::DatabaseService, DatabaseQueryRequest};
use firebat_core::grpc::database::DatabaseServiceImpl;
use firebat_infra::adapters::database::SqliteDatabaseAdapter;

fn make_svc() -> (DatabaseServiceImpl, tempfile::TempDir) {
    let dir = tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("test.db")).unwrap());
    (DatabaseServiceImpl::new(db), dir)
}

#[tokio::test]
async fn select_returns_rows() {
    let (svc, _dir) = make_svc();
    let resp = svc
        .query(Request::new(DatabaseQueryRequest {
            sql: "SELECT COUNT(*) AS cnt FROM pages".to_string(),
            params_json: "[]".to_string(),
        }))
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&resp.into_inner().raw_json).unwrap();
    assert!(parsed.is_array());
    assert_eq!(parsed[0]["cnt"], 0);
}

#[tokio::test]
async fn insert_rejected() {
    let (svc, _dir) = make_svc();
    let resp = svc
        .query(Request::new(DatabaseQueryRequest {
            sql: "INSERT INTO pages (slug) VALUES ('x')".to_string(),
            params_json: "[]".to_string(),
        }))
        .await;
    assert!(resp.is_err());
}

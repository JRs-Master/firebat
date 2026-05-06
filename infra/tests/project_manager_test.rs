//! ProjectManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::project::{ProjectManager, ProjectVisibility};
use firebat_core::ports::{IDatabasePort, IStoragePort, IVaultPort};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_manager() -> (ProjectManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (ProjectManager::new(storage, db, vault), dir)
}

#[tokio::test]
async fn scan_collects_modules_and_pages() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    // 모듈 1개 (project=stock-blog)
    storage
        .write(
            "user/modules/scraper/config.json",
            r#"{"name":"scraper","project":"stock-blog"}"#,
        )
        .await
        .unwrap();
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    // pages 2개 (같은 project)
    db.save_page("p1", r#"{"head":{},"body":[]}"#, "published", Some("stock-blog"), None, None);
    db.save_page("p2", r#"{"head":{},"body":[]}"#, "published", Some("stock-blog"), None, None);
    // 다른 project
    db.save_page("o1", r#"{"head":{},"body":[]}"#, "published", Some("other"), None, None);

    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let mgr = ProjectManager::new(storage_arc, db, vault);

    let projects = mgr.scan().await;
    assert_eq!(projects.len(), 2);
    let stock = projects.iter().find(|p| p.name == "stock-blog").unwrap();
    assert_eq!(stock.paths.len(), 1);
    assert_eq!(stock.page_slugs.len(), 2);
}

#[tokio::test]
async fn visibility_and_password() {
    let (mgr, _dir) = make_manager();

    assert_eq!(mgr.get_visibility("stock"), ProjectVisibility::Public);

    mgr.set_visibility("stock", ProjectVisibility::Password, Some("secret"));
    assert_eq!(mgr.get_visibility("stock"), ProjectVisibility::Password);
    assert!(mgr.verify_password("stock", "secret"));
    assert!(!mgr.verify_password("stock", "wrong"));

    mgr.set_visibility("stock", ProjectVisibility::Private, None);
    assert_eq!(mgr.get_visibility("stock"), ProjectVisibility::Private);
    // password 자동 삭제됨
    assert!(!mgr.verify_password("stock", "secret"));
}

#[tokio::test]
async fn config_roundtrip() {
    let (mgr, _dir) = make_manager();

    let cfg = serde_json::json!({"theme": {"primary": "#ff0000"}});
    mgr.set_config("stock", &cfg).await.unwrap();
    let got = mgr.get_config("stock").await.unwrap();
    assert_eq!(got["theme"]["primary"], "#ff0000");
}

#[tokio::test]
async fn unsafe_name_rejected() {
    let (mgr, _dir) = make_manager();
    assert!(mgr.set_config("../etc", &serde_json::json!({})).await.is_err());
    assert!(mgr.delete("../etc").await.is_err());
}

//! PageManager integration test — 옛 core inline tests 이관.
//!
//! `extract_media_slugs` 는 private fn 이라 inline 유지 (page.rs 내 별도 mod tests).

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::page::PageManager;
use firebat_core::ports::{IDatabasePort, IStoragePort};
use firebat_infra::adapters::database::SqliteDatabaseAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn make_manager() -> (PageManager, Arc<dyn IDatabasePort>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let db: Arc<dyn IDatabasePort> =
        Arc::new(SqliteDatabaseAdapter::new(dir.path().join("app.db")).unwrap());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    (PageManager::new(db.clone(), storage), db, dir)
}

fn sample_spec(title: &str) -> String {
    serde_json::json!({
        "head": {"title": title},
        "body": [{"type": "Text", "props": {"content": "hello"}}]
    })
    .to_string()
}

#[test]
fn save_get_list_delete() {
    let (mgr, _db, _dir) = make_manager();
    mgr.save("p1", &sample_spec("v1"), "published", Some("blog"), None, None)
        .unwrap();
    let got = mgr.get("p1").unwrap();
    assert_eq!(got.project.as_deref(), Some("blog"));
    assert_eq!(mgr.list().len(), 1);

    mgr.delete("p1", None).unwrap();
    assert!(mgr.get("p1").is_none());
}

#[test]
fn hub_scope_guards_delete_and_overwrite() {
    // Regression for the hub cross-tenant page leak — a hub visitor (project = "hub:...") must not
    // overwrite or delete a page owned by a different scope (admin or another hub).
    let (mgr, _db, _dir) = make_manager();
    mgr.save("news", &sample_spec("admin"), "published", Some("blog"), None, None)
        .unwrap();
    mgr.save("my-app", &sample_spec("hub"), "published", Some("hub:inst-A"), None, None)
        .unwrap();

    // hub scope cannot hijack the admin page (overwrite) nor delete it
    assert!(mgr
        .save("news", &sample_spec("evil"), "published", Some("hub:inst-A"), None, None)
        .is_err());
    assert!(mgr.delete("news", Some("hub:inst-A")).is_err());
    assert_eq!(mgr.get("news").unwrap().project.as_deref(), Some("blog")); // intact

    // hub scope CAN overwrite + delete its own page
    mgr.save("my-app", &sample_spec("v2"), "published", Some("hub:inst-A"), None, None)
        .unwrap();
    mgr.delete("my-app", Some("hub:inst-A")).unwrap();
    assert!(mgr.get("my-app").is_none());

    // admin (no project scope) is unrestricted
    mgr.delete("news", None).unwrap();
    assert!(mgr.get("news").is_none());
}

#[test]
fn save_indexes_media_usage() {
    let (mgr, db, _dir) = make_manager();
    let spec = r#"{"head":{},"body":[{"type":"Image","props":{"src":"/user/media/foo.png"}}]}"#;
    mgr.save("page-a", spec, "published", None, None, None).unwrap();

    let usage = db.find_media_usage("foo");
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].page_slug, "page-a");

    // 다른 페이지에서도 같은 미디어 사용 — 두 entry
    mgr.save("page-b", spec, "published", None, None, None).unwrap();
    let usage = db.find_media_usage("foo");
    assert_eq!(usage.len(), 2);

    // page-a 의 spec 변경 (foo 안 씀) — usage 동기 갱신
    mgr.save("page-a", r#"{"body":[]}"#, "published", None, None, None)
        .unwrap();
    let usage = db.find_media_usage("foo");
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].page_slug, "page-b");
}

#[test]
fn rename_with_redirect() {
    let (mgr, _db, _dir) = make_manager();
    mgr.save("blog/old", &sample_spec("v1"), "published", Some("blog"), None, None)
        .unwrap();

    let result = mgr.rename("blog/old", "blog/new", true).unwrap();
    assert_eq!(result.new_slug, "blog/new");
    assert!(mgr.get("blog/old").is_none());
    assert!(mgr.get("blog/new").is_some());
    assert_eq!(mgr.get_redirect("blog/old").as_deref(), Some("blog/new"));
}

#[test]
fn visibility_password_roundtrip() {
    let (mgr, _db, _dir) = make_manager();
    mgr.save("priv", &sample_spec("v"), "published", None, None, None)
        .unwrap();

    mgr.set_visibility("priv", "password", Some("secret123")).unwrap();
    assert!(mgr.verify_password("priv", "secret123"));
    assert!(!mgr.verify_password("priv", "wrong"));

    mgr.set_visibility("priv", "private", None).unwrap();
    // password 영역 자동 NULL
    assert!(!mgr.verify_password("priv", "secret123"));
}

#[test]
fn rename_project_renames_all_pages() {
    let (mgr, _db, _dir) = make_manager();
    mgr.save("blog/p1", &sample_spec("a"), "published", Some("blog"), None, None)
        .unwrap();
    mgr.save("blog/p2", &sample_spec("b"), "published", Some("blog"), None, None)
        .unwrap();
    mgr.save("other/x", &sample_spec("c"), "published", Some("other"), None, None)
        .unwrap();

    let renamed = mgr.rename_project("blog", "stock-blog", false).unwrap();
    assert_eq!(renamed.len(), 2);
    assert!(mgr.get("stock-blog/p1").is_some());
    assert!(mgr.get("stock-blog/p2").is_some());
    assert!(mgr.get("other/x").is_some()); // 다른 project 영향 X
}

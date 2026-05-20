//! TemplateManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::template::{
    TemplateBlock, TemplateConfig, TemplateManager, TemplateSpec,
};
use firebat_core::ports::IStoragePort;
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn make_manager() -> (TemplateManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    (TemplateManager::new(storage), dir)
}

fn make_template(name: &str) -> TemplateConfig {
    TemplateConfig {
        name: name.to_string(),
        description: "test template".to_string(),
        tags: vec!["test".to_string()],
        spec: TemplateSpec {
            head: serde_json::json!({}),
            body: vec![TemplateBlock {
                block_type: "Text".to_string(),
                props: serde_json::json!({"content": "hello"}),
            }],
        },
    }
}

#[tokio::test]
async fn save_then_get_then_list_then_delete() {
    let (mgr, _dir) = make_manager();

    // empty list
    assert_eq!(mgr.list(None).await.len(), 0);

    // save
    mgr.save(None, "stock-weekly", &make_template("주간 시황"))
        .await
        .unwrap();

    // get
    let got = mgr.get(None, "stock-weekly").await.unwrap();
    assert_eq!(got.name, "주간 시황");
    assert_eq!(got.spec.body.len(), 1);

    // list
    let list = mgr.list(None).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].slug, "stock-weekly");
    assert_eq!(list[0].name, "주간 시황");

    // delete
    mgr.delete(None, "stock-weekly").await.unwrap();
    assert!(mgr.get(None, "stock-weekly").await.is_none());
    assert_eq!(mgr.list(None).await.len(), 0);
}

#[tokio::test]
async fn unsafe_slug_rejected() {
    let (mgr, _dir) = make_manager();

    assert!(mgr.save(None, "../etc/passwd", &make_template("evil")).await.is_err());
    assert!(mgr.save(None, "foo/bar", &make_template("evil")).await.is_err());
    assert!(mgr.save(None, "foo bar", &make_template("evil")).await.is_err());
    assert!(mgr.save(None, "", &make_template("evil")).await.is_err());

    assert!(mgr.get(None, "../etc/passwd").await.is_none());
    assert!(mgr.delete(None, "../etc/passwd").await.is_err());
}

#[tokio::test]
async fn empty_body_rejected() {
    let (mgr, _dir) = make_manager();

    let mut bad = make_template("empty");
    bad.spec.body.clear();
    assert!(mgr.save(None, "empty", &bad).await.is_err());
}

#[tokio::test]
async fn list_silent_skips_invalid_json() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    // 잘못된 JSON 직접 저장 — list 가 silent skip 해야
    storage
        .write("user/templates/broken/template.json", "{ not valid json")
        .await
        .unwrap();
    // 정상 템플릿도 같이 저장
    let valid_json = serde_json::to_string_pretty(&make_template("valid")).unwrap();
    storage
        .write("user/templates/valid/template.json", &valid_json)
        .await
        .unwrap();

    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let mgr = TemplateManager::new(storage_arc);

    let list = mgr.list(None).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].slug, "valid");
}

#[tokio::test]
async fn hub_owner_isolation() {
    // admin / hub-A / hub-B 가 같은 slug 박아도 독립.
    let (mgr, _dir) = make_manager();
    mgr.save(None, "common", &make_template("admin 본문"))
        .await
        .unwrap();
    mgr.save(Some("inst-A"), "common", &make_template("hub A 본문"))
        .await
        .unwrap();
    mgr.save(Some("inst-B"), "common", &make_template("hub B 본문"))
        .await
        .unwrap();

    // 각 owner 별 1건씩 보이고 다른 owner 자료 0
    assert_eq!(mgr.list(None).await.len(), 1);
    assert_eq!(mgr.list(Some("inst-A")).await.len(), 1);
    assert_eq!(mgr.list(Some("inst-B")).await.len(), 1);

    assert_eq!(mgr.get(None, "common").await.unwrap().name, "admin 본문");
    assert_eq!(mgr.get(Some("inst-A"), "common").await.unwrap().name, "hub A 본문");
    assert_eq!(mgr.get(Some("inst-B"), "common").await.unwrap().name, "hub B 본문");

    // hub A 영역만 삭제 → admin / hub B 영역 보존
    mgr.delete(Some("inst-A"), "common").await.unwrap();
    assert!(mgr.get(Some("inst-A"), "common").await.is_none());
    assert!(mgr.get(None, "common").await.is_some());
    assert!(mgr.get(Some("inst-B"), "common").await.is_some());
}

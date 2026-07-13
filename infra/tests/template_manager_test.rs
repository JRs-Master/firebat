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
    // admin / hub-A / hub-B 가 같은 slug 를 써도 독립.
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

/// widget allowlist — admin 템플릿이 hub 인스턴스의 allowed_templates 에 있을 때만
/// 그 hub 의 list/get 에 read-only 베이스(source="system")로 합류. 미공유 = 불가시(safe-closed).
#[tokio::test]
async fn hub_shared_admin_templates_overlay() {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let mgr = TemplateManager::new(storage);

    // admin 작성 2건 — 하나만 공유
    mgr.save(None, "shared-report", &make_template("공유 리포트")).await.unwrap();
    mgr.save(None, "private-report", &make_template("비공유 리포트")).await.unwrap();

    // memory.db 스키마(SqliteMemoryAdapter initialize) 위에 hub instance 생성
    let db = dir.path().join("memory.db");
    let _schema = firebat_infra::adapters::memory::SqliteMemoryAdapter::new(&db).unwrap();
    let hub: Arc<dyn firebat_core::ports::IHubPort> =
        Arc::new(firebat_infra::adapters::hub::SqliteHubAdapter::new(&db).unwrap());
    let inst = firebat_core::ports::HubInstance {
        id: "inst-share".to_string(),
        slug: "share-test".to_string(),
        name: "share".to_string(),
        description: None,
        system_prompt: None,
        allowed_references: vec![],
        allowed_sysmods: vec![],
        model_id: None,
        enabled: true,
        api_token: "tok".to_string(),
        allowed_domains: vec![],
        created_at: 0,
        updated_at: 0,
        expose_widget: true,
        expose_page: true,
        kind: "widget".to_string(),
        allowed_skills: vec![],
        allowed_templates: vec!["shared-report".to_string()],
    };
    hub.create_instance(&inst).await.unwrap();
    mgr.set_hub_port(hub);

    // hub 세션 owner scope = "<inst>:<sid>"
    let owner = "inst-share:sess1".to_string();
    let list = mgr.list(Some(&owner)).await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].slug, "shared-report");
    assert_eq!(list[0].source, "system"); // read-only 베이스로 합류

    assert!(mgr.get(Some(&owner), "shared-report").await.is_some());
    assert!(mgr.get(Some(&owner), "private-report").await.is_none()); // 미공유 = 불가시

    // hub 가 같은 slug 로 자기 버전 저장 = override (베이스 불변)
    mgr.save(Some(&owner), "shared-report", &make_template("hub 버전")).await.unwrap();
    assert_eq!(mgr.get(Some(&owner), "shared-report").await.unwrap().name, "hub 버전");
    assert_eq!(mgr.get(None, "shared-report").await.unwrap().name, "공유 리포트");

    // admin 시점은 무변 (source="user" 2건)
    let admin_list = mgr.list(None).await;
    assert_eq!(admin_list.len(), 2);
    assert!(admin_list.iter().all(|e| e.source == "user"));
}

//! SkillFileManager integration test — hub widget allowlist(공유 스킬) 오버레이.
//! 병합 규칙: system ∪ [hub 공유(admin ∩ allowed_skills)] ∪ owner(뒤가 override).

use std::sync::Arc;
use firebat_core::managers::skill_file::{SkillEntry, SkillFileManager};
use firebat_core::ports::IStoragePort;
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn entry(slug: &str, desc: &str) -> SkillEntry {
    SkillEntry {
        slug: slug.to_string(),
        name: slug.to_string(),
        kind: "procedure".to_string(),
        description: desc.to_string(),
        content: format!("manual body of {slug}"),
        source: String::new(),
        overrides_system: false,
    }
}

#[tokio::test]
async fn hub_shared_admin_skills_overlay() {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let mgr = SkillFileManager::new(storage);

    // admin 작성 2건 — 하나만 공유
    mgr.save(None, &entry("shared-skill", "공유")).await.unwrap();
    mgr.save(None, &entry("private-skill", "비공유")).await.unwrap();

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
        allowed_skills: vec!["shared-skill".to_string()],
        allowed_templates: vec![],
    };
    hub.create_instance(&inst).await.unwrap();
    mgr.set_hub_port(hub);

    // skills owner = "hub:<inst>:<sid>"
    let owner = "hub:inst-share:sess1".to_string();
    let list = mgr.list(Some(&owner)).await.unwrap();
    let slugs: Vec<&str> = list.iter().map(|e| e.slug.as_str()).collect();
    assert!(slugs.contains(&"shared-skill"));
    assert!(!slugs.contains(&"private-skill")); // 미공유 = 불가시 (safe-closed)
    let shared = list.iter().find(|e| e.slug == "shared-skill").unwrap();
    assert_eq!(shared.source, "system"); // read-only 베이스로 합류

    // read: own 없음 → 공유 admin 파일 서빙 / 미공유 = 에러
    assert!(mgr.read(Some(&owner), "shared-skill").await.is_ok());
    assert!(mgr.read(Some(&owner), "private-skill").await.is_err());

    // hub own 저장 = override (admin 원본 불변) + overrides_system 플래그 (복원 버튼)
    mgr.save(Some(&owner), &entry("shared-skill", "hub 버전")).await.unwrap();
    let own = mgr.read(Some(&owner), "shared-skill").await.unwrap();
    assert_eq!(own.source, "user");
    assert!(own.overrides_system);
    assert_eq!(mgr.read(None, "shared-skill").await.unwrap().description, "공유");

    // 인덱스에도 공유 스킬 등장 + admin 인덱스는 무변
    let idx = mgr.get_index(Some(&owner)).await.unwrap();
    assert!(idx.contains("shared-skill"));
    assert!(!idx.contains("private-skill"));
}

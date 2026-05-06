//! CapabilityManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::capabilities::CapabilitySettings;
use firebat_core::managers::capability::CapabilityManager;
use firebat_core::ports::{ILogPort, IStoragePort, IVaultPort};
use firebat_core::vault_keys::vk_module_settings;
use firebat_infra::adapters::log::ConsoleLogAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_manager() -> (CapabilityManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    (CapabilityManager::new(storage, vault, log), dir)
}

#[tokio::test]
async fn list_returns_builtin_capabilities() {
    let (mgr, _dir) = make_manager();
    let caps = mgr.list();
    assert!(caps.contains_key("web-scrape"));
    assert!(caps.contains_key("notification"));
    assert_eq!(caps.len(), 11);
}

#[tokio::test]
async fn register_adds_dynamic_capability() {
    let (mgr, _dir) = make_manager();
    mgr.register("custom-cap", "사용자 정의", "테스트");
    let caps = mgr.list();
    assert_eq!(caps.len(), 12);
    assert_eq!(caps.get("custom-cap").unwrap().label, "사용자 정의");
}

#[tokio::test]
async fn get_providers_scans_modules() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    // capability=notification provider 2개
    storage
        .write(
            "system/modules/kakao-talk/config.json",
            r#"{"name":"kakao-talk","capability":"notification","providerType":"api","description":"카톡 알림"}"#,
        )
        .await
        .unwrap();
    storage
        .write(
            "user/modules/slack-webhook/config.json",
            r#"{"name":"slack-webhook","capability":"notification","providerType":"api","description":"슬랙 webhook"}"#,
        )
        .await
        .unwrap();
    // 다른 capability — 영향 X
    storage
        .write(
            "system/modules/firecrawl/config.json",
            r#"{"name":"firecrawl","capability":"web-scrape","providerType":"api","description":"firecrawl"}"#,
        )
        .await
        .unwrap();

    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = CapabilityManager::new(storage_arc, vault, log);

    let providers = mgr.get_providers("notification").await;
    assert_eq!(providers.len(), 2);
    assert!(providers.iter().any(|p| p.module_name == "kakao-talk"));
    assert!(providers.iter().any(|p| p.module_name == "slack-webhook"));

    let scrape = mgr.get_providers("web-scrape").await;
    assert_eq!(scrape.len(), 1);
    assert_eq!(scrape[0].module_name, "firecrawl");
}

#[tokio::test]
async fn disabled_module_excluded_from_providers() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    storage
        .write(
            "system/modules/kakao-talk/config.json",
            r#"{"name":"kakao-talk","capability":"notification","providerType":"api"}"#,
        )
        .await
        .unwrap();

    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    // 비활성화 설정
    vault.set_secret(&vk_module_settings("kakao-talk"), r#"{"enabled":false}"#);
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = CapabilityManager::new(storage_arc, vault, log);

    let providers = mgr.get_providers("notification").await;
    assert_eq!(providers.len(), 0);
}

#[tokio::test]
async fn resolve_uses_user_settings_priority() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    storage
        .write(
            "system/modules/a/config.json",
            r#"{"name":"a","capability":"notification","providerType":"api"}"#,
        )
        .await
        .unwrap();
    storage
        .write(
            "system/modules/b/config.json",
            r#"{"name":"b","capability":"notification","providerType":"api"}"#,
        )
        .await
        .unwrap();

    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = CapabilityManager::new(storage_arc, vault, log);

    // 사용자 정의 순서: b 우선
    mgr.set_settings(
        "notification",
        &CapabilitySettings {
            providers: vec!["b".to_string(), "a".to_string()],
        },
    );
    let resolved = mgr.resolve("notification").await.unwrap();
    assert_eq!(resolved.module_name, "b");
}

#[tokio::test]
async fn unknown_capability_auto_registered_on_scan() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    // 빌트인에 없는 capability
    storage
        .write(
            "user/modules/myapp/config.json",
            r#"{"name":"myapp","capability":"my-custom-thing","description":"custom"}"#,
        )
        .await
        .unwrap();

    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let mgr = CapabilityManager::new(storage_arc, vault, log);

    // get_providers 호출 후 dynamic 에 등록됨
    let providers = mgr.get_providers("my-custom-thing").await;
    assert_eq!(providers.len(), 1);
    assert!(mgr.list().contains_key("my-custom-thing"));
}

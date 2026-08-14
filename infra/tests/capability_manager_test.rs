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

/// The list is what the modules say it is.
///
/// This used to assert a fixed count of eleven built-ins, which is what let the hand-written list
/// drift from the modules in both directions — capabilities on the screen with no provider, and
/// providers whose capability never appeared. With nothing installed there is nothing to offer.
#[tokio::test]
async fn an_installation_with_no_modules_offers_no_capabilities() {
    let (mgr, _dir) = make_manager();
    assert!(mgr.list().await.is_empty());
}

#[tokio::test]
async fn register_adds_dynamic_capability() {
    let (mgr, _dir) = make_manager();
    mgr.register("custom-cap", "사용자 정의", "테스트");
    let caps = mgr.list().await;
    assert_eq!(caps.len(), 1);
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

/// Builds three providers of one capability, plus a lone provider of another.
async fn three_providers_and_a_loner() -> (CapabilityManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    for name in ["naver", "daum", "bing"] {
        storage
            .write(
                &format!("system/modules/{name}/config.json"),
                &format!(r#"{{"name":"{name}","capability":"web-search","providerType":"api"}}"#),
            )
            .await
            .unwrap();
    }
    storage
        .write(
            "system/modules/telegram/config.json",
            r#"{"name":"telegram","capability":"notification","providerType":"api"}"#,
        )
        .await
        .unwrap();
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    (CapabilityManager::new(storage_arc, vault, log), dir)
}

#[tokio::test]
async fn a_chosen_order_becomes_a_rank_for_every_provider() {
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "web-search",
        &CapabilitySettings {
            providers: vec!["naver".into(), "daum".into(), "bing".into()],
        },
    );
    let ranks = mgr.preference_ranks().await;
    assert_eq!(ranks.get("naver"), Some(&(1, 3)));
    assert_eq!(ranks.get("daum"), Some(&(2, 3)));
    assert_eq!(ranks.get("bing"), Some(&(3, 3)));
}

#[tokio::test]
async fn providers_the_user_did_not_order_rank_after_the_ones_they_did() {
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "web-search",
        &CapabilitySettings {
            providers: vec!["bing".into()],
        },
    );
    let ranks = mgr.preference_ranks().await;
    assert_eq!(ranks.get("bing"), Some(&(1, 3)), "the chosen one leads");
    // The other two still get a rank, because the retry path would visit them in this order.
    assert_eq!(ranks.len(), 3);
}

#[tokio::test]
async fn with_nothing_saved_the_order_is_still_defined_and_alphabetical() {
    // There is no "unset" state to behave differently: 0-9 then a-z.
    let (mgr, _dir) = three_providers_and_a_loner().await;
    let ranks = mgr.preference_ranks().await;
    assert_eq!(ranks.get("bing"), Some(&(1, 3)));
    assert_eq!(ranks.get("daum"), Some(&(2, 3)));
    assert_eq!(ranks.get("naver"), Some(&(3, 3)));
}

#[tokio::test]
async fn an_order_naming_only_gone_modules_falls_back_to_alphabetical() {
    // The saved list outlived what it named. Nothing is held open for the ghosts.
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "web-search",
        &CapabilitySettings {
            providers: vec!["yahoo".into(), "altavista".into()],
        },
    );
    let ranks = mgr.preference_ranks().await;
    assert_eq!(ranks.get("bing"), Some(&(1, 3)));
    assert_eq!(ranks.get("naver"), Some(&(3, 3)));
}

#[tokio::test]
async fn the_label_the_retry_path_and_resolve_read_one_order() {
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "web-search",
        &CapabilitySettings {
            providers: vec!["daum".into()],
        },
    );
    let ranks = mgr.preference_ranks().await;
    assert_eq!(ranks.get("daum"), Some(&(1, 3)), "chosen leads");
    // resolve picks rank 1 …
    assert_eq!(mgr.resolve("web-search").await.unwrap().module_name, "daum");
    // … and a retry after daum fails walks 2 then 3, in the same order the label announced.
    let after: Vec<String> = mgr
        .fallback_modules("daum")
        .await
        .into_iter()
        .map(|p| p.module_name)
        .collect();
    assert_eq!(after, vec!["bing".to_string(), "naver".to_string()]);
    assert_eq!(ranks.get("bing"), Some(&(2, 3)));
    assert_eq!(ranks.get("naver"), Some(&(3, 3)));
}

#[tokio::test]
async fn a_new_provider_joins_the_ranking_with_no_code_change() {
    // The whole point of deriving: install a module, it is ranked. Here the user ordered two and
    // a third exists that they never saw — it takes the last place rather than being dropped.
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "web-search",
        &CapabilitySettings {
            providers: vec!["naver".into(), "daum".into()],
        },
    );
    let ranks = mgr.preference_ranks().await;
    assert_eq!(ranks.get("naver"), Some(&(1, 3)), "total counts the newcomer");
    assert_eq!(ranks.get("daum"), Some(&(2, 3)));
    assert_eq!(ranks.get("bing"), Some(&(3, 3)));
}

#[tokio::test]
async fn an_order_naming_only_gone_modules_ranks_nothing() {
    // The saved list outlived what it named. Sorting on it ties everything, and scan order would
    // go out wearing rank numbers — a preference nobody expressed.
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "web-search",
        &CapabilitySettings {
            providers: vec!["yahoo".into(), "altavista".into()],
        },
    );
    assert!(mgr.preference_ranks().await.is_empty());
}

#[tokio::test]
async fn a_capability_with_one_provider_is_not_ranked() {
    let (mgr, _dir) = three_providers_and_a_loner().await;
    mgr.set_settings(
        "notification",
        &CapabilitySettings {
            providers: vec!["telegram".into()],
        },
    );
    assert!(
        mgr.preference_ranks().await.get("telegram").is_none(),
        "「선호 1순위/1」 over a list of one says nothing"
    );
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
    assert!(mgr.list().await.contains_key("my-custom-thing"));
}

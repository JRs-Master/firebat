//! SecretManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::secret::SecretManager;
use firebat_core::ports::{IStoragePort, IVaultPort};
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

fn make_manager() -> (SecretManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    (SecretManager::new(vault, storage), dir)
}

#[tokio::test]
async fn user_secrets_crud() {
    let (mgr, _dir) = make_manager();

    assert_eq!(mgr.list_user().len(), 0);

    mgr.set_user("KAKAO_TOKEN", "abc123");
    assert_eq!(mgr.get_user("KAKAO_TOKEN"), Some("abc123".to_string()));

    let names = mgr.list_user();
    assert_eq!(names, vec!["KAKAO_TOKEN".to_string()]);

    mgr.delete_user("KAKAO_TOKEN");
    assert_eq!(mgr.get_user("KAKAO_TOKEN"), None);
}

#[tokio::test]
async fn system_secrets_use_raw_key() {
    let (mgr, _dir) = make_manager();

    mgr.set_system("system:vertex-key", "vk-xxx");
    assert_eq!(mgr.get_system("system:vertex-key"), Some("vk-xxx".to_string()));
    // user list 에는 안 잡힘 (다른 prefix)
    assert_eq!(mgr.list_user().len(), 0);
}

#[tokio::test]
async fn list_module_secrets_collects_from_config_json() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());

    // 모듈 1 — KAKAO_TOKEN, GMAIL_KEY 필요
    storage
        .write(
            "user/modules/notify/config.json",
            r#"{"name":"notify","secrets":["KAKAO_TOKEN","GMAIL_KEY"]}"#,
        )
        .await
        .unwrap();
    // 모듈 2 — GMAIL_KEY 중복, OPENAI_KEY 추가
    storage
        .write(
            "user/modules/email/config.json",
            r#"{"name":"email","secrets":["GMAIL_KEY","OPENAI_KEY"]}"#,
        )
        .await
        .unwrap();
    // 모듈 3 — secrets 없음 (스킵)
    storage
        .write("user/modules/empty/config.json", r#"{"name":"empty"}"#)
        .await
        .unwrap();

    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    // KAKAO_TOKEN 등록 — has_value=true 확인용
    vault.set_secret("user:KAKAO_TOKEN", "registered");
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let mgr = SecretManager::new(vault, storage_arc);

    let entries = mgr.list_module_secrets().await;
    // 중복 제거 — KAKAO_TOKEN, GMAIL_KEY, OPENAI_KEY 3 개
    assert_eq!(entries.len(), 3);

    let kakao = entries
        .iter()
        .find(|e| e.secret_name == "KAKAO_TOKEN")
        .unwrap();
    assert!(kakao.has_value);

    let gmail = entries
        .iter()
        .find(|e| e.secret_name == "GMAIL_KEY")
        .unwrap();
    assert!(!gmail.has_value);
}

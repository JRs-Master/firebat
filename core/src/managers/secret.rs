//! SecretManager — 시크릿 CRUD + 모듈 시크릿 스캔.
//!
//! 옛 TS SecretManager (`core/managers/secret-manager.ts`) Rust 재구현.
//! 책임:
//!  - 사용자 시크릿 (`user:` prefix) — Vault SQLite 저장
//!  - 시스템 시크릿 (`system:` prefix, raw key) — 같은 Vault
//!  - 모듈 시크릿 스캔 — `user/modules/{name}/config.json` 의 `secrets` 배열 → 어드민 UI 가
//!    "이 모듈이 필요로 하는 키" + "현재 등록 여부" 표시
//!
//! MCP/API 토큰은 AuthManager 로 이관됨 (별도 layer).

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ports::{IStoragePort, IVaultPort};
use crate::vault_keys::{vk_user_secret, USER_SECRET_PREFIX};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleSecretEntry {
    #[serde(rename = "secretName")]
    pub secret_name: String,
    #[serde(rename = "moduleName")]
    pub module_name: String,
    #[serde(rename = "hasValue")]
    pub has_value: bool,
}

pub struct SecretManager {
    vault: Arc<dyn IVaultPort>,
    storage: Arc<dyn IStoragePort>,
}

impl SecretManager {
    pub fn new(vault: Arc<dyn IVaultPort>, storage: Arc<dyn IStoragePort>) -> Self {
        Self { vault, storage }
    }

    // ── 사용자 시크릿 ──

    /// 사용자 시크릿 key 목록 (`user:` prefix 떼고 반환).
    pub fn list_user(&self) -> Vec<String> {
        self.vault
            .list_keys_by_prefix(USER_SECRET_PREFIX)
            .into_iter()
            .map(|k| k.trim_start_matches(USER_SECRET_PREFIX).to_string())
            .collect()
    }

    pub fn set_user(&self, name: &str, value: &str) -> bool {
        self.vault.set_secret(&vk_user_secret(name), value)
    }

    pub fn get_user(&self, name: &str) -> Option<String> {
        self.vault.get_secret(&vk_user_secret(name))
    }

    pub fn delete_user(&self, name: &str) -> bool {
        self.vault.delete_secret(&vk_user_secret(name))
    }

    // ── 모듈 시크릿 스캔 ──

    /// 유저 모듈 의 config.json secrets 배열 수집 — 어드민 UI 가 "필요한 키 + 등록 여부" 표시.
    pub async fn list_module_secrets(&self) -> Vec<ModuleSecretEntry> {
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::<String>::new();

        let Ok(dir_entries) = self.storage.list_dir("user/modules").await else {
            return result;
        };
        for entry in dir_entries {
            if !entry.is_directory {
                continue;
            }
            let path = format!("user/modules/{}/config.json", entry.name);
            let Ok(content) = self.storage.read(&path).await else {
                continue;
            };
            let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content) else {
                continue;
            };
            let secrets = match parsed.get("secrets").and_then(|v| v.as_array()) {
                Some(arr) => arr,
                None => continue,
            };
            let module_name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.name)
                .to_string();
            for s in secrets {
                let Some(secret_name) = s.as_str() else {
                    continue;
                };
                if seen.contains(secret_name) {
                    continue;
                }
                seen.insert(secret_name.to_string());
                let has_value = self.get_user(secret_name).is_some();
                result.push(ModuleSecretEntry {
                    secret_name: secret_name.to_string(),
                    module_name: module_name.clone(),
                    has_value,
                });
            }
        }
        result
    }

    // ── 시스템 시크릿 (Vertex AI / Anthropic / 등 raw key) ──

    pub fn get_system(&self, key: &str) -> Option<String> {
        self.vault.get_secret(key)
    }

    pub fn set_system(&self, key: &str, value: &str) -> bool {
        self.vault.set_secret(key, value)
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::{storage::LocalStorageAdapter, vault::SqliteVaultAdapter};
    use tempfile::tempdir;

    fn make_manager(workspace: &std::path::Path) -> SecretManager {
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(workspace));
        SecretManager::new(vault, storage)
    }

    #[tokio::test]
    async fn user_secrets_crud() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());

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
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());

        mgr.set_system("system:vertex-key", "vk-xxx");
        assert_eq!(mgr.get_system("system:vertex-key"), Some("vk-xxx".to_string()));
        // user list 에는 안 잡힘 (다른 prefix)
        assert_eq!(mgr.list_user().len(), 0);
    }

    #[tokio::test]
    async fn list_module_secrets_collects_from_config_json() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());

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
            .write(
                "user/modules/empty/config.json",
                r#"{"name":"empty"}"#,
            )
            .await
            .unwrap();

        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        // KAKAO_TOKEN 등록 — has_value=true 확인용
        vault.set_secret("user:KAKAO_TOKEN", "registered");
        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let mgr = SecretManager::new(vault, storage_arc);

        let entries = mgr.list_module_secrets().await;
        // 중복 제거 — KAKAO_TOKEN, GMAIL_KEY, OPENAI_KEY 3 개
        assert_eq!(entries.len(), 3);

        let kakao = entries.iter().find(|e| e.secret_name == "KAKAO_TOKEN").unwrap();
        assert!(kakao.has_value);

        let gmail = entries.iter().find(|e| e.secret_name == "GMAIL_KEY").unwrap();
        assert!(!gmail.has_value);
    }
}

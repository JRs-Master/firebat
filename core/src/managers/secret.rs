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
#[serde(rename_all = "camelCase")]
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

    /// 사용자 시크릿 저장 — 앞뒤 공백 자동 제거. 복사붙여넣기 시 줄바꿈 / 탭 / 공백 혼입 방지.
    /// frontend trim 만 의존하면 API 직접 호출 시 우회 가능. 백엔드 단일 경로 안 일관성 보장.
    pub fn set_user(&self, name: &str, value: &str) -> bool {
        self.vault.set_secret(&vk_user_secret(name), value.trim())
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
            // secrets 배열 — string|object union (MODULE_BIBLE 제4장). 빈 / 없는 영역 skip.
            let secrets = crate::utils::secret_schema::parse_secrets(&parsed);
            if secrets.is_empty() {
                continue;
            }
            let module_name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.name)
                .to_string();
            for meta in secrets {
                if seen.contains(&meta.name) {
                    continue;
                }
                let secret_name = meta.name.clone();
                seen.insert(secret_name.clone());
                let has_value = self.get_user(&secret_name).is_some();
                result.push(ModuleSecretEntry {
                    secret_name,
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

    /// 시스템 시크릿 저장 — 앞뒤 공백 자동 제거 (모듈 secret 도 본 메서드 통과).
    pub fn set_system(&self, key: &str, value: &str) -> bool {
        self.vault.set_secret(key, value.trim())
    }
}


// Tests 이관 — `infra/tests/secret_manager_test.rs` (integration test).

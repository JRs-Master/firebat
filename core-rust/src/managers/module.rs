//! ModuleManager — 시스템 / 사용자 모듈 목록 + 실행 + 설정.
//!
//! 옛 TS ModuleManager (`core/managers/module-manager.ts`) Rust 재구현 (Phase B core 부분).
//! 책임:
//!  - listSystem / listUserModules — Storage scan
//!  - run / execute — Sandbox spawn
//!  - getModuleConfig — config.json 직접 파싱
//!  - getSettings / setSettings / isEnabled / setEnabled — Vault
//!
//! 옛 TS 의 getCmsSettings (design tokens / cms layout) 영역은 별도 phase — 메인 cms 영역
//! 에서 처리. Phase B-8 minimum 은 위 5 책임만.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::ports::{ISandboxPort, IStoragePort, IVaultPort, InfraResult, ModuleOutput, SandboxExecuteOpts};
use crate::vault_keys::vk_module_settings;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemEntry {
    pub name: String,
    pub description: String,
    pub runtime: String,
    #[serde(rename = "type")]
    pub entry_type: String, // 'service' | 'module'
    pub scope: String,      // 'system' | 'user'
    pub enabled: bool,
}

const ENTRY_FILES: &[&str] = &["main.py", "index.js", "index.mjs", "main.php", "main.sh"];

fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains("..") && !name.contains('/') && !name.contains('\\')
}

pub struct ModuleManager {
    sandbox: Arc<dyn ISandboxPort>,
    storage: Arc<dyn IStoragePort>,
    vault: Arc<dyn IVaultPort>,
}

impl ModuleManager {
    pub fn new(
        sandbox: Arc<dyn ISandboxPort>,
        storage: Arc<dyn IStoragePort>,
        vault: Arc<dyn IVaultPort>,
    ) -> Self {
        Self {
            sandbox,
            storage,
            vault,
        }
    }

    /// 직접 경로 실행 (EXECUTE / 파이프라인 등).
    pub async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        self.sandbox.execute(target_path, input_data, opts).await
    }

    /// 모듈명으로 실행 — entry 자동 탐색.
    pub async fn run(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> InfraResult<ModuleOutput> {
        if !is_safe_name(module_name) {
            return Err("잘못된 모듈 이름입니다.".into());
        }
        let dir_path = format!("user/modules/{}", module_name);
        let entries = self.storage.list_dir(&dir_path).await?;
        let files: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_directory)
            .map(|e| e.name.clone())
            .collect();
        let entry = ENTRY_FILES
            .iter()
            .find(|f| files.contains(&f.to_string()))
            .ok_or_else(|| "모듈 entry 파일을 찾을 수 없습니다.".to_string())?;
        let target = format!("{}/{}", dir_path, entry);
        self.sandbox
            .execute(&target, input_data, &SandboxExecuteOpts::default())
            .await
    }

    /// system/modules/ 시스템 모듈 list.
    pub async fn list_system_modules(&self) -> Vec<SystemEntry> {
        self.scan_dir("system/modules", "module", "system").await
    }

    /// system/services/ 시스템 서비스 list.
    pub async fn list_system_services(&self) -> Vec<SystemEntry> {
        self.scan_dir("system/services", "service", "system").await
    }

    /// 시스템 modules + services 통합.
    pub async fn list_system(&self) -> Vec<SystemEntry> {
        let mut services = self.list_system_services().await;
        let modules = self.list_system_modules().await;
        services.extend(modules);
        services
    }

    /// user/modules/ 사용자 모듈 list.
    pub async fn list_user_modules(&self) -> Vec<SystemEntry> {
        self.scan_dir("user/modules", "module", "user").await
    }

    /// scope + name 으로 config.json 직접 파싱.
    pub async fn get_module_config(
        &self,
        scope: &str,
        name: &str,
    ) -> Option<serde_json::Value> {
        if !is_safe_name(name) {
            return None;
        }
        let candidates: Vec<String> = if scope == "user" {
            vec![format!("user/modules/{}/config.json", name)]
        } else {
            vec![
                format!("system/modules/{}/config.json", name),
                format!("system/services/{}/config.json", name),
            ]
        };
        for path in candidates {
            if let Ok(content) = self.storage.read(&path).await {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                    return Some(parsed);
                }
            }
        }
        None
    }

    /// 모듈 settings (Vault).
    pub fn get_settings(&self, module_name: &str) -> serde_json::Value {
        let raw = self.vault.get_secret(&vk_module_settings(module_name));
        match raw {
            Some(json) => serde_json::from_str(&json).unwrap_or(serde_json::json!({})),
            None => serde_json::json!({}),
        }
    }

    pub fn set_settings(&self, module_name: &str, settings: &serde_json::Value) -> bool {
        let Ok(json) = serde_json::to_string(settings) else {
            return false;
        };
        self.vault.set_secret(&vk_module_settings(module_name), &json)
    }

    /// 활성화 여부 — settings.enabled (default true).
    pub fn is_enabled(&self, module_name: &str) -> bool {
        let settings = self.get_settings(module_name);
        settings
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }

    pub fn set_enabled(&self, module_name: &str, enabled: bool) -> bool {
        let mut settings = self.get_settings(module_name);
        if !settings.is_object() {
            settings = serde_json::json!({});
        }
        settings["enabled"] = serde_json::Value::Bool(enabled);
        self.set_settings(module_name, &settings)
    }

    // ─── private helpers ───

    async fn scan_dir(&self, dir: &str, entry_type: &str, scope: &str) -> Vec<SystemEntry> {
        let Ok(entries) = self.storage.list_dir(dir).await else {
            return vec![];
        };
        let mut result = Vec::new();
        for entry in entries {
            if !entry.is_directory {
                continue;
            }
            let path = format!("{}/{}/config.json", dir, entry.name);
            let Ok(content) = self.storage.read(&path).await else { continue };
            let Ok(parsed): Result<serde_json::Value, _> = serde_json::from_str(&content) else {
                continue
            };
            let name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&entry.name)
                .to_string();
            let description = parsed
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let runtime = parsed
                .get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let enabled = self.is_enabled(&name);
            result.push(SystemEntry {
                name,
                description,
                runtime,
                entry_type: entry_type.to_string(),
                scope: scope.to_string(),
                enabled,
            });
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::{
        sandbox::StubSandboxAdapter, storage::LocalStorageAdapter, vault::SqliteVaultAdapter,
    };
    use tempfile::tempdir;

    fn make_manager(workspace: &std::path::Path) -> ModuleManager {
        let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandboxAdapter {
            fixed_output: ModuleOutput {
                success: true,
                data: serde_json::json!({"ok": true}),
                error: None,
                stderr: None,
                exit_code: Some(0),
            },
        });
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(workspace));
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        ModuleManager::new(sandbox, storage, vault)
    }

    #[tokio::test]
    async fn list_system_modules_scans_dir() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage
            .write(
                "system/modules/kakao-talk/config.json",
                r#"{"name":"kakao-talk","description":"카톡","runtime":"node"}"#,
            )
            .await
            .unwrap();
        storage
            .write(
                "system/modules/yfinance/config.json",
                r#"{"name":"yfinance","description":"yahoo","runtime":"python"}"#,
            )
            .await
            .unwrap();
        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandboxAdapter {
            fixed_output: ModuleOutput::default_success(),
        });
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let mgr = ModuleManager::new(sandbox, storage_arc, vault);

        let mods = mgr.list_system_modules().await;
        assert_eq!(mods.len(), 2);
        assert_eq!(mods[0].name, "kakao-talk");
        assert_eq!(mods[0].entry_type, "module");
        assert_eq!(mods[0].scope, "system");
        assert!(mods[0].enabled);
    }

    #[tokio::test]
    async fn enabled_toggle_via_vault() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());

        // 미설정 → default true
        assert!(mgr.is_enabled("kakao-talk"));

        // 비활성화
        mgr.set_enabled("kakao-talk", false);
        assert!(!mgr.is_enabled("kakao-talk"));

        // 활성화
        mgr.set_enabled("kakao-talk", true);
        assert!(mgr.is_enabled("kakao-talk"));
    }

    #[tokio::test]
    async fn get_module_config_parses_json() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        storage
            .write(
                "user/modules/myapp/config.json",
                r#"{"name":"myapp","capability":"web-scrape"}"#,
            )
            .await
            .unwrap();
        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandboxAdapter {
            fixed_output: ModuleOutput::default_success(),
        });
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let mgr = ModuleManager::new(sandbox, storage_arc, vault);

        let config = mgr.get_module_config("user", "myapp").await.unwrap();
        assert_eq!(config["name"], "myapp");
        assert_eq!(config["capability"], "web-scrape");

        // 잘못된 이름
        assert!(mgr.get_module_config("user", "../evil").await.is_none());
    }

    #[tokio::test]
    async fn run_with_invalid_name_rejected() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());
        let result = mgr.run("../etc", &serde_json::json!({})).await;
        assert!(result.is_err());
    }
}

// 테스트 helper — ModuleOutput default_success
#[cfg(test)]
impl ModuleOutput {
    pub fn default_success() -> Self {
        Self {
            success: true,
            data: serde_json::json!({}),
            error: None,
            stderr: None,
            exit_code: Some(0),
        }
    }
}

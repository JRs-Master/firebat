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
    /// 옛 TS `run(name, input)` 1:1 — listDir 실패 시 한국어 에러 명시.
    pub async fn run(
        &self,
        module_name: &str,
        input_data: &serde_json::Value,
    ) -> InfraResult<ModuleOutput> {
        if !is_safe_name(module_name) {
            return Err("잘못된 모듈 이름입니다.".into());
        }
        let dir_path = format!("user/modules/{}", module_name);
        let entries = self
            .storage
            .list_dir(&dir_path)
            .await
            .map_err(|_| format!("모듈을 찾을 수 없습니다: {}", module_name))?;
        let files: Vec<String> = entries
            .iter()
            .filter(|e| !e.is_directory)
            .map(|e| e.name.clone())
            .collect();
        let entry = ENTRY_FILES
            .iter()
            .find(|f| files.contains(&f.to_string()))
            .ok_or_else(|| format!("모듈 entry 파일을 찾을 수 없습니다: {}", module_name))?;
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

    /// 디렉토리 스캔 — config.json 박힌 하위 디렉토리 → SystemEntry list.
    /// 옛 TS `scanDir(dir, defaultType, defaultScope)` 1:1:
    ///   - config.json 의 `type` / `scope` 박혀있으면 우선 (인자 default 는 fallback)
    ///   - config.json 안 박힌 디렉토리는 skip
    /// 정렬 — 옛 TS 는 자연 디렉토리 순서. Rust 도 sort 하지 않음 (silent behavior 차이 fix).
    async fn scan_dir(
        &self,
        dir: &str,
        default_type: &str,
        default_scope: &str,
    ) -> Vec<SystemEntry> {
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
            // 옛 TS `parsed.type || defaultType` / `parsed.scope || defaultScope` 1:1
            // (config.json 의 type / scope 가 우선 — 호출자 인자는 fallback)
            let entry_type = parsed
                .get("type")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(default_type)
                .to_string();
            let scope = parsed
                .get("scope")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(default_scope)
                .to_string();
            let enabled = self.is_enabled(&name);
            result.push(SystemEntry {
                name,
                description,
                runtime,
                entry_type,
                scope,
                enabled,
            });
        }
        result
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::{
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
        // 정렬 가정 X — 이름 set 으로 매칭 (옛 TS 동등 — 자연 디렉토리 순서)
        let names: std::collections::HashSet<&str> =
            mods.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains("kakao-talk"));
        assert!(names.contains("yfinance"));
        // 모든 entry 의 type/scope default 적용 확인
        for m in &mods {
            assert_eq!(m.entry_type, "module");
            assert_eq!(m.scope, "system");
            assert!(m.enabled);
        }
    }

    #[tokio::test]
    async fn config_type_scope_override_default_args() {
        // 옛 TS `parsed.type || defaultType` 1:1 — config.json 의 명시값 우선.
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // user/modules/ 디렉토리에 박음 + config.json 의 scope="system" override
        storage
            .write(
                "user/modules/special/config.json",
                r#"{"name":"special","description":"override","runtime":"node","type":"service","scope":"system"}"#,
            )
            .await
            .unwrap();
        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandboxAdapter {
            fixed_output: ModuleOutput::default_success(),
        });
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let mgr = ModuleManager::new(sandbox, storage_arc, vault);

        // list_user_modules 호출 시 default = (type=module, scope=user) 박지만
        // config.json 의 type/scope 가 우선 → service/system 으로 보고
        let mods = mgr.list_user_modules().await;
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].name, "special");
        assert_eq!(mods[0].entry_type, "service"); // override
        assert_eq!(mods[0].scope, "system"); // override
    }

    #[tokio::test]
    async fn run_unknown_module_returns_korean_error() {
        let tmp = tempdir().unwrap();
        let mgr = make_manager(tmp.path());
        // 디렉토리 미존재 → "모듈을 찾을 수 없습니다: ..." 한국어 에러 (옛 TS 1:1)
        let r = mgr.run("missing-xyz", &serde_json::json!({})).await;
        assert!(r.is_err());
        let err = r.unwrap_err();
        assert!(
            err.contains("모듈을 찾을 수 없습니다") && err.contains("missing-xyz"),
            "expected Korean error with module name, got: {err}"
        );
    }

    #[tokio::test]
    async fn run_no_entry_file_returns_korean_error() {
        let tmp = tempdir().unwrap();
        let storage = LocalStorageAdapter::new(tmp.path());
        // 디렉토리는 있지만 entry 파일 없음 (config.json 만)
        storage
            .write(
                "user/modules/no-entry/config.json",
                r#"{"name":"no-entry","runtime":"node"}"#,
            )
            .await
            .unwrap();
        let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
        let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandboxAdapter {
            fixed_output: ModuleOutput::default_success(),
        });
        let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new_in_memory().unwrap());
        let mgr = ModuleManager::new(sandbox, storage_arc, vault);

        let r = mgr.run("no-entry", &serde_json::json!({})).await;
        assert!(r.is_err());
        let err = r.unwrap_err();
        assert!(
            err.contains("entry 파일을 찾을 수 없습니다") && err.contains("no-entry"),
            "expected Korean error with module name, got: {err}"
        );
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

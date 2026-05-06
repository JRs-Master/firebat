//! ModuleManager integration test — 옛 core inline tests 이관.
//!
//! infra 의 `StubSandboxAdapter` 가 `#[cfg(test)]` 라 integration 안 보임 → 자체 stub 박음.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::module::ModuleManager;
use firebat_core::ports::{
    ISandboxPort, IStoragePort, IVaultPort, InfraResult, ModuleOutput, SandboxExecuteOpts,
};
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

/// 자체 stub — inline `StubSandboxAdapter` 가 #[cfg(test)] 라 integration 안 보임.
struct StubSandbox {
    fixed_output: ModuleOutput,
}

#[async_trait::async_trait]
impl ISandboxPort for StubSandbox {
    async fn execute(
        &self,
        _target_path: &str,
        _input_data: &serde_json::Value,
        _opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        Ok(self.fixed_output.clone())
    }

    fn capabilities(&self) -> firebat_core::ports::SandboxCapabilities {
        firebat_core::ports::SandboxCapabilities {
            kind: "stub".to_string(),
            ..Default::default()
        }
    }
}

fn default_success() -> ModuleOutput {
    ModuleOutput {
        success: true,
        data: serde_json::json!({}),
        error: None,
        stderr: None,
        exit_code: Some(0),
        ..Default::default()
    }
}

fn make_manager() -> (ModuleManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandbox {
        fixed_output: ModuleOutput {
            success: true,
            data: serde_json::json!({"ok": true}),
            error: None,
            stderr: None,
            exit_code: Some(0),
            ..Default::default()
        },
    });
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (ModuleManager::new(sandbox, storage, vault), dir)
}

#[tokio::test]
async fn list_system_modules_scans_dir() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
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
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandbox {
        fixed_output: default_success(),
    });
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let mgr = ModuleManager::new(sandbox, storage_arc, vault);

    let mods = mgr.list_system_modules().await;
    assert_eq!(mods.len(), 2);
    let names: std::collections::HashSet<&str> =
        mods.iter().map(|m| m.name.as_str()).collect();
    assert!(names.contains("kakao-talk"));
    assert!(names.contains("yfinance"));
    for m in &mods {
        assert_eq!(m.entry_type, "module");
        assert_eq!(m.scope, "system");
        assert!(m.enabled);
    }
}

#[tokio::test]
async fn config_type_scope_override_default_args() {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    storage
        .write(
            "user/modules/special/config.json",
            r#"{"name":"special","description":"override","runtime":"node","type":"service","scope":"system"}"#,
        )
        .await
        .unwrap();
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandbox {
        fixed_output: default_success(),
    });
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let mgr = ModuleManager::new(sandbox, storage_arc, vault);

    let mods = mgr.list_user_modules().await;
    assert_eq!(mods.len(), 1);
    assert_eq!(mods[0].name, "special");
    assert_eq!(mods[0].entry_type, "service"); // override
    assert_eq!(mods[0].scope, "system"); // override
}

#[tokio::test]
async fn run_unknown_module_returns_korean_error() {
    let (mgr, _dir) = make_manager();
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
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    storage
        .write(
            "user/modules/no-entry/config.json",
            r#"{"name":"no-entry","runtime":"node"}"#,
        )
        .await
        .unwrap();
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandbox {
        fixed_output: default_success(),
    });
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
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
    let (mgr, _dir) = make_manager();

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
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    storage
        .write(
            "user/modules/myapp/config.json",
            r#"{"name":"myapp","capability":"web-scrape"}"#,
        )
        .await
        .unwrap();
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandbox {
        fixed_output: default_success(),
    });
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let mgr = ModuleManager::new(sandbox, storage_arc, vault);

    let config = mgr.get_module_config("user", "myapp").await.unwrap();
    assert_eq!(config["name"], "myapp");
    assert_eq!(config["capability"], "web-scrape");

    // 잘못된 이름
    assert!(mgr.get_module_config("user", "../evil").await.is_none());
}

#[tokio::test]
async fn run_with_invalid_name_rejected() {
    let (mgr, _dir) = make_manager();
    let result = mgr.run("../etc", &serde_json::json!({})).await;
    assert!(result.is_err());
}

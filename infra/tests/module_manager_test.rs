//! ModuleManager integration test — 옛 core inline tests 이관.
//!
//! infra 의 `StubSandboxAdapter` 가 `#[cfg(test)]` 라 integration 안 보임 → 자체 stub 저장.

use std::path::PathBuf;
use std::sync::{Arc, Once};
use tempfile::TempDir;

use firebat_core::managers::module::ModuleManager;
use firebat_core::ports::{
    ISandboxPort, IStoragePort, IVaultPort, InfraResult, ModuleOutput, SandboxExecuteOpts,
};
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

/// workspace root 기준 `i18n::init` 1회. 미호출 시 i18n::t() 가 raw key 반환 → 사용자 노출
/// 메시지 substring 검증 test 실패. parallel test 호환 (Once::call_once).
fn init_i18n_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let workspace_root: PathBuf = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("infra crate 의 parent (workspace root)")
            .to_path_buf();
        firebat_core::i18n::init(&workspace_root);
    });
}

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
    init_i18n_once();
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
    init_i18n_once();
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

// ─── JSON Schema validation (Track A6, 2026-05-07) ──────────────────────────

async fn make_manager_with_module(
    config_json: &str,
    entry_name: &str,
) -> (ModuleManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage = LocalStorageAdapter::new(dir.path());
    storage
        .write("user/modules/sample/config.json", config_json)
        .await
        .unwrap();
    storage
        .write(&format!("user/modules/sample/{}", entry_name), "// stub")
        .await
        .unwrap();
    let storage_arc: Arc<dyn IStoragePort> = Arc::new(storage);
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(StubSandbox {
        fixed_output: ModuleOutput {
            success: true,
            data: serde_json::json!({"ok": true, "count": 5}),
            error: None,
            stderr: None,
            exit_code: Some(0),
            ..Default::default()
        },
    });
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    (ModuleManager::new(sandbox, storage_arc, vault), dir)
}

#[tokio::test]
async fn run_validates_input_schema_required_field() {
    // input.required: ["action"] — action 누락 시 spawn 안 함, 명시 에러
    let config = r#"{
        "name":"sample","runtime":"node",
        "input":{"type":"object","properties":{"action":{"type":"string"}},"required":["action"]}
    }"#;
    let (mgr, _dir) = make_manager_with_module(config, "index.mjs").await;

    let r = mgr.run("sample", &serde_json::json!({})).await;
    assert!(r.is_err(), "input.required 위반인데 통과: {:?}", r);
    let err = r.unwrap_err();
    assert!(err.contains("입력 검증 실패"), "한국어 에러 메시지 기대: {}", err);
    assert!(err.contains("sample"), "모듈명 포함 기대: {}", err);
}

#[tokio::test]
async fn run_validates_input_schema_enum() {
    let config = r#"{
        "name":"sample","runtime":"node",
        "input":{"type":"object","properties":{"action":{"type":"string","enum":["a","b"]}},"required":["action"]}
    }"#;
    let (mgr, _dir) = make_manager_with_module(config, "index.mjs").await;

    // 허용된 enum
    let ok = mgr
        .run("sample", &serde_json::json!({"action":"a"}))
        .await;
    assert!(ok.is_ok(), "허용 enum 인데 실패: {:?}", ok);

    // 미허용 enum
    let bad = mgr
        .run("sample", &serde_json::json!({"action":"z"}))
        .await;
    assert!(bad.is_err(), "미허용 enum 인데 통과: {:?}", bad);
}

#[tokio::test]
async fn run_no_schema_passes_through() {
    // input schema 없음 → 검증 skip, sandbox 호출
    let config = r#"{"name":"sample","runtime":"node"}"#;
    let (mgr, _dir) = make_manager_with_module(config, "index.mjs").await;

    let r = mgr.run("sample", &serde_json::json!({"anything":"ok"})).await;
    assert!(r.is_ok(), "schema 없는데 실패: {:?}", r);
}

#[tokio::test]
async fn dry_run_validates_without_spawn() {
    let config = r#"{
        "name":"sample","runtime":"node",
        "input":{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}
    }"#;
    let (mgr, _dir) = make_manager_with_module(config, "index.mjs").await;

    // 통과
    let ok = mgr.dry_run("user", "sample", &serde_json::json!({"x":42})).await;
    assert!(ok.is_ok(), "dry_run 통과 기대: {:?}", ok);

    // 실패
    let bad = mgr.dry_run("user", "sample", &serde_json::json!({})).await;
    assert!(bad.is_err(), "dry_run 실패 기대 (required 누락)");

    // 모듈 자체 없음
    let missing = mgr.dry_run("user", "missing-xyz", &serde_json::json!({})).await;
    assert!(missing.is_err());
}

#[tokio::test]
async fn dry_run_catches_malformed_schema() {
    // input schema 자체가 잘못됨 (type 값이 잘못된 식별자)
    let config = r#"{
        "name":"sample","runtime":"node",
        "input":{"type":"invalid_type","properties":{}}
    }"#;
    let (mgr, _dir) = make_manager_with_module(config, "index.mjs").await;

    let r = mgr.dry_run("user", "sample", &serde_json::json!({})).await;
    assert!(r.is_err(), "malformed schema 인데 통과: {:?}", r);
    let err = r.unwrap_err();
    assert!(
        err.contains("schema") || err.contains("형식"),
        "schema 형식 오류 메시지 기대: {}",
        err
    );
}

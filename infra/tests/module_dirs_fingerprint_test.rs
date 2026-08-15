//! The action catalog used to rebuild on a five-minute timer because it had no way to tell a quiet
//! five minutes from an edited one: it re-read and re-parsed every module config either way, and a
//! module installed at runtime still waited out the clock. `module_dirs_fingerprint` is that
//! missing answer, so these guard the two things it has to get right — it must not change when
//! nothing did, and it must change when anything did.

use std::sync::Arc;

use firebat_core::managers::module::ModuleManager;
use firebat_core::ports::{ISandboxPort, IStoragePort, IVaultPort};
use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;
use tempfile::{tempdir, TempDir};

fn setup() -> (TempDir, Arc<ModuleManager>) {
    let dir = tempdir().unwrap();
    let sandbox: Arc<dyn ISandboxPort> =
        Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let module = Arc::new(ModuleManager::new(sandbox, storage, vault));
    (dir, module)
}

fn write_file(root: &std::path::Path, rel: &str, body: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

#[tokio::test]
async fn an_untouched_tree_keeps_its_fingerprint() {
    let (dir, module) = setup();
    write_file(dir.path(), "system/modules/alpha/config.json", r#"{"name":"alpha"}"#);

    let first = module.module_dirs_fingerprint().await;
    let second = module.module_dirs_fingerprint().await;
    assert_eq!(first, second, "reading twice must not look like an edit");
    assert!(!first.is_empty());
}

#[tokio::test]
async fn editing_a_config_changes_the_fingerprint() {
    let (dir, module) = setup();
    write_file(dir.path(), "system/modules/alpha/config.json", r#"{"name":"alpha"}"#);
    let before = module.module_dirs_fingerprint().await;

    write_file(
        dir.path(),
        "system/modules/alpha/config.json",
        r#"{"name":"alpha","description":"now with a description"}"#,
    );
    assert_ne!(before, module.module_dirs_fingerprint().await);
}

/// A module's action catalog can live in a file the config only names, so watching `config.json`
/// alone would miss the edit that matters most to the index.
#[tokio::test]
async fn a_sibling_file_counts_too() {
    let (dir, module) = setup();
    write_file(dir.path(), "system/modules/alpha/config.json", r#"{"name":"alpha"}"#);
    let before = module.module_dirs_fingerprint().await;

    write_file(dir.path(), "system/modules/alpha/actions.json", r#"{"actions":[]}"#);
    assert_ne!(before, module.module_dirs_fingerprint().await);
}

#[tokio::test]
async fn installing_a_module_changes_the_fingerprint() {
    let (dir, module) = setup();
    write_file(dir.path(), "system/modules/alpha/config.json", r#"{"name":"alpha"}"#);
    let before = module.module_dirs_fingerprint().await;

    write_file(dir.path(), "user/modules/beta/config.json", r#"{"name":"beta"}"#);
    assert_ne!(
        before,
        module.module_dirs_fingerprint().await,
        "a module added at runtime must be visible without waiting out a timer"
    );
}

/// Nothing on disk is not an error state — it is a tree with no modules, and it has to stay
/// answerable so the first install registers as a change rather than as the first reading.
#[tokio::test]
async fn an_empty_tree_still_answers() {
    let (_dir, module) = setup();
    assert!(!module.module_dirs_fingerprint().await.is_empty());
}

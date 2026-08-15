//! A gate reads a map, and a map has three states, not two.
//!
//! `approval_for` returning `None` means "this module declares no approval" — and every gate
//! treats that as permission. It used to also mean "we never read this module's config", because
//! the scan skipped switched-off modules entirely and the executor takes its module from the call
//! rather than from the tool list. Switch a trading module on and the very next order could
//! dispatch with no card. See [[feedback_absence_is_not_consent]].

use std::sync::Arc;

use firebat_core::managers::ai::dynamic_tools::DynamicToolRegistry;
use firebat_core::managers::mcp::McpManager;
use firebat_core::managers::module::ModuleManager;
use firebat_core::managers::tool::{ToolListFilter, ToolManager};
use firebat_core::ports::{IMcpClientPort, ISandboxPort, IStoragePort, IVaultPort};
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
use firebat_infra::adapters::storage::LocalStorageAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;
use tempfile::{tempdir, TempDir};

/// A module that declares both things the gates care about: an order action behind
/// `requiresApproval`, and an `action` selector that makes the discovery gate apply.
fn trading_config() -> serde_json::Value {
    serde_json::json!({
        "name": "paper-trade",
        "description": "test broker",
        "input": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["quote", "place_order"] },
                "params": { "type": "object" }
            }
        },
        "requiresApproval": ["place_order"]
    })
}

fn write_module(root: &std::path::Path, name: &str, config: &serde_json::Value) {
    let dir = root.join("system").join("modules").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.json"),
        serde_json::to_string_pretty(config).unwrap(),
    )
    .unwrap();
}

fn setup() -> (TempDir, Arc<ToolManager>, Arc<ModuleManager>, DynamicToolRegistry) {
    let dir = tempdir().unwrap();
    let sandbox: Arc<dyn ISandboxPort> =
        Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let mcp_client: Arc<dyn IMcpClientPort> =
        Arc::new(McpClientFileAdapter::new(dir.path().join("mcp.json")).unwrap());

    let tools = Arc::new(ToolManager::new());
    let module = Arc::new(ModuleManager::new(sandbox, storage, vault));
    let mcp = Arc::new(McpManager::new(mcp_client));
    let registry = DynamicToolRegistry::new(tools.clone(), module.clone(), mcp);
    (dir, tools, module, registry)
}

fn tool_names(tools: &ToolManager) -> Vec<String> {
    tools
        .list(&ToolListFilter::default())
        .into_iter()
        .map(|d| d.name)
        .collect()
}

/// Being switched off is a reason not to publish a tool. It was never a reason to forget that the
/// module declares an order action.
#[tokio::test]
async fn a_switched_off_module_keeps_its_gate_declarations() {
    let (dir, tools, module, registry) = setup();
    write_module(dir.path(), "paper-trade", &trading_config());
    module.set_settings("paper-trade", &serde_json::json!({ "enabled": false }));

    registry.refresh().await;

    assert!(
        !tool_names(&tools).iter().any(|n| n.contains("paper-trade")),
        "a disabled module must not be published"
    );
    assert_eq!(
        registry.approval_for("paper-trade").await,
        Some(serde_json::json!(["place_order"])),
        "the approval declaration must survive the toggle — enabling the module later must not \
         leave the order gate open"
    );
    assert!(
        registry.has_action_selector("paper-trade").await,
        "the discovery gate applies to this module whether or not it is switched on"
    );
}

/// The executor takes its module from `args`, so a call can name a module the last scan never saw.
#[tokio::test]
async fn a_module_the_scan_never_saw_is_read_before_it_is_judged() {
    let (dir, _tools, _module, registry) = setup();
    registry.refresh().await; // nothing on disk yet
    write_module(dir.path(), "paper-trade", &trading_config());

    assert_eq!(
        registry.approval_for("paper-trade").await,
        Some(serde_json::json!(["place_order"])),
        "a module installed since the scan is parsed on demand, not waved through"
    );
}

/// The other direction: a name with no config on disk stays a miss, and must not be mistaken for
/// a module that merely declares nothing interesting.
#[tokio::test]
async fn a_name_that_is_not_a_module_declares_nothing() {
    let (_dir, _tools, _module, registry) = setup();
    registry.refresh().await;
    assert_eq!(registry.approval_for("no-such-module").await, None);
    assert!(!registry.has_action_selector("no-such-module").await);
}

/// The published tool still disappears when the owner switches the module off — the declarations
/// staying loaded must not quietly re-expose it.
#[tokio::test]
async fn switching_a_module_off_removes_its_tool() {
    let (dir, tools, module, registry) = setup();
    write_module(dir.path(), "paper-trade", &trading_config());

    registry.refresh().await;
    assert!(
        tool_names(&tools).iter().any(|n| n.contains("paper-trade")),
        "an enabled module publishes its tool"
    );

    module.set_settings("paper-trade", &serde_json::json!({ "enabled": false }));
    // What the toggle RPC does — `ModuleService::invalidate_tools_cache`.
    registry.invalidate().await;
    registry.refresh().await;
    assert!(
        !tool_names(&tools).iter().any(|n| n.contains("paper-trade")),
        "switching it off withdraws the tool"
    );
}

/// A toggle leaves the module tree byte-identical, so the rebuild trigger cannot be the
/// fingerprint alone — `invalidate` has to clear it too, or the very next refresh concludes
/// nothing changed and the withdrawn tool comes back.
#[tokio::test]
async fn invalidate_rebuilds_even_though_the_tree_is_unchanged() {
    let (dir, tools, module, registry) = setup();
    write_module(dir.path(), "paper-trade", &trading_config());
    module.set_settings("paper-trade", &serde_json::json!({ "enabled": false }));
    registry.refresh().await;
    assert!(!tool_names(&tools).iter().any(|n| n.contains("paper-trade")));

    module.set_settings("paper-trade", &serde_json::json!({ "enabled": true }));
    registry.invalidate().await;
    registry.refresh().await;
    assert!(
        tool_names(&tools).iter().any(|n| n.contains("paper-trade")),
        "switching it back on republishes the tool"
    );
}

/// The other trigger: a module that appears on disk. Nothing announces it, so the fingerprint is
/// what has to notice.
#[tokio::test]
async fn a_module_written_after_the_build_is_registered_on_the_next_rebuild() {
    let (dir, tools, _module, registry) = setup();
    registry.refresh().await;
    assert!(tool_names(&tools).is_empty());

    write_module(dir.path(), "paper-trade", &trading_config());
    registry.invalidate().await; // stand in for the debounce expiring
    registry.refresh().await;
    assert!(tool_names(&tools).iter().any(|n| n.contains("paper-trade")));
}

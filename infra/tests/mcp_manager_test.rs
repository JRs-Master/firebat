//! McpManager integration test — 옛 core inline tests 이관.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Once};
use tempfile::TempDir;

use firebat_core::managers::mcp::McpManager;
use firebat_core::ports::{IMcpClientPort, IVaultPort, McpServerConfig, McpTransport};
use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
use firebat_infra::adapters::vault::SqliteVaultAdapter;

/// workspace root 기준 `i18n::init` 1회 — 미호출 시 i18n::t() 가 raw key 반환.
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

fn make_manager() -> (McpManager, TempDir) {
    init_i18n_once();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    let client: Arc<dyn IMcpClientPort> = Arc::new(McpClientFileAdapter::new(path).unwrap());
    (McpManager::new(client), dir)
}

/// Manager and adapter sharing one vault, as `main.rs` wires them.
struct WithVault {
    mgr: McpManager,
    vault: Arc<dyn IVaultPort>,
    path: PathBuf,
    _dir: TempDir,
}

fn make_with_vault() -> WithVault {
    init_i18n_once();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    let vault: Arc<dyn IVaultPort> =
        Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let client: Arc<dyn IMcpClientPort> =
        Arc::new(McpClientFileAdapter::new(path.clone()).unwrap().with_vault(vault.clone()));
    WithVault { mgr: McpManager::new(client).with_vault(vault.clone()), vault, path, _dir: dir }
}

fn stdio(name: &str, enabled: bool) -> McpServerConfig {
    McpServerConfig {
        name: name.to_string(),
        transport: McpTransport::Stdio,
        command: Some("cmd".to_string()),
        args: vec![],
        env: HashMap::new(),
        url: None,
        token_secret: None,
        enabled,
    }
}

fn remote(name: &str, url: &str) -> McpServerConfig {
    McpServerConfig {
        name: name.to_string(),
        transport: McpTransport::Http,
        command: None,
        args: vec![],
        env: HashMap::new(),
        url: Some(url.to_string()),
        token_secret: None,
        enabled: true,
    }
}

#[tokio::test]
async fn add_list_remove_via_manager() {
    let (mgr, _dir) = make_manager();
    mgr.add_server(stdio("n1", true), None).await.unwrap();

    assert_eq!(mgr.list_servers().len(), 1);
    mgr.remove_server("n1").await.unwrap();
    assert!(mgr.list_servers().is_empty());
}

#[tokio::test]
async fn list_all_tools_empty_when_no_servers() {
    let (mgr, _dir) = make_manager();
    let tools = mgr.list_all_tools().await.unwrap();
    assert!(tools.is_empty());
}

#[tokio::test]
async fn call_tool_unknown_server_errors() {
    let (mgr, _dir) = make_manager();
    let r = mgr.call_tool("missing", "x", &serde_json::json!({})).await;
    assert!(r.is_err());
    let err = r.unwrap_err();
    assert!(err.contains("미등록") || err.contains("missing"), "got: {err}");
}

#[tokio::test]
async fn list_tools_disabled_server_errors() {
    let (mgr, _dir) = make_manager();
    let mut off = stdio("off", false);
    off.command = Some("nonexistent-cmd".to_string());
    mgr.add_server(off, None).await.unwrap();
    let r = mgr.list_tools("off").await;
    assert!(r.is_err());
    assert!(r.unwrap_err().contains("비활성"));
}

// ── A remote server's token ──────────────────────────────────────────────

#[tokio::test]
async fn a_token_is_kept_in_the_vault_never_in_the_config() {
    let t = make_with_vault();
    t.mgr
        .add_server(remote("malkgom", "http://127.0.0.1:9/mcp"), Some("  tok-123  ".to_string()))
        .await
        .unwrap();

    let listed = t.mgr.list_servers();
    assert_eq!(listed[0].token_secret.as_deref(), Some("system:mcp:malkgom:token"));
    assert_eq!(t.vault.get_secret("system:mcp:malkgom:token").as_deref(), Some("tok-123"));
    // What the settings screen is listed, and what sits on disk, name the vault key only.
    let listed_json = serde_json::to_string(&listed).unwrap();
    assert!(listed_json.contains("\"tokenSecret\":\"system:mcp:malkgom:token\""), "{listed_json}");
    assert!(!listed_json.contains("tok-123"));
    let on_disk = std::fs::read_to_string(&t.path).unwrap();
    assert!(!on_disk.contains("tok-123"), "{on_disk}");
}

#[tokio::test]
async fn registering_again_without_a_token_keeps_it_and_a_new_one_replaces_it() {
    let t = make_with_vault();
    t.mgr.add_server(remote("m", "http://127.0.0.1:9/mcp"), Some("tok-1".to_string())).await.unwrap();

    // A new address, no token given — still logged in.
    t.mgr.add_server(remote("m", "http://127.0.0.1:10/mcp"), None).await.unwrap();
    let listed = t.mgr.list_servers();
    assert_eq!(listed[0].url.as_deref(), Some("http://127.0.0.1:10/mcp"));
    assert_eq!(listed[0].token_secret.as_deref(), Some("system:mcp:m:token"));
    assert_eq!(t.vault.get_secret("system:mcp:m:token").as_deref(), Some("tok-1"));

    t.mgr.add_server(remote("m", "http://127.0.0.1:10/mcp"), Some("tok-2".to_string())).await.unwrap();
    assert_eq!(t.vault.get_secret("system:mcp:m:token").as_deref(), Some("tok-2"));
}

#[tokio::test]
async fn a_server_without_a_token_holds_none() {
    let t = make_with_vault();
    t.mgr.add_server(remote("open", "http://127.0.0.1:9/mcp"), Some("   ".to_string())).await.unwrap();
    assert_eq!(t.mgr.list_servers()[0].token_secret, None);
    assert_eq!(t.vault.get_secret("system:mcp:open:token"), None);
}

#[tokio::test]
async fn a_stdio_server_takes_no_token() {
    let t = make_with_vault();
    let err = t.mgr.add_server(stdio("local", true), Some("tok".to_string())).await.unwrap_err();
    assert!(err.contains("remote server"), "{err}");
    assert!(t.mgr.list_servers().is_empty());
    assert_eq!(t.vault.get_secret("system:mcp:local:token"), None);

    // A remote server turned into a stdio one lets its token go.
    t.mgr.add_server(remote("x", "http://127.0.0.1:9/mcp"), Some("tok".to_string())).await.unwrap();
    t.mgr.add_server(stdio("x", true), None).await.unwrap();
    assert_eq!(t.mgr.list_servers()[0].token_secret, None);
    assert_eq!(t.vault.get_secret("system:mcp:x:token"), None);
}

#[tokio::test]
async fn removing_a_server_forgets_its_token() {
    let t = make_with_vault();
    t.mgr.add_server(remote("m", "http://127.0.0.1:9/mcp"), Some("tok".to_string())).await.unwrap();
    t.mgr.remove_server("m").await.unwrap();
    assert_eq!(t.vault.get_secret("system:mcp:m:token"), None);
}

#[tokio::test]
async fn without_a_vault_a_token_is_refused_not_written_elsewhere() {
    let (mgr, dir) = make_manager();
    let err = mgr
        .add_server(remote("m", "http://127.0.0.1:9/mcp"), Some("tok-x".to_string()))
        .await
        .unwrap_err();
    assert!(err.contains("vault"), "{err}");
    assert!(mgr.list_servers().is_empty());
    let on_disk = std::fs::read_to_string(dir.path().join("mcp.json")).unwrap_or_default();
    assert!(!on_disk.contains("tok-x"));
}

/// Small HTTP server on 127.0.0.1: records each request's head, answers 401.
fn refusing_server() -> (String, Arc<Mutex<Vec<String>>>) {
    scripted_server(|_| 401)
}

/// Small HTTP server on 127.0.0.1: records each request's head and answers it with the status
/// `answer` gives for its method (an empty JSON body, then closes).
fn scripted_server(answer: fn(&str) -> u16) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let heads = Arc::new(Mutex::new(Vec::new()));
    let seen = heads.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(4) {
            let Ok(mut stream) = stream else { break };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut method = String::new();
            // Read the head and the body it announces, so the client sees a clean answer.
            loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let head = text[..end].to_string();
                    let len = head
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        method = head.split_whitespace().next().unwrap_or("").to_string();
                        seen.lock().unwrap().push(head);
                        break;
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 {} Scripted\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
                answer(&method)
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    (url, heads)
}

fn authorization_of(head: &str) -> Option<String> {
    head.lines().find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.eq_ignore_ascii_case("authorization").then(|| value.trim().to_string())
    })
}

#[tokio::test]
async fn the_token_rides_on_the_request_and_a_refusal_says_what_to_do() {
    let t = make_with_vault();
    let (url, heads) = refusing_server();
    t.mgr.add_server(remote("m", &url), Some("tok-123".to_string())).await.unwrap();

    let err = t.mgr.list_tools("m").await.unwrap_err();
    assert!(err.contains("401") && err.contains("turned the token down"), "{err}");
    assert!(!err.contains("tok-123"), "the error must not carry the token: {err}");
    let heads = heads.lock().unwrap();
    assert!(!heads.is_empty(), "the server saw no request");
    assert_eq!(authorization_of(&heads[0]).as_deref(), Some("Bearer tok-123"), "{}", heads[0]);
}

#[tokio::test]
async fn with_no_token_nothing_is_sent_and_the_refusal_asks_for_one() {
    let t = make_with_vault();
    let (url, heads) = refusing_server();
    t.mgr.add_server(remote("m", &url), None).await.unwrap();

    let err = t.mgr.list_tools("m").await.unwrap_err();
    assert!(err.contains("wants a login"), "{err}");
    let heads = heads.lock().unwrap();
    assert!(!heads.is_empty(), "the server saw no request");
    assert_eq!(authorization_of(&heads[0]), None, "{}", heads[0]);
}

#[tokio::test]
async fn a_token_gone_from_the_vault_says_so() {
    let t = make_with_vault();
    t.mgr.add_server(remote("m", "http://127.0.0.1:9/mcp"), Some("tok".to_string())).await.unwrap();
    t.vault.delete_secret("system:mcp:m:token");

    let err = t.mgr.list_tools("m").await.unwrap_err();
    assert!(err.contains("not in the vault"), "{err}");
}

fn methods(heads: &[String]) -> Vec<String> {
    heads.iter().map(|h| h.split_whitespace().next().unwrap_or("").to_string()).collect()
}

/// The settings screen takes just an address. A server that turns the initialize POST down the
/// way an old HTTP+SSE server does (405) is tried again as one — a GET for its stream — with the
/// same token.
#[tokio::test]
async fn an_address_that_refuses_the_post_like_an_old_server_is_tried_as_one() {
    let t = make_with_vault();
    let (url, heads) = scripted_server(|method| if method == "POST" { 405 } else { 404 });
    t.mgr.add_server(remote("old", &url), Some("tok-9".to_string())).await.unwrap();

    let err = t.mgr.list_tools("old").await.unwrap_err();
    assert!(err.contains("old HTTP+SSE"), "{err}");
    let heads = heads.lock().unwrap();
    assert_eq!(methods(&heads), vec!["POST", "GET"], "{heads:?}");
    assert_eq!(authorization_of(&heads[1]).as_deref(), Some("Bearer tok-9"), "{}", heads[1]);
}

/// A login refusal is not a sign of the old transport — no second try.
#[tokio::test]
async fn a_login_refusal_is_not_taken_for_an_old_server() {
    let t = make_with_vault();
    let (url, heads) = refusing_server();
    t.mgr.add_server(remote("m", &url), None).await.unwrap();

    let _ = t.mgr.list_tools("m").await.unwrap_err();
    assert_eq!(methods(&heads.lock().unwrap()), vec!["POST"]);
}

/// A small Streamable-HTTP MCP server on 127.0.0.1 with two tools — `get_sites` and `get_sales` — that answers a tool it does
/// not have the way 맑곰 (laravel/mcp) does: HTTP 400 with a JSON-RPC error.
fn fake_mcp_server() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().take(40) {
            let Ok(mut stream) = stream else { break };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            let body = loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break String::new();
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string();
                    }
                }
            };
            let req: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
            let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let (status, reply) = match req["method"].as_str().unwrap_or("") {
                "initialize" => (200, serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {
                    "protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "0"}}})),
                "tools/list" => (200, serde_json::json!({"jsonrpc": "2.0", "id": id, "result": {"tools": [
                    {"name": "get_sites", "description": "The sites.", "inputSchema": {"type": "object", "properties": {}}},
                    {"name": "get_sales", "description": "Sales by day.", "inputSchema": {"type": "object", "properties": {"from": {"type": "string"}}}}]}})),
                "tools/call" if req["params"]["name"] == "get_sites" => (200, serde_json::json!({"jsonrpc": "2.0", "id": id,
                    "result": {"content": [{"type": "text", "text": "본사"}], "isError": false}})),
                "tools/call" => (400, serde_json::json!({"jsonrpc": "2.0", "id": id,
                    "error": {"code": -32602, "message": format!("Tool [{}] not found.", req["params"]["name"].as_str().unwrap_or(""))}})),
                _ => (202, serde_json::Value::Null), // a notification
            };
            let text = if reply.is_null() { String::new() } else { reply.to_string() };
            let _ = stream.write_all(format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                text.len()
            ).as_bytes());
        }
    });
    url
}

#[tokio::test]
async fn the_server_list_carries_each_servers_tools_and_no_env() {
    let t = make_with_vault();
    let url = fake_mcp_server();
    t.mgr.add_server(remote("맑곰", &url), Some("tok".to_string())).await.unwrap();
    let mut local = stdio("local", true);
    local.env.insert("API_KEY".to_string(), "secret-value".to_string());
    local.enabled = false; // nothing to spawn in a test
    t.mgr.add_server(local, None).await.unwrap();

    let listed = serde_json::Value::Array(t.mgr.servers_with_tools().await);
    let text = listed.to_string();
    assert!(!text.contains("secret-value") && !text.contains("API_KEY"), "env must not be listed: {text}");
    let malkgom = listed.as_array().unwrap().iter().find(|s| s["name"] == "맑곰").unwrap();
    // Names here; descriptions and arguments in one place — the action index (`mcp.<server>`).
    assert_eq!(malkgom["tools"], serde_json::json!(["get_sites", "get_sales"]));
    assert_eq!(malkgom["module"], "mcp.맑곰");
}

#[tokio::test]
async fn a_tool_name_the_server_lacks_is_answered_with_the_ones_it_has() {
    let t = make_with_vault();
    let url = fake_mcp_server();
    t.mgr.add_server(remote("맑곰", &url), None).await.unwrap();

    let ok = t.mgr.call_tool("맑곰", "get_sites", &serde_json::json!({})).await.unwrap();
    assert_eq!(ok["content"][0]["text"], "본사");

    let err = t.mgr.call_tool("맑곰", "get_menus", &serde_json::json!({})).await.unwrap_err();
    assert!(err.contains("no tool `get_menus`") && err.contains("get_sites, get_sales") && err.contains("get_action_schema(module: \"mcp.맑곰\""), "{err}");
}

#[tokio::test]
async fn an_unreachable_server_says_why_in_place_of_its_tools() {
    let t = make_with_vault();
    let (url, _) = refusing_server();
    t.mgr.add_server(remote("down", &url), None).await.unwrap();
    let listed = t.mgr.servers_with_tools().await;
    assert!(listed[0].get("tools").is_none());
    assert!(listed[0]["error"].as_str().unwrap().contains("401"), "{}", listed[0]);
}

/// An outside server's tools ride the action index the modules' actions are in (owner, 2026-11-28: "이거 우리 원래 로직있지않나
/// 태그랑 디스크립션"): found by what they do, described by get_action_schema, called through mcp_call — the module rung's steps.
#[tokio::test]
async fn an_outside_servers_tools_are_found_and_described_like_module_actions() {
    use firebat_core::managers::ai::action_catalog::ModuleActionCatalog;
    use firebat_core::managers::capability::CapabilityManager;
    use firebat_core::managers::module::ModuleManager;
    use firebat_core::ports::{IEmbedderCachePort, IEmbedderPort, ILogPort, ISandboxPort, IStoragePort};
    use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
    use firebat_infra::adapters::embedder_cache::FileEmbedderCacheAdapter;
    use firebat_infra::adapters::log::ConsoleLogAdapter;
    use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
    use firebat_infra::adapters::storage::LocalStorageAdapter;

    init_i18n_once();
    let dir = tempfile::tempdir().unwrap();
    let client: Arc<dyn IMcpClientPort> = Arc::new(McpClientFileAdapter::new(dir.path().join("mcp.json")).unwrap());
    let mcp = Arc::new(McpManager::new(client));
    mcp.add_server(remote("맑곰", &fake_mcp_server()), None).await.unwrap();

    let sandbox: Arc<dyn ISandboxPort> = Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let module = Arc::new(ModuleManager::new(sandbox, storage.clone(), vault.clone()));
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let capability = Arc::new(CapabilityManager::new(storage, vault, log));
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let cache: Arc<dyn IEmbedderCachePort> = Arc::new(FileEmbedderCacheAdapter::new(dir.path()));
    let catalog = ModuleActionCatalog::new(module, embedder, cache, capability).with_mcp(mcp.clone());

    // Found: a row of module mcp.맑곰, called through mcp_call, with its schema call assembled.
    let rows = catalog.search("sales by day", None, 5).await.unwrap();
    let row = rows.iter().find(|r| r["action"] == "get_sales").unwrap_or_else(|| panic!("get_sales not found: {rows:?}"));
    assert_eq!(row["module"], "mcp.맑곰");
    assert_eq!(row["tool"], "mcp_call");
    assert_eq!(row["schemaCall"]["arguments"], serde_json::json!({"module": "mcp.맑곰", "action": "get_sales"}));
    assert!(catalog.module_enabled("mcp.맑곰"), "no module by that name — the server's own on/off decides");

    // Described: its arguments, and the call to make.
    let schema = catalog.schema("mcp.맑곰", "get_sales").await.expect("schema");
    assert_eq!(schema["tool"], "mcp_call");
    assert_eq!(schema["call"]["tool"], "mcp_call");
    assert_eq!(schema["call"]["arguments"]["server"], "맑곰");
    assert_eq!(schema["call"]["arguments"]["tool"], "get_sales");
    assert_eq!(schema["params"]["from"], "string");
    // A tool that takes nothing says so — not "parameter docs are not available".
    let sites = catalog.schema("mcp.맑곰", "get_sites").await.expect("schema");
    assert_eq!(sites["paramsNote"], "Takes no arguments.");

    // And the call the schema assembled works.
    let ok = mcp.call_tool("맑곰", "get_sites", &serde_json::json!({})).await.unwrap();
    assert_eq!(ok["content"][0]["text"], "본사");
}

/// A module written a moment ago is described by name at once — the index's debounce does not answer for it (2026-11-28: a
/// model wrote user/modules/series-stats, asked for its schema 34 seconds later and was told the module would never be
/// found, so it went round through `execute`). And a module named in a search comes back even when the wide ranking scored
/// its rows under the page — there, under twelve rows whose names carry the query.
#[tokio::test]
async fn a_module_written_a_moment_ago_is_described_at_once_and_found_when_named() {
    use firebat_core::managers::ai::action_catalog::ModuleActionCatalog;
    use firebat_core::managers::capability::CapabilityManager;
    use firebat_core::managers::module::ModuleManager;
    use firebat_core::ports::{IEmbedderCachePort, IEmbedderPort, ILogPort, ISandboxPort, IStoragePort};
    use firebat_infra::adapters::embedder::stub::StubEmbedderAdapter;
    use firebat_infra::adapters::embedder_cache::FileEmbedderCacheAdapter;
    use firebat_infra::adapters::log::ConsoleLogAdapter;
    use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
    use firebat_infra::adapters::storage::LocalStorageAdapter;

    init_i18n_once();
    let dir = tempfile::tempdir().unwrap();
    let write_module = |name: &str, config: serde_json::Value| {
        let m = dir.path().join("user").join("modules").join(name);
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join("config.json"), config.to_string()).unwrap();
        std::fs::write(m.join("main.py"), "print('{\"success\": True}')\n").unwrap();
    };
    // Twelve actions whose names carry the query — they fill the wide window.
    let lunch: Vec<String> = (1..=12).map(|i| format!("lunch-menu-{i}")).collect();
    write_module("noise", serde_json::json!({
        "name": "noise", "runtime": "python", "description": "lunch menu lookups",
        "input": {"type": "object", "required": ["action"], "properties": {
            "action": {"type": "string", "enum": lunch, "description": "lunch menu"}}}
    }));

    let sandbox: Arc<dyn ISandboxPort> = Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
    let vault: Arc<dyn IVaultPort> = Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
    let module = Arc::new(ModuleManager::new(sandbox, storage.clone(), vault.clone()));
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let capability = Arc::new(CapabilityManager::new(storage, vault, log));
    let embedder: Arc<dyn IEmbedderPort> = Arc::new(StubEmbedderAdapter::new());
    let cache: Arc<dyn IEmbedderCachePort> = Arc::new(FileEmbedderCacheAdapter::new(dir.path()));
    let catalog = ModuleActionCatalog::new(module, embedder, cache, capability);

    // The index is built before the module exists; a name that is nowhere is said to be nowhere.
    assert!(catalog.has_module("noise").await);
    assert!(!catalog.has_module_now("series-stats").await);
    let absent = catalog.unindexed_module_response("series-stats", vec![]).await;
    assert!(absent["error"].as_str().unwrap().starts_with("No module is named 'series-stats'"), "{absent}");

    // Written now — and described at once, by its input, called through run_module_action.
    write_module("series-stats", serde_json::json!({
        "name": "series-stats", "runtime": "python", "description": "Equal-length numeric series in -> correlation",
        "tags": ["상관계수"],
        "input": {"type": "object", "required": ["action", "series"], "properties": {
            "action": {"type": "string", "enum": ["correlate"]},
            "series": {"type": "object", "description": "[correlate] name -> numbers"}}}
    }));
    assert!(!catalog.has_module("series-stats").await, "the debounce has not looked yet");
    assert!(catalog.has_module_now("series-stats").await, "looked for now, not at the end of the debounce");
    let schema = catalog.schema("series-stats", "correlate").await.expect("derived schema");
    assert_eq!(schema["tool"], "run_module_action");
    assert_eq!(schema["call"]["arguments"]["module"], "series-stats");

    // Named in a search for words only the noise names carry: its own row still comes back.
    let rows = catalog.search("lunch menu", Some("series-stats"), 3).await.unwrap();
    assert!(rows.iter().any(|r| r["module"] == "series-stats"), "the named module's row: {rows:?}");
}

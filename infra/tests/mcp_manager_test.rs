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

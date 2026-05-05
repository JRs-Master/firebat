//! gatherSystemContext — 옛 TS prompt-builder.ts 의 동적 컨텍스트 build 부분 Rust port.
//!
//! 시스템 프롬프트에 주입할 동적 정보 합성:
//! - 등록된 system module list + 각 description (config.json 스캔)
//! - 등록된 user module list
//! - 외부 MCP 서버 list (활성 서버만)
//!
//! 옛 TS hardcoding 7 패턴 준수:
//! - 일반 메커니즘 — config.json 스캔으로 동적 description 자동 주입.
//! - sysmod 추가 시 코드 변경 0 (config.json 만 작성하면 프롬프트 자동 반영).
//! - 모듈명 / capability hardcode 0 — 매니저에서 동적 list.

use std::sync::Arc;

use crate::managers::mcp::McpManager;
use crate::managers::module::ModuleManager;

pub struct SystemContextGatherer {
    module: Arc<ModuleManager>,
    mcp: Arc<McpManager>,
}

impl SystemContextGatherer {
    pub fn new(module: Arc<ModuleManager>, mcp: Arc<McpManager>) -> Self {
        Self { module, mcp }
    }

    /// 시스템 컨텍스트 마크다운 합성 — PromptBuilder.build() 에 extra_context 로 전달.
    pub async fn gather(&self) -> String {
        let mut sections: Vec<String> = Vec::new();

        // 1. system modules — sysmod_<name> 도구로 호출.
        // 비활성 모듈 (Vault settings.enabled = false) 은 제외 — LLM 한테 활성 도구만 노출.
        let system_mods = self.module.list_system_modules().await;
        let active_sys: Vec<_> = system_mods.into_iter().filter(|e| e.enabled).collect();
        if !active_sys.is_empty() {
            let mut s = String::from("## 등록된 시스템 모듈 (sysmod_* 도구로 호출)\n");
            for entry in active_sys {
                // capability 는 별도 config.json 조회 (옵션 — 없으면 description 만)
                let capability = self
                    .module
                    .get_module_config("system", &entry.name)
                    .await
                    .and_then(|cfg| cfg.get("capability").and_then(|v| v.as_str()).map(String::from))
                    .map(|c| format!(" [capability: {}]", c))
                    .unwrap_or_default();
                let desc = if entry.description.is_empty() {
                    "(설명 없음)".to_string()
                } else {
                    entry.description.clone()
                };
                s.push_str(&format!(
                    "- **sysmod_{}**{}: {}\n",
                    entry.name.replace('-', "_"),
                    capability,
                    desc
                ));
            }
            sections.push(s);
        }

        // 2. user modules — EXECUTE pipeline step 또는 직접 sandbox 호출.
        let user_mods = self.module.list_user_modules().await;
        let active_user: Vec<_> = user_mods.into_iter().filter(|e| e.enabled).collect();
        if !active_user.is_empty() {
            let mut s = String::from("## 등록된 사용자 모듈 (user/modules)\n");
            for entry in active_user {
                let desc = if entry.description.is_empty() {
                    "(설명 없음)".to_string()
                } else {
                    entry.description.clone()
                };
                s.push_str(&format!("- **{}**: {}\n", entry.name, desc));
            }
            sections.push(s);
        }

        // 3. MCP 외부 서버
        let mcp_servers = self.mcp.list_servers();
        let active_mcp: Vec<_> = mcp_servers.into_iter().filter(|s| s.enabled).collect();
        if !active_mcp.is_empty() {
            let mut s = String::from("## MCP 외부 서버 (mcp_call 도구로 호출)\n");
            for srv in active_mcp {
                s.push_str(&format!(
                    "- **{}** ({:?}): {}\n",
                    srv.name,
                    srv.transport,
                    srv.url.as_deref().unwrap_or(srv.command.as_deref().unwrap_or(""))
                ));
            }
            sections.push(s);
        }

        sections.join("\n")
    }
}

#[cfg(all(test, feature = "infra-tests"))]
mod tests {
    use super::*;
    use firebat_infra::adapters::mcp_client::McpClientFileAdapter;
    use firebat_infra::adapters::sandbox::ProcessSandboxAdapter;
    use firebat_infra::adapters::storage::LocalStorageAdapter;
    use firebat_infra::adapters::vault::SqliteVaultAdapter;
    use crate::ports::{IMcpClientPort, ISandboxPort, IStoragePort, IVaultPort};
    use tempfile::tempdir;

    async fn setup() -> (SystemContextGatherer, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        let sandbox: Arc<dyn ISandboxPort> =
            Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
        let mcp_client: Arc<dyn IMcpClientPort> =
            Arc::new(McpClientFileAdapter::new(dir.path().join("mcp.json")).unwrap());

        let module = Arc::new(ModuleManager::new(sandbox, storage, vault));
        let mcp = Arc::new(McpManager::new(mcp_client));
        (SystemContextGatherer::new(module, mcp), dir)
    }

    #[tokio::test]
    async fn empty_workspace_returns_empty_string() {
        let (g, _dir) = setup().await;
        let ctx = g.gather().await;
        assert!(ctx.is_empty());
    }

    #[tokio::test]
    async fn system_module_with_description_appears() {
        let (g, dir) = setup().await;
        // system/modules/test-mod/config.json 박음
        let mod_dir = dir.path().join("system/modules/test-mod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(
            mod_dir.join("config.json"),
            r#"{"name": "test-mod", "description": "테스트 모듈입니다", "capability": "web-scrape"}"#,
        )
        .unwrap();

        let ctx = g.gather().await;
        assert!(ctx.contains("sysmod_test_mod"));
        assert!(ctx.contains("테스트 모듈입니다"));
        assert!(ctx.contains("web-scrape"));
    }

    #[tokio::test]
    async fn module_without_description_falls_back() {
        let (g, dir) = setup().await;
        let mod_dir = dir.path().join("system/modules/no-desc");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("config.json"), r#"{"name": "no-desc"}"#).unwrap();
        let ctx = g.gather().await;
        assert!(ctx.contains("(설명 없음)"));
    }
}

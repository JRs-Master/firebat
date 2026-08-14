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

        // 1. System modules are NOT listed here.
        //
        // They were, as name + first clause + capability, and every line of it was a lossy copy of
        // something already in the request: each sysmod ships as its own tool, whose description
        // carries the module's full text, its tags, its capability and its required secrets. The
        // copy cost 2,905 chars a turn to say less (measured 2026-08-15) — and cost more than
        // that, because truncating to a first clause is a failure mode the original does not have:
        // descriptions that opened with a provider's name reached the model saying nothing about
        // what the module does, and module selection quietly died for five of them (2026-08-13).
        //
        // Which module answers a request is decided by `search_module_actions`, whose rows carry
        // the module, its capability and the user's preference rank — at the moment of choosing,
        // where a comparison is actually being made.

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

// Tests 이관 — `infra/tests/ai_system_context_test.rs` (integration test).

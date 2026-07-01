//! DynamicToolRegistry — sysmod_* / mcp_* 도구 자동 등록 + 60초 cache.
//!
//! Phase B-post audit E3 (2026-05-06) 설정 — 옛 TS `buildToolDefinitions` 의 동적 빌드 부분
//! Rust port. 정적 도구 (`tool_registry::register_core_tools`) 와 분리:
//! - **정적**: page / storage / schedule / media / conversation / entity / episodic 등 핸들러
//!   (부팅 시 1회 등록 — `register_core_tools`)
//! - **동적**: sysmod_* (`system/modules/<name>/config.json` 스캔) + mcp_* (외부 MCP 서버 list)
//!   (매 LLM 호출 시 refresh, 60초 cache)
//!
//! 패턴:
//! 1. AiManager.process_with_tools_opts 시작 시 `dynamic.refresh().await` 호출
//! 2. 60초 안이면 즉시 return (cache hit)
//! 3. 60초 지났으면 sysmod scan + mcp list → ToolManager 에 register/unregister
//! 4. 그 후 `build_tool_definitions()` (sync ToolManager.list()) 호출 — 정적 + 동적 통합
//!
//! Sysmod 활성/비활성 토글 — `ModuleManager.is_enabled(name)` 검사. 비활성 시 unregister.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

use crate::managers::mcp::McpManager;
use crate::managers::module::ModuleManager;
use crate::managers::tool::{make_handler, ToolDefinition, ToolListFilter, ToolManager};
use crate::ports::{InfraResult, SandboxExecuteOpts};
use crate::utils::grounding::{parse_grounding, GroundedParam};

/// Cache TTL — 옛 TS 60초 1:1.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// 동적 도구 source 식별자 — ToolManager.unregister 시 filter 용.
const SOURCE_SYSMOD: &str = "sysmod";
const SOURCE_MCP: &str = "mcp";

pub struct DynamicToolRegistry {
    tools: Arc<ToolManager>,
    module: Arc<ModuleManager>,
    mcp: Arc<McpManager>,
    /// 마지막 refresh 시각. None = 아직 refresh 안 함.
    last_refresh: Mutex<Option<Instant>>,
    /// L1 grounding 선언 — tool_name(`sysmod_<name>`) → grounded params (모듈 config 의 `grounding`).
    /// refresh 마다 config 에서 재구성. FC 경로(ai.rs 도구 루프)가 dispatch 전 `grounding_for` 로 조회해
    /// `check_grounding` 강제 — MCP 경로(mcp_server `state.grounding`) 와 대칭, 같은 pure 헬퍼 공유 (#8-2).
    grounding: RwLock<HashMap<String, Vec<GroundedParam>>>,
}

impl DynamicToolRegistry {
    pub fn new(tools: Arc<ToolManager>, module: Arc<ModuleManager>, mcp: Arc<McpManager>) -> Self {
        Self {
            tools,
            module,
            mcp,
            last_refresh: Mutex::new(None),
            grounding: RwLock::new(HashMap::new()),
        }
    }

    /// FC 경로가 dispatch 전 조회 — 이 도구에 선언된 grounded params (없으면 None).
    pub async fn grounding_for(&self, tool: &str) -> Option<Vec<GroundedParam>> {
        let map = self.grounding.read().await;
        map.get(tool).cloned()
    }

    /// 60초 cache 검사 후 sysmod_* / mcp_* 동적 도구 재등록. cache hit 시 즉시 return.
    pub async fn refresh(&self) {
        // cache 검사 — 60초 안이면 skip
        {
            let last = self.last_refresh.lock().await;
            if let Some(t) = *last {
                if t.elapsed() < CACHE_TTL {
                    return;
                }
            }
        }

        // 1. 옛 sysmod_* / mcp_* 도구 모두 unregister (refresh 마다 깨끗이)
        for def in self.tools.list(&ToolListFilter { source: Some(SOURCE_SYSMOD.to_string()), name_prefix: None }) {
            self.tools.unregister(&def.name);
            self.tools.unregister_handler(&def.name);
        }
        for def in self.tools.list(&ToolListFilter { source: Some(SOURCE_MCP.to_string()), name_prefix: None }) {
            self.tools.unregister(&def.name);
            self.tools.unregister_handler(&def.name);
        }
        // grounding 맵도 refresh 마다 재구성 (비활성 모듈 stale 선언 제거).
        self.grounding.write().await.clear();

        // 2. sysmod scan + register
        let modules = self.module.list_system_modules().await;
        for entry in modules {
            // 활성화 토글 검사 — Vault `system:module:<name>:settings.enabled` (default true).
            if !self.module.is_enabled(&entry.name) {
                continue;
            }
            // config.json 의 input schema 추출
            let Some(config) = self.module.get_module_config("system", &entry.name).await else {
                continue;
            };
            let parameters = config
                .get("input")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            let tool_name = format!("sysmod_{}", entry.name);
            let description = entry.description.clone();
            // L1 grounding — config 의 `grounding` 선언을 이 도구에 매핑 (있을 때만). MCP 등록 패턴과 대칭.
            let g = parse_grounding(&config);
            if !g.is_empty() {
                self.grounding.write().await.insert(tool_name.clone(), g);
            }
            self.tools.register(ToolDefinition {
                name: tool_name.clone(),
                description,
                parameters,
                source: SOURCE_SYSMOD.to_string(),
            });
            // 핸들러 — ModuleManager.run() 위임. 옛 TS sysmod 호출 패턴 1:1.
            let module_mgr = self.module.clone();
            let module_name = entry.name.clone();
            let handler = make_handler(move |args: serde_json::Value| {
                let mgr = module_mgr.clone();
                let name = module_name.clone();
                async move {
                    let target = format!("system/modules/{}/index.mjs", name);
                    let result = mgr.execute(&target, &args, &SandboxExecuteOpts::default()).await?;
                    Ok(serde_json::to_value(&result)
                        .unwrap_or(serde_json::Value::Null))
                }
            });
            self.tools.register_handler(&tool_name, handler);
        }

        // 3. mcp scan + register — 외부 MCP 서버 list → 각 서버별 list_tools 순회
        if let Ok(all_tools) = self.mcp.list_all_tools().await {
            for info in all_tools {
                let tool_name = format!("mcp_{}_{}", info.server, info.name);
                let parameters = info
                    .input_schema
                    .clone()
                    .unwrap_or_else(|| serde_json::json!({}));
                self.tools.register(ToolDefinition {
                    name: tool_name.clone(),
                    description: info.description.clone(),
                    parameters,
                    source: SOURCE_MCP.to_string(),
                });
                let mcp_mgr = self.mcp.clone();
                let server = info.server.clone();
                let inner_name = info.name.clone();
                let handler = make_handler(move |args: serde_json::Value| {
                    let mgr = mcp_mgr.clone();
                    let server = server.clone();
                    let name = inner_name.clone();
                    async move {
                        mgr.call_tool(&server, &name, &args).await
                    }
                });
                self.tools.register_handler(&tool_name, handler);
            }
        }

        // 4. cache 갱신
        let mut last = self.last_refresh.lock().await;
        *last = Some(Instant::now());
    }

    /// 강제 invalidation — sysmod 활성/비활성 토글 또는 외부 MCP 서버 추가/제거 시 호출.
    pub async fn invalidate(&self) {
        let mut last = self.last_refresh.lock().await;
        *last = None;
    }
}

/// `_unused` 경고 회피 — InfraResult import 만 설정된 상태이지만 향후 확장 시 사용.
#[allow(dead_code)]
fn _placeholder() -> InfraResult<()> {
    Ok(())
}

//! ToolManager — AI 도구 등록 / 조회 / dispatch.
//!
//! 옛 TS ToolManager (`core/managers/tool-manager.ts`) Rust 재구현 (간소화).
//! Phase B 단계: 메모리 registry + filter. Tool 실행 자체는 매니저별 dispatch — 본 매니저는
//! 메타데이터 + lookup 만 담당. AiManager 변환 시 통합.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::ports::InfraResult;

/// 도구 dispatch handler — args 받아 결과 반환. AiManager 가 등록 → 도구 호출 시 호출.
pub type ToolHandler = Arc<
    dyn Fn(
            serde_json::Value,
        )
            -> Pin<Box<dyn Future<Output = InfraResult<serde_json::Value>> + Send>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON schema (input_schema) — gemini / openai / anthropic 공통.
    #[serde(default)]
    pub parameters: serde_json::Value,
    /// 도구 source — 'core' / 'render' / 'sysmod' / 'mcp' 등 분류 (filter 용).
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolListFilter {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub name_prefix: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ToolStats {
    pub total: usize,
    pub by_source: HashMap<String, usize>,
}

pub struct ToolManager {
    state: Mutex<ToolState>,
}

#[derive(Default)]
struct ToolState {
    tools: HashMap<String, ToolDefinition>,
    /// 활성 plan state — conversation_id → JSON. Plan follow-through 패턴.
    active_plan: HashMap<String, serde_json::Value>,
    /// 도구 핸들러 (등록·dispatch 용). 옛 TS executeToolCall switch 잔여 분기 폐지 (Step 4) —
    /// Rust 처음부터 ToolManager dispatch 단일 source.
    handlers: HashMap<String, ToolHandler>,
}

impl ToolManager {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ToolState::default()),
        }
    }

    /// 단일 도구 등록 (이미 있으면 덮어씀).
    pub fn register(&self, def: ToolDefinition) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.tools.insert(def.name.clone(), def);
    }

    /// 여러 도구 일괄 등록.
    pub fn register_many(&self, defs: Vec<ToolDefinition>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        for d in defs {
            state.tools.insert(d.name.clone(), d);
        }
    }

    /// 도구 제거. 이미 없으면 false.
    pub fn unregister(&self, name: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.tools.remove(name).is_some()
    }

    pub fn get_definition(&self, name: &str) -> Option<ToolDefinition> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.tools.get(name).cloned()
    }

    /// 필터 적용 list.
    pub fn list(&self, filter: &ToolListFilter) -> Vec<ToolDefinition> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut out: Vec<ToolDefinition> = state
            .tools
            .values()
            .filter(|t| {
                filter
                    .source
                    .as_ref()
                    .map(|s| t.source == *s)
                    .unwrap_or(true)
            })
            .filter(|t| {
                filter
                    .name_prefix
                    .as_ref()
                    .map(|p| t.name.starts_with(p))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn stats(&self) -> ToolStats {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut by_source: HashMap<String, usize> = HashMap::new();
        for t in state.tools.values() {
            *by_source.entry(t.source.clone()).or_insert(0) += 1;
        }
        ToolStats {
            total: state.tools.len(),
            by_source,
        }
    }

    // ─────── Active plan state — Plan follow-through ───────

    pub fn get_active_plan(&self, conversation_id: &str) -> Option<serde_json::Value> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.active_plan.get(conversation_id).cloned()
    }

    pub fn set_active_plan(&self, conversation_id: &str, value: Option<serde_json::Value>) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match value {
            Some(v) => {
                state.active_plan.insert(conversation_id.to_string(), v);
            }
            None => {
                state.active_plan.remove(conversation_id);
            }
        }
    }

    pub fn clear_active_plan(&self, conversation_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.active_plan.remove(conversation_id);
    }

    // ─────── 도구 핸들러 — register / dispatch (Step 2/4) ───────

    /// 도구 핸들러 등록. AiManager 부팅 시 정적 27 도구 + 동적 sysmod_* / mcp_* / render_* 모두
    /// 이 메서드로 등록 → executeToolCall switch 잔여 분기 0 (Rust 처음부터 깔끔).
    pub fn register_handler(&self, name: &str, handler: ToolHandler) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.handlers.insert(name.to_string(), handler);
    }

    pub fn unregister_handler(&self, name: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.handlers.remove(name).is_some()
    }

    /// 도구 호출 dispatch — handler 등록되어 있으면 그것 호출, 아니면 명시 에러.
    /// AiManager.process_with_tools 의 도구 호출 결과 처리 단일 진입점.
    pub async fn dispatch(
        &self,
        name: &str,
        args: &serde_json::Value,
    ) -> InfraResult<serde_json::Value> {
        let handler = {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.handlers.get(name).cloned()
        };
        match handler {
            Some(h) => h(args.clone()).await,
            None => Err(format!("도구 핸들러 미등록: {name}")),
        }
    }

    pub fn handler_count(&self) -> usize {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.handlers.len()
    }
}

impl Default for ToolManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(name: &str, source: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("desc {name}"),
            parameters: serde_json::json!({}),
            source: source.to_string(),
        }
    }

    #[test]
    fn register_list_unregister() {
        let mgr = ToolManager::new();
        mgr.register(def("render_table", "render"));
        mgr.register(def("render_chart", "render"));
        mgr.register(def("sysmod_kakao_talk", "sysmod"));

        assert_eq!(mgr.list(&ToolListFilter::default()).len(), 3);
        assert_eq!(
            mgr.list(&ToolListFilter {
                source: Some("render".to_string()),
                ..Default::default()
            })
            .len(),
            2
        );
        assert_eq!(
            mgr.list(&ToolListFilter {
                name_prefix: Some("render_".to_string()),
                ..Default::default()
            })
            .len(),
            2
        );

        assert!(mgr.unregister("render_table"));
        assert!(mgr.get_definition("render_table").is_none());
        assert_eq!(mgr.list(&ToolListFilter::default()).len(), 2);
    }

    #[test]
    fn stats_counts_by_source() {
        let mgr = ToolManager::new();
        mgr.register(def("a", "render"));
        mgr.register(def("b", "render"));
        mgr.register(def("c", "sysmod"));
        let stats = mgr.stats();
        assert_eq!(stats.total, 3);
        assert_eq!(stats.by_source.get("render").copied(), Some(2));
        assert_eq!(stats.by_source.get("sysmod").copied(), Some(1));
    }

    #[test]
    fn active_plan_state() {
        let mgr = ToolManager::new();
        assert!(mgr.get_active_plan("conv-1").is_none());
        mgr.set_active_plan("conv-1", Some(serde_json::json!({"step": 1})));
        let got = mgr.get_active_plan("conv-1").unwrap();
        assert_eq!(got["step"], 1);
        mgr.clear_active_plan("conv-1");
        assert!(mgr.get_active_plan("conv-1").is_none());
    }

    #[tokio::test]
    async fn dispatch_calls_registered_handler() {
        let mgr = ToolManager::new();
        let handler: ToolHandler = Arc::new(|args: serde_json::Value| {
            Box::pin(async move {
                let echoed = serde_json::json!({"echo": args});
                Ok(echoed)
            })
        });
        mgr.register_handler("echo", handler);
        assert_eq!(mgr.handler_count(), 1);
        let result = mgr
            .dispatch("echo", &serde_json::json!({"x": 1}))
            .await
            .unwrap();
        assert_eq!(result["echo"]["x"], 1);
    }

    #[tokio::test]
    async fn dispatch_unknown_returns_error() {
        let mgr = ToolManager::new();
        let result = mgr.dispatch("none", &serde_json::json!({})).await;
        assert!(result.is_err());
    }
}

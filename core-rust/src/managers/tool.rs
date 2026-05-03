//! ToolManager — AI 도구 등록 / 조회 / dispatch.
//!
//! 옛 TS ToolManager (`core/managers/tool-manager.ts`) Rust 재구현 (간소화).
//! Phase B 단계: 메모리 registry + filter. Tool 실행 자체는 매니저별 dispatch — 본 매니저는
//! 메타데이터 + lookup 만 담당. AiManager 변환 시 통합.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

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
}

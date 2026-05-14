//! TaskManager integration test — 옛 core inline tests 이관.
//!
//! private fn 사용 test (`unwrap_module_result` / `parse_spec_if_string` /
//! `is_module_level_failure` / `extract_module_error` / `path_to_module_parts`) 는 inline 유지.

use std::sync::Arc;
use serde_json::json;

use firebat_core::managers::task::{PipelineStep, StubTaskExecutor, TaskExecutor, TaskManager};
use firebat_core::managers::tool::{ToolDefinition, ToolManager};
use firebat_core::ports::ILogPort;
use firebat_infra::adapters::log::ConsoleLogAdapter;

fn make_manager() -> TaskManager {
    let executor: Arc<dyn TaskExecutor> = Arc::new(StubTaskExecutor);
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    TaskManager::new(executor, log)
}

fn make_manager_with_tools() -> TaskManager {
    let executor: Arc<dyn TaskExecutor> = Arc::new(StubTaskExecutor);
    let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
    let tools = Arc::new(ToolManager::new());
    // 등록된 도구가 있어야 hint 매칭. 옛 TS 의 hardcode 12개 대신 동적 등록.
    for name in ["sysmod_kiwoom_quote", "save_page", "image_gen", "render_table"] {
        tools.register(ToolDefinition {
            name: name.to_string(),
            description: String::new(),
            parameters: serde_json::json!({}),
            source: "core".to_string(),
        });
    }
    TaskManager::new(executor, log).with_tools(tools)
}

#[test]
fn validate_execute_missing_path() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::Execute {
        path: String::new(),
        input_data: None,
        input_map: None,
    }];
    let err = mgr.validate_pipeline(&steps).unwrap();
    assert!(err.contains("EXECUTE"));
}

#[test]
fn validate_llm_transform_with_tool_hint_rejected() {
    let mgr = make_manager_with_tools();
    let steps = vec![PipelineStep::LlmTransform {
        instruction: "1) sysmod_kiwoom_quote 호출 2) save_page".to_string(),
        input_data: None,
        input_map: None,
    }];
    let err = mgr.validate_pipeline(&steps).unwrap();
    assert!(err.contains("도구명"));
}

#[test]
fn validate_llm_transform_without_tools_skips_hint_check() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::LlmTransform {
        instruction: "1) sysmod_kiwoom_quote 호출 2) save_page".to_string(),
        input_data: None,
        input_map: None,
    }];
    assert!(mgr.validate_pipeline(&steps).is_none());
}

#[test]
fn validate_save_page_requires_slug_and_spec() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::SavePage {
        slug: None,
        spec: None,
        input_data: None,
        input_map: None,
        allow_overwrite: None,
    }];
    let err = mgr.validate_pipeline(&steps).unwrap();
    assert!(err.contains("slug"));
}

#[test]
fn validate_pass_when_save_page_has_input_map() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::SavePage {
        slug: None,
        spec: None,
        input_data: None,
        input_map: Some(json!({"slug": "$prev.slug", "spec": "$prev"})),
        allow_overwrite: None,
    }];
    assert!(mgr.validate_pipeline(&steps).is_none());
}

#[tokio::test]
async fn condition_met_continues_pipeline() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::Condition {
        field: "missing".to_string(),
        op: "==".to_string(),
        value: Some(serde_json::Value::Null),
    }];
    let result = mgr.execute_pipeline(&steps).await;
    assert!(result.success);
}

#[tokio::test]
async fn condition_unmet_returns_early_exit() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::Condition {
        field: "price".to_string(),
        op: ">=".to_string(),
        value: Some(json!(75000)),
    }];
    let result = mgr.execute_pipeline(&steps).await;
    assert!(result.success);
    let data = result.data.unwrap();
    assert_eq!(data["conditionMet"], json!(false));
}

#[tokio::test]
async fn execute_via_stub_returns_phase_error() {
    let mgr = make_manager();
    let steps = vec![PipelineStep::Execute {
        path: "system/modules/x/index.mjs".to_string(),
        input_data: None,
        input_map: None,
    }];
    let result = mgr.execute_pipeline(&steps).await;
    assert!(!result.success);
    assert!(result.error.unwrap().contains("Phase B-16+"));
}

// `fallback_disabled_when_no_capability_manager` 는 private fn (try_fallback) 사용으로
// inline 유지 (core/src/managers/task.rs).

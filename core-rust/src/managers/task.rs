//! TaskManager — 파이프라인 실행 엔진.
//!
//! 옛 TS `core/managers/task-manager.ts` Rust 재구현 (Phase B-14 minimum).
//!
//! Phase B-14 minimum:
//! - validate_pipeline (7-step EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION/SAVE_PAGE/TOOL_CALL)
//! - execute_pipeline 의 CONDITION step 진짜 평가 + $prev resolver 연동
//! - 다른 step 은 TaskExecutor trait 위임 — Phase B-16+ Core facade 가 실 구현 박음
//!
//! Phase B-16+ 후속:
//! - TaskExecutor 의 sandbox / mcp / network / llm / save_page / tool_call 실 wiring
//! - capability fallback (resolvePreferredProvider + tryFallbackProvider) 박힘 — ModuleManager
//!   capability 캐시 + Core facade.

use serde_json::Value;
use std::sync::Arc;

use crate::ports::{ILogPort, InfraResult};
use crate::utils::condition::evaluate_condition;
use crate::utils::path_resolve::resolve_field_path;
use crate::utils::pipeline_resolver::resolve_value;

/// PipelineStep — 옛 TS PipelineStep Rust 재현.
/// step type discriminator + 자유 fields. Phase B-14 minimum 단계에선 fields 를 generic JSON 으로.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PipelineStep {
    Execute {
        path: String,
        #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
        input_data: Option<Value>,
        #[serde(rename = "inputMap", default, skip_serializing_if = "Option::is_none")]
        input_map: Option<Value>,
    },
    McpCall {
        server: String,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<Value>,
        #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
        input_data: Option<Value>,
        #[serde(rename = "inputMap", default, skip_serializing_if = "Option::is_none")]
        input_map: Option<Value>,
    },
    NetworkRequest {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        method: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        headers: Option<Value>,
    },
    LlmTransform {
        instruction: String,
        #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
        input_data: Option<Value>,
        #[serde(rename = "inputMap", default, skip_serializing_if = "Option::is_none")]
        input_map: Option<Value>,
    },
    Condition {
        field: String,
        op: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
    SavePage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        slug: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spec: Option<Value>,
        #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
        input_data: Option<Value>,
        #[serde(rename = "inputMap", default, skip_serializing_if = "Option::is_none")]
        input_map: Option<Value>,
        #[serde(rename = "allowOverwrite", default, skip_serializing_if = "Option::is_none")]
        allow_overwrite: Option<bool>,
    },
    ToolCall {
        tool: String,
        #[serde(rename = "inputData", default, skip_serializing_if = "Option::is_none")]
        input_data: Option<Value>,
        #[serde(rename = "inputMap", default, skip_serializing_if = "Option::is_none")]
        input_map: Option<Value>,
    },
}

impl PipelineStep {
    pub fn step_type(&self) -> &'static str {
        match self {
            PipelineStep::Execute { .. } => "EXECUTE",
            PipelineStep::McpCall { .. } => "MCP_CALL",
            PipelineStep::NetworkRequest { .. } => "NETWORK_REQUEST",
            PipelineStep::LlmTransform { .. } => "LLM_TRANSFORM",
            PipelineStep::Condition { .. } => "CONDITION",
            PipelineStep::SavePage { .. } => "SAVE_PAGE",
            PipelineStep::ToolCall { .. } => "TOOL_CALL",
        }
    }
}

/// TaskExecutor — pipeline step 실행 위임 trait.
/// Phase B-14 minimum: TaskManager 가 step 실행을 이 trait 에 위임.
/// Phase B-16+ Core facade 가 실 구현 (sandbox / mcp / llm / save_page) 박음.
#[async_trait::async_trait]
pub trait TaskExecutor: Send + Sync {
    async fn execute_module(&self, path: &str, input: &Value) -> InfraResult<Value>;
    async fn call_mcp_tool(&self, server: &str, tool: &str, args: &Value) -> InfraResult<Value>;
    async fn network_request(
        &self,
        url: &str,
        method: &str,
        body: Option<&Value>,
        headers: Option<&Value>,
    ) -> InfraResult<Value>;
    async fn llm_transform(&self, instruction: &str, input_text: &str) -> InfraResult<String>;
    async fn save_page(
        &self,
        slug: &str,
        spec: &Value,
        allow_overwrite: bool,
    ) -> InfraResult<Value>;
    async fn execute_tool(&self, tool: &str, input: &Value) -> InfraResult<Value>;
}

/// Phase B-14 minimum stub executor — 모든 step 이 "Phase B-16+ 미박음" 에러 반환.
/// Phase B-16 에서 RealExecutor 가 Core facade 를 통해 매니저 메서드 호출.
pub struct StubTaskExecutor;

#[async_trait::async_trait]
impl TaskExecutor for StubTaskExecutor {
    async fn execute_module(&self, path: &str, _input: &Value) -> InfraResult<Value> {
        Err(format!("EXECUTE 미박음 (Phase B-16+) — path={}", path))
    }
    async fn call_mcp_tool(&self, server: &str, tool: &str, _args: &Value) -> InfraResult<Value> {
        Err(format!(
            "MCP_CALL 미박음 (Phase B-16+) — {}/{}",
            server, tool
        ))
    }
    async fn network_request(
        &self,
        url: &str,
        _method: &str,
        _body: Option<&Value>,
        _headers: Option<&Value>,
    ) -> InfraResult<Value> {
        Err(format!("NETWORK_REQUEST 미박음 (Phase B-16+) — url={}", url))
    }
    async fn llm_transform(&self, _instruction: &str, _input_text: &str) -> InfraResult<String> {
        Err("LLM_TRANSFORM 미박음 (Phase B-16+) — AiManager 박힌 후 활성".to_string())
    }
    async fn save_page(
        &self,
        slug: &str,
        _spec: &Value,
        _allow_overwrite: bool,
    ) -> InfraResult<Value> {
        Err(format!(
            "SAVE_PAGE 미박음 (Phase B-16+) — slug={}",
            slug
        ))
    }
    async fn execute_tool(&self, tool: &str, _input: &Value) -> InfraResult<Value> {
        Err(format!("TOOL_CALL 미박음 (Phase B-16+) — tool={}", tool))
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PipelineResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct TaskManager {
    executor: Arc<dyn TaskExecutor>,
    log: Arc<dyn ILogPort>,
}

impl TaskManager {
    pub fn new(executor: Arc<dyn TaskExecutor>, log: Arc<dyn ILogPort>) -> Self {
        Self { executor, log }
    }

    /// 옛 TS validatePipeline Rust port — 7-step 별 필수 field 검증.
    pub fn validate_pipeline(&self, steps: &[PipelineStep]) -> Option<String> {
        // LLM_TRANSFORM instruction 안에 도구 호출 패턴이 보이면 거부 — 흔한 설계 실수 방어
        const TOOL_HINTS: &[&str] = &[
            "sysmod_",
            "save_page",
            "savePage",
            "image_gen",
            "imageGen",
            "mcp_call",
            "mcpCall",
            "schedule_task",
            "run_task",
            "write_file",
            "delete_file",
            "render_",
        ];
        for (i, s) in steps.iter().enumerate() {
            let n = i + 1;
            match s {
                PipelineStep::Execute { path, .. } => {
                    if path.trim().is_empty() {
                        return Some(format!("[Step {n}] EXECUTE에 path가 없습니다."));
                    }
                }
                PipelineStep::McpCall { server, tool, .. } => {
                    if server.trim().is_empty() {
                        return Some(format!("[Step {n}] MCP_CALL에 server가 없습니다."));
                    }
                    if tool.trim().is_empty() {
                        return Some(format!("[Step {n}] MCP_CALL에 tool이 없습니다."));
                    }
                }
                PipelineStep::NetworkRequest { url, .. } => {
                    if url.trim().is_empty() {
                        return Some(format!("[Step {n}] NETWORK_REQUEST에 url이 없습니다."));
                    }
                }
                PipelineStep::LlmTransform { instruction, .. } => {
                    if instruction.trim().is_empty() {
                        return Some(format!(
                            "[Step {n}] LLM_TRANSFORM에 instruction이 없습니다."
                        ));
                    }
                    let lower = instruction.to_lowercase();
                    for hint in TOOL_HINTS {
                        if lower.contains(&hint.to_lowercase()) {
                            return Some(format!("[Step {n}] LLM_TRANSFORM instruction 안에 도구명 \"{hint}\" 이 보입니다. LLM_TRANSFORM 은 텍스트 변환만 가능합니다 — 도구 호출은 별도 EXECUTE/MCP_CALL/SAVE_PAGE step 으로 분리하세요."));
                        }
                    }
                }
                PipelineStep::Condition { field, op, .. } => {
                    if field.trim().is_empty() {
                        return Some(format!("[Step {n}] CONDITION에 field가 없습니다."));
                    }
                    if op.trim().is_empty() {
                        return Some(format!("[Step {n}] CONDITION에 op가 없습니다."));
                    }
                }
                PipelineStep::SavePage {
                    slug,
                    spec,
                    input_map,
                    ..
                } => {
                    let slug_present = slug.is_some()
                        || input_map
                            .as_ref()
                            .and_then(|v| v.get("slug"))
                            .is_some();
                    if !slug_present {
                        return Some(format!("[Step {n}] SAVE_PAGE에 slug 가 없습니다 (직접 지정 또는 inputMap.slug 로 매핑 필요)."));
                    }
                    let spec_present = spec.is_some()
                        || input_map
                            .as_ref()
                            .and_then(|v| v.get("spec"))
                            .is_some();
                    if !spec_present {
                        return Some(format!("[Step {n}] SAVE_PAGE에 spec 이 없습니다 (직접 지정 또는 inputMap.spec 로 매핑 필요 — 보통 직전 LLM_TRANSFORM 결과를 매핑)."));
                    }
                }
                PipelineStep::ToolCall { tool, .. } => {
                    if tool.trim().is_empty() {
                        return Some(format!("[Step {n}] TOOL_CALL에 tool 이름이 없습니다 (예: \"image_gen\", \"search_history\")."));
                    }
                }
            }
        }
        None
    }

    /// 파이프라인 실행 — 옛 TS executePipeline Rust port.
    /// Phase B-14 minimum:
    /// - CONDITION step 은 진짜 평가
    /// - 그 외 step 은 TaskExecutor trait 위임 (Phase B-16+ 에서 실 구현)
    pub async fn execute_pipeline(&self, steps: &[PipelineStep]) -> PipelineResult {
        if let Some(err) = self.validate_pipeline(steps) {
            return PipelineResult {
                success: false,
                data: None,
                error: Some(err),
            };
        }

        let mut prev: Value = Value::Null;
        let mut step_results: Vec<Value> = Vec::new();

        for (i, step) in steps.iter().enumerate() {
            let n = i + 1;
            self.log
                .info(&format!("[Pipeline] Step {}/{}: {}", n, steps.len(), step.step_type()));

            let outcome = self.run_step(step, &prev, &step_results).await;
            match outcome {
                StepOutcome::Continue(value) => {
                    prev = value.clone();
                    step_results.push(value);
                }
                StepOutcome::EarlyExit(value) => {
                    // CONDITION 미충족 — 정상 종료, 이후 step skip
                    self.log.info(&format!(
                        "[Pipeline] 조건 미충족 — 파이프라인 정상 종료 (이후 {}단계 스킵)",
                        steps.len() - i - 1
                    ));
                    return PipelineResult {
                        success: true,
                        data: Some(value),
                        error: None,
                    };
                }
                StepOutcome::Fail(err) => {
                    return PipelineResult {
                        success: false,
                        data: None,
                        error: Some(format!("[Pipeline Step {n}] {}", err)),
                    };
                }
            }
        }

        PipelineResult {
            success: true,
            data: Some(prev),
            error: None,
        }
    }

    async fn run_step(
        &self,
        step: &PipelineStep,
        prev: &Value,
        step_results: &[Value],
    ) -> StepOutcome {
        match step {
            PipelineStep::Condition { field, op, value } => {
                let actual = match resolve_field_path(prev, field) {
                    Some(v) => v.clone(),
                    None => Value::Null,
                };
                let met = evaluate_condition(&actual, op, value.as_ref());
                self.log.info(&format!(
                    "[Pipeline] CONDITION: {} {} {:?} → {}",
                    field, op, value, met
                ));
                if !met {
                    let mut summary = serde_json::Map::new();
                    summary.insert("conditionMet".into(), Value::Bool(false));
                    summary.insert("field".into(), Value::String(field.clone()));
                    summary.insert("op".into(), Value::String(op.clone()));
                    if let Some(v) = value {
                        summary.insert("value".into(), v.clone());
                    }
                    summary.insert("actual".into(), actual);
                    return StepOutcome::EarlyExit(Value::Object(summary));
                }
                StepOutcome::Continue(prev.clone())
            }
            PipelineStep::Execute {
                path,
                input_data,
                input_map,
            } => {
                let input = resolve_pipeline_input(input_data, input_map, prev, step_results);
                match self.executor.execute_module(path, &input).await {
                    Ok(v) => StepOutcome::Continue(unwrap_module_result(v)),
                    Err(e) => StepOutcome::Fail(format!("EXECUTE 실패: {e}")),
                }
            }
            PipelineStep::McpCall {
                server,
                tool,
                arguments,
                input_data,
                input_map,
            } => {
                let args = if input_map.is_some() || input_data.is_some() {
                    resolve_pipeline_input(input_data, input_map, prev, step_results)
                } else {
                    arguments.clone().unwrap_or(Value::Object(Default::default()))
                };
                match self.executor.call_mcp_tool(server, tool, &args).await {
                    Ok(v) => StepOutcome::Continue(v),
                    Err(e) => StepOutcome::Fail(format!("MCP_CALL 실패: {e}")),
                }
            }
            PipelineStep::NetworkRequest {
                url,
                method,
                body,
                headers,
            } => {
                let m = method.as_deref().unwrap_or("GET");
                match self
                    .executor
                    .network_request(url, m, body.as_ref(), headers.as_ref())
                    .await
                {
                    Ok(v) => StepOutcome::Continue(v),
                    Err(e) => StepOutcome::Fail(format!("NETWORK_REQUEST 실패: {e}")),
                }
            }
            PipelineStep::LlmTransform {
                instruction,
                input_data,
                input_map,
            } => {
                // 옛 TS — explicit input 미지정 시 누적 결과 전체.
                let has_explicit = input_data.is_some() || input_map.is_some();
                let input_text = if has_explicit {
                    let resolved =
                        resolve_pipeline_input(input_data, input_map, prev, step_results);
                    if let Value::String(s) = &resolved {
                        s.clone()
                    } else {
                        serde_json::to_string_pretty(&resolved).unwrap_or_default()
                    }
                } else if step_results.is_empty() {
                    "(이전 step 결과 없음)".to_string()
                } else {
                    step_results
                        .iter()
                        .enumerate()
                        .map(|(idx, r)| {
                            let s = if let Value::String(s) = r {
                                s.clone()
                            } else {
                                serde_json::to_string_pretty(r).unwrap_or_default()
                            };
                            let trimmed = if s.len() > 1500 {
                                format!("{}...(생략)", &s[..1500])
                            } else {
                                s
                            };
                            format!("[Step {} 결과]\n{}", idx + 1, trimmed)
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                };
                match self.executor.llm_transform(instruction, &input_text).await {
                    Ok(text) => StepOutcome::Continue(Value::String(text)),
                    Err(e) => StepOutcome::Fail(format!("LLM_TRANSFORM 실패: {e}")),
                }
            }
            PipelineStep::SavePage {
                slug,
                spec,
                input_data,
                input_map,
                allow_overwrite,
            } => {
                let resolved_input =
                    resolve_pipeline_input(input_data, input_map, prev, step_results);
                let slug_str = resolve_save_page_slug(slug, &resolved_input, prev, step_results);
                let spec_value = resolve_save_page_spec(spec, &resolved_input);
                let Some(slug_str) = slug_str else {
                    return StepOutcome::Fail("SAVE_PAGE 실패: slug 미지정".to_string());
                };
                let Some(spec_value) = spec_value else {
                    return StepOutcome::Fail("SAVE_PAGE 실패: spec 미지정".to_string());
                };
                let allow = allow_overwrite.unwrap_or(false);
                match self.executor.save_page(&slug_str, &spec_value, allow).await {
                    Ok(v) => StepOutcome::Continue(v),
                    Err(e) => StepOutcome::Fail(format!("SAVE_PAGE 실패: {e}")),
                }
            }
            PipelineStep::ToolCall {
                tool,
                input_data,
                input_map,
            } => {
                let input = resolve_pipeline_input(input_data, input_map, prev, step_results);
                match self.executor.execute_tool(tool, &input).await {
                    Ok(v) => StepOutcome::Continue(v),
                    Err(e) => StepOutcome::Fail(format!("TOOL_CALL {} 실패: {}", tool, e)),
                }
            }
        }
    }
}

enum StepOutcome {
    Continue(Value),
    EarlyExit(Value),
    Fail(String),
}

/// `inputData` (고정값) + `inputMap` ($prev/$stepN 매핑) 병합.
/// 둘 다 있으면 inputMap 이 inputData 동일 키 덮어씀 (매핑 우선).
fn resolve_pipeline_input(
    input_data: &Option<Value>,
    input_map: &Option<Value>,
    prev: &Value,
    step_results: &[Value],
) -> Value {
    match (input_data, input_map) {
        (Some(data), Some(map)) => {
            let from_data = resolve_value(data, prev, step_results);
            let from_map = resolve_value(map, prev, step_results);
            if let (Value::Object(d), Value::Object(m)) = (&from_data, &from_map) {
                let mut merged = d.clone();
                for (k, v) in m {
                    merged.insert(k.clone(), v.clone());
                }
                return Value::Object(merged);
            }
            from_data
        }
        (Some(data), None) => resolve_value(data, prev, step_results),
        (None, Some(map)) => resolve_value(map, prev, step_results),
        (None, None) => prev.clone(),
    }
}

/// 모듈 출력이 `{success, data}` wrapping 이면 내부 data 만 추출.
fn unwrap_module_result(v: Value) -> Value {
    if let Value::Object(map) = &v {
        if map.contains_key("success") && map.contains_key("data") {
            if let Some(inner) = map.get("data").cloned() {
                return inner;
            }
        }
    }
    v
}

fn resolve_save_page_slug(
    step_slug: &Option<String>,
    resolved_input: &Value,
    prev: &Value,
    step_results: &[Value],
) -> Option<String> {
    if let Some(s) = resolved_input.get("slug").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if let Some(s) = step_slug {
        // step.slug 도 $prev.x 패턴 가능
        let resolved = resolve_value(&Value::String(s.clone()), prev, step_results);
        if let Value::String(rs) = resolved {
            return Some(rs);
        }
    }
    None
}

fn resolve_save_page_spec(step_spec: &Option<Value>, resolved_input: &Value) -> Option<Value> {
    if let Some(spec) = resolved_input.get("spec") {
        return Some(parse_spec_if_string(spec.clone()));
    }
    if let Some(spec) = step_spec {
        return Some(parse_spec_if_string(spec.clone()));
    }
    None
}

/// LLM_TRANSFORM 결과로 spec 이 string 인 경우 JSON parse 시도, 실패 시 Html body 폴백.
fn parse_spec_if_string(spec: Value) -> Value {
    if let Value::String(s) = &spec {
        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
            return parsed;
        }
        // JSON 파싱 실패 — body Html 폴백 (옛 TS 동일)
        return serde_json::json!({
            "body": [{"type": "Html", "props": {"content": s}}]
        });
    }
    spec
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::log::ConsoleLogAdapter;
    use serde_json::json;

    fn manager() -> TaskManager {
        let executor: Arc<dyn TaskExecutor> = Arc::new(StubTaskExecutor);
        let log: Arc<dyn ILogPort> = Arc::new(ConsoleLogAdapter::new());
        TaskManager::new(executor, log)
    }

    #[test]
    fn validate_execute_missing_path() {
        let mgr = manager();
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
        let mgr = manager();
        let steps = vec![PipelineStep::LlmTransform {
            instruction: "1) sysmod_kiwoom 호출 2) save_page".to_string(),
            input_data: None,
            input_map: None,
        }];
        let err = mgr.validate_pipeline(&steps).unwrap();
        assert!(err.contains("도구명"));
    }

    #[test]
    fn validate_save_page_requires_slug_and_spec() {
        let mgr = manager();
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
        let mgr = manager();
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
        let mgr = manager();
        // 단일 CONDITION step + prev=null. field 미존재 → Null vs ==Null 검사
        let steps = vec![PipelineStep::Condition {
            field: "missing".to_string(),
            op: "==".to_string(),
            value: Some(Value::Null),
        }];
        let result = mgr.execute_pipeline(&steps).await;
        assert!(result.success);
    }

    #[tokio::test]
    async fn condition_unmet_returns_early_exit() {
        let mgr = manager();
        // CONDITION 단독 — actual=null, 75000 매칭 X → unmet → early exit
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
        let mgr = manager();
        let steps = vec![PipelineStep::Execute {
            path: "system/modules/x/index.mjs".to_string(),
            input_data: None,
            input_map: None,
        }];
        let result = mgr.execute_pipeline(&steps).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("Phase B-16+"));
    }

    #[test]
    fn unwrap_strips_success_data_wrapper() {
        let v = json!({"success": true, "data": {"x": 1}});
        let unwrapped = unwrap_module_result(v);
        assert_eq!(unwrapped, json!({"x": 1}));
    }

    #[test]
    fn parse_spec_string_to_json() {
        let s = json!(r#"{"body":[{"type":"Text"}]}"#);
        let parsed = parse_spec_if_string(s);
        assert_eq!(parsed["body"][0]["type"], "Text");
    }

    #[test]
    fn parse_spec_falls_back_to_html() {
        let s = Value::String("not json".to_string());
        let parsed = parse_spec_if_string(s);
        assert_eq!(parsed["body"][0]["type"], "Html");
    }
}

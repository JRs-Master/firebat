//! TaskManager — 파이프라인 실행 엔진.
//!
//! 옛 TS `core/managers/task-manager.ts` Rust 재구현 (Phase B-14 minimum).
//!
//! Phase B-14 minimum:
//! - validate_pipeline (7-step EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION/SAVE_PAGE/TOOL_CALL)
//! - execute_pipeline 의 CONDITION step 진짜 평가 + $prev resolver 연동
//! - 다른 step 은 TaskExecutor trait 위임 — Phase B-16+ Core facade 가 실 구현 저장
//!
//! Phase B-16+ 후속:
//! - TaskExecutor 의 sandbox / mcp / network / llm / save_page / tool_call 실 wiring
//! - capability fallback (resolvePreferredProvider + tryFallbackProvider) 설정 — ModuleManager
//!   capability 캐시 + Core facade.

use serde_json::Value;
use std::sync::Arc;

use crate::managers::status::StatusManager;
use crate::managers::tool::{ToolListFilter, ToolManager};
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
        // Optional — models often write only the CLI-namespaced tool name
        // (`mcp__<srv>__<tool>`), which carries the server inside the name (the executor's
        // `split_mcp_name` extracts it); a bare tool with no server anywhere = ourselves.
        // Required `server` used to kill the whole schedule_task pending at parse time
        // ("missing field server" — 2026-07-07 실측).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        server: Option<String>,
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
        // `args` alias — Function Calling 관례상 도구 인자는 `args`. AI 가 `{tool, args}` 형태로
        // 넘겨도 inputData 로 받아 유실 0 (McpCall 의 `arguments` 수용과 동일 취지).
        #[serde(rename = "inputData", alias = "args", default, skip_serializing_if = "Option::is_none")]
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
/// Phase B-16+ Core facade 가 실 구현 (sandbox / mcp / llm / save_page) 저장.
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

/// Phase B-14 minimum stub executor — 모든 step 이 "Phase B-16+ 미구현" 에러 반환.
/// Phase B-16 에서 RealExecutor 가 Core facade 를 통해 매니저 메서드 호출.
pub struct StubTaskExecutor;

#[async_trait::async_trait]
impl TaskExecutor for StubTaskExecutor {
    async fn execute_module(&self, path: &str, _input: &Value) -> InfraResult<Value> {
        Err(crate::i18n::t(
            "core.error.task.execute_unimplemented",
            None,
            &[("path", path)],
        ))
    }
    async fn call_mcp_tool(&self, server: &str, tool: &str, _args: &Value) -> InfraResult<Value> {
        Err(crate::i18n::t(
            "core.error.task.mcp_call_unimplemented",
            None,
            &[("server", server), ("tool", tool)],
        ))
    }
    async fn network_request(
        &self,
        url: &str,
        _method: &str,
        _body: Option<&Value>,
        _headers: Option<&Value>,
    ) -> InfraResult<Value> {
        Err(crate::i18n::t(
            "core.error.task.network_request_unimplemented",
            None,
            &[("url", url)],
        ))
    }
    async fn llm_transform(&self, _instruction: &str, _input_text: &str) -> InfraResult<String> {
        Err(crate::i18n::t(
            "core.error.task.llm_transform_unimplemented",
            None,
            &[],
        ))
    }
    async fn save_page(
        &self,
        slug: &str,
        _spec: &Value,
        _allow_overwrite: bool,
    ) -> InfraResult<Value> {
        Err(crate::i18n::t(
            "core.error.task.save_page_unimplemented",
            None,
            &[("slug", slug)],
        ))
    }
    async fn execute_tool(&self, tool: &str, _input: &Value) -> InfraResult<Value> {
        Err(crate::i18n::t(
            "core.error.task.tool_call_unimplemented",
            None,
            &[("tool", tool)],
        ))
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// LLM_TRANSFORM instruction 안 도구 호출 환각 방어용. ToolManager 등록 도구 list 동적 조회 →
    /// 새 도구 추가 시 hint 자동 설정 (옛 TS 의 hardcoded TOOL_HINTS 12개 enumerate 제거).
    /// None 일 때는 환각 방어 비활성 (테스트 용 또는 ToolManager 없는 경량 wiring).
    tools: Option<Arc<ToolManager>>,
    /// StatusManager (옵션) — pipeline 실행 가시화 (옛 TS core/index.ts:1252 statusMgr.start/update/
    /// done/error 패턴 1:1). 어드민 UI 의 ActiveJobsIndicator 자동 표시.
    /// (EXECUTE capability 폴백은 executor(RealTaskExecutor.with_capability) 단일 소유 —
    /// 옛 매니저 레벨 중복 구현은 이중 실행이라 제거.)
    status: Option<Arc<StatusManager>>,
}

impl TaskManager {
    pub fn new(executor: Arc<dyn TaskExecutor>, log: Arc<dyn ILogPort>) -> Self {
        Self {
            executor,
            log,
            tools: None,
            status: None,
        }
    }

    /// ToolManager 설정된 채로 부팅 — validate_pipeline 의 LLM_TRANSFORM 환각 방어 활성.
    pub fn with_tools(mut self, tools: Arc<ToolManager>) -> Self {
        self.tools = Some(tools);
        self
    }

    /// StatusManager 설정된 채로 부팅 — execute_pipeline 의 자동 status start/update/done 활성.
    pub fn with_status(mut self, status: Arc<StatusManager>) -> Self {
        self.status = Some(status);
        self
    }
    /// 등록된 도구 이름 (lowercase) — instruction substring 매칭용.
    /// 새 도구 추가 시 자동 hint — 옛 TS 의 const TOOL_HINTS 12개 hardcode 제거.
    fn registered_tool_hints(&self) -> Vec<String> {
        let Some(tools) = &self.tools else {
            return Vec::new();
        };
        tools
            .list(&ToolListFilter::default())
            .into_iter()
            .map(|def| def.name.to_lowercase())
            .collect()
    }

    /// 옛 TS validatePipeline Rust port — 7-step 별 필수 field 검증.
    pub fn validate_pipeline(&self, steps: &[PipelineStep]) -> Option<String> {
        // LLM_TRANSFORM instruction 안에 도구 호출 패턴이 보이면 거부 — 흔한 설계 실수 방어.
        // 옛 TS 의 hardcoded list 12개 → ToolManager 등록 도구 동적 조회로 일반화.
        let tool_hints = self.registered_tool_hints();
        for (i, s) in steps.iter().enumerate() {
            let n = i + 1;
            match s {
                PipelineStep::Execute { path, .. } => {
                    if path.trim().is_empty() {
                        return Some(format!("[Step {n}] EXECUTE에 path가 없습니다."));
                    }
                }
                PipelineStep::McpCall { server, tool, .. } => {
                    // server 는 옵션 (미기재 = firebat 내부 / mcp__<srv>__ 이름에 내장 가능) —
                    // 기재됐다면 빈 문자열은 거부.
                    if server.as_deref().is_some_and(|s| s.trim().is_empty()) {
                        return Some(format!("[Step {n}] MCP_CALL의 server가 빈 문자열입니다."));
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
                    for hint in &tool_hints {
                        if lower.contains(hint) {
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
    /// CONDITION step 은 진짜 평가 / 그 외 step 은 TaskExecutor trait 위임.
    /// AI 미개입 cross-call hook — StatusManager 설정되어 있으면 자동 start/update/complete/fail
    /// (옛 TS core/index.ts:1252 1:1 port).
    pub async fn execute_pipeline(&self, steps: &[PipelineStep]) -> PipelineResult {
        if let Some(err) = self.validate_pipeline(steps) {
            return PipelineResult {
                success: false,
                data: None,
                error: Some(err),
            };
        }

        // StatusManager 설정되어 있으면 pipeline job 가시화. 어드민 ActiveJobsIndicator 자동 표시.
        let status_job_id = self.status.as_ref().map(|s| {
            let job = s.start(
                None,
                "pipeline".to_string(),
                Some(format!("pipeline 실행 ({} step)", steps.len())),
                None,
                serde_json::json!({"stepCount": steps.len()}),
            );
            job.id
        });

        let total = steps.len();
        let mut prev: Value = Value::Null;
        let mut step_results: Vec<Value> = Vec::new();

        for (i, step) in steps.iter().enumerate() {
            let n = i + 1;
            self.log
                .info(&format!("[Pipeline] Step {}/{}: {}", n, total, step.step_type()));

            // 매 step 시작 시 status 진행도 갱신 (옛 TS update 패턴).
            if let (Some(s), Some(job_id)) = (&self.status, &status_job_id) {
                let progress = (i as f64) / (total as f64);
                let _ = s.update(
                    job_id,
                    Some(progress),
                    Some(format!("Step {}/{}: {}", n, total, step.step_type())),
                    None,
                );
            }

            let outcome = self.run_step(step, &prev, &step_results).await;
            match outcome {
                StepOutcome::Continue(value) => {
                    prev = value.clone();
                    step_results.push(value);
                }
                StepOutcome::EarlyExit(value) => {
                    // CONDITION 미충족 — 정상 종료, 이후 step skip
                    self.log.info(&format!(
                        "[Pipeline] condition not met — pipeline ended normally ({} remaining steps skipped)",
                        total - i - 1
                    ));
                    if let (Some(s), Some(job_id)) = (&self.status, &status_job_id) {
                        let _ = s.complete(job_id, Some(value.clone()));
                    }
                    return PipelineResult {
                        success: true,
                        data: Some(value),
                        error: None,
                    };
                }
                StepOutcome::Fail(err) => {
                    let full_err = format!("[Pipeline Step {n}] {}", err);
                    // journal 에도 반드시 남긴다 — status job 이 없는 실행(cron DelayedRun 등)은
                    // 옛엔 실패가 어디에도 안 찍혀 무증상 유실이었다 (2026-07-07 실측: 승인된
                    // TQQQ 예약 매수의 MCP_CALL 실패가 로그 0 으로 증발).
                    self.log.warn(&format!("[Pipeline] failed — {full_err}"));
                    if let (Some(s), Some(job_id)) = (&self.status, &status_job_id) {
                        let _ = s.fail(job_id, full_err.clone());
                    }
                    return PipelineResult {
                        success: false,
                        data: None,
                        error: Some(full_err),
                    };
                }
            }
        }

        if let (Some(s), Some(job_id)) = (&self.status, &status_job_id) {
            let _ = s.complete(&job_id, Some(prev.clone()));
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
                if let Some(bad) = crate::utils::pipeline_resolver::find_unresolved_ref(&input) {
                    return unresolved_ref_fail("EXECUTE", &bad);
                }
                // Capability fallback lives INSIDE the executor (RealTaskExecutor.execute_module
                // — with_capability). A second manager-level fallback here used to re-run the
                // same alternatives after the executor had already tried them all (duplicate
                // implementation → double execution on total failure). Removed; the executor
                // is the single fallback owner.
                call_outcome("EXECUTE", path, self.executor.execute_module(path, &input).await)
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
                if let Some(bad) = crate::utils::pipeline_resolver::find_unresolved_ref(&args) {
                    return unresolved_ref_fail("MCP_CALL", &bad);
                }
                // server 미기재 = 자기 자신(firebat) — tool 이 mcp__<srv>__ 네임스페이스를
                // 품고 있으면 executor 의 split_mcp_name 이 그쪽을 우선한다.
                let srv = server.as_deref().unwrap_or("firebat");
                call_outcome("MCP_CALL", tool, self.executor.call_mcp_tool(srv, tool, &args).await)
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
                            // UTF-8 char boundary 보호 — 한국어/일본어/중국어 3-4 byte char 중간에서
                                                        // slice 하면 즉시 panic (process abort → systemd restart). naive
                                                        // `&s[..1500]` 패턴이 한글 데이터에서 터지던 사고(2026-05-24, molit-realestate
                                                        // 한글 아파트명 응답에서 'thread panicked: end byte index 1500 is not a
                                                        // char boundary; it is inside 젼' 발생) 대응. 1500 위치가 char 중간이면
                                                        // 그 직전 boundary 로 내려서 자른다.
                            let trimmed = if s.len() > 1500 {
                                let mut end = 1500;
                                while end > 0 && !s.is_char_boundary(end) {
                                    end -= 1;
                                }
                                format!("{}...(생략)", &s[..end])
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
                if let Some(bad) = crate::utils::pipeline_resolver::find_unresolved_ref(&input) {
                    return unresolved_ref_fail("TOOL_CALL", &bad);
                }
                call_outcome("TOOL_CALL", tool, self.executor.execute_tool(tool, &input).await)
            }
        }
    }
}

enum StepOutcome {
    Continue(Value),
    EarlyExit(Value),
    Fail(String),
}

// ── 스텝 호출 공통 규약 ─────────────────────────────────────────────────────
// EXECUTE / MCP_CALL / TOOL_CALL 은 대상(sysmod·도구·외부 MCP)만 다르지 계약이 같다:
// (1) 입력 해석 후 미해석 $prev/$stepN = fail-fast (literal 이 모듈로 새면 영문 모를 에러)
// (2) 호출 결과의 {success:false} envelope = 스텝 실패 (호출 성공 ≠ 작업 성공 — 2026-07-08
//     TQQQ 실측: 토스 422 거절이 cron 로그 "성공"으로 집계)
// (3) 성공 envelope 은 data 로 언랩 → $prev 가 스텝 종류 무관 같은 shape.
// 팔마다 복붙하면 드리프트(실측 2건)라 한 함수로 수렴 — 새 스텝 타입도 이 둘만 쓰면 규약 상속.

/// (1) 미해석 참조 fail-fast — 스텝 종류 무관 동일 메시지.
fn unresolved_ref_fail(kind: &str, bad: &str) -> StepOutcome {
    StepOutcome::Fail(format!(
        "{kind} 미해석 참조: '{bad}' — 이전 스텝 출력에 그 경로가 없습니다. $prev = 이전 스텝 출력 자체(모듈 {{success,data}} 래핑은 자동 언랩)이며 .output 같은 래퍼를 지어내지 마세요 (예: $prev.result[0].accountSeq). 이미 아는 값이면 참조 대신 literal 로 넣으세요."
    ))
}

/// (2)+(3) 호출 결과 → 스텝 outcome — envelope 실패 판정 + 성공 시 data 언랩.
fn call_outcome(kind: &str, target: &str, res: InfraResult<Value>) -> StepOutcome {
    match res {
        Ok(v) if !is_module_level_failure(&v) => StepOutcome::Continue(unwrap_module_result(v)),
        Ok(v) => StepOutcome::Fail(format!(
            "{kind} 모듈 실패 ({target}): {}",
            extract_module_error(&v)
        )),
        Err(e) => StepOutcome::Fail(format!("{kind} 실패 ({target}): {e}")),
    }
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

/// 모듈 레벨 실패 감지 — 옛 TS `data.success === false` 1:1.
/// Sandbox 자체 실패와 다름 (그건 Result::Err 로 분기).
/// `{success: false, error: ...}` 형태면 true. 그 외 (success 미설정 / true / 다른 형태) false.
fn is_module_level_failure(v: &Value) -> bool {
    let Some(map) = v.as_object() else {
        return false;
    };
    map.get("success")
        .and_then(|s| s.as_bool())
        .map(|b| !b)
        .unwrap_or(false)
}

/// 모듈 레벨 실패 시 error 메시지 추출 — UI 표시용.
fn extract_module_error(v: &Value) -> String {
    v.as_object()
        .and_then(|m| m.get("error"))
        .and_then(|e| e.as_str())
        .unwrap_or("(모듈이 success=false 만 반환)")
        .to_string()
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

// Tests 이관 — `infra/tests/task_manager_test.rs` (integration test).
// private fn 사용 test 만 inline 유지 — `unwrap_module_result` / `parse_spec_if_string` /
// `is_module_level_failure` / `extract_module_error`.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn module_level_failure_detected() {
        // 옛 TS 1:1 — `{success: false}` 형태만 module-level fail
        assert!(is_module_level_failure(&json!({"success": false, "error": "API 키 없음"})));
        assert!(!is_module_level_failure(&json!({"success": true})));
        assert!(!is_module_level_failure(&json!({})));
        assert!(!is_module_level_failure(&json!({"success": "false"}))); // 문자열은 false 아님
        assert!(!is_module_level_failure(&json!("just a string")));
    }

    #[test]
    fn module_error_extracted() {
        let err = extract_module_error(&json!({"success": false, "error": "API 키 없음"}));
        assert_eq!(err, "API 키 없음");
        // error 필드 없을 때 default 메시지
        let default_err = extract_module_error(&json!({"success": false}));
        assert!(default_err.contains("success=false"));
    }
}

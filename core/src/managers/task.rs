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
        /// Per-step model override (declarative chore delegation) — the DESIGNING model pins a
        /// cheap worker (e.g. "solar-pro3") for bounded text synthesis at compile time.
        /// None = current main model (existing behavior).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
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
    /// Run the same steps once per item of a list.
    ///
    /// The one thing a fixed step list cannot express is "do this N times, where N is decided by
    /// an earlier step" — place these orders, notify these people, fetch these pages. Without it,
    /// anything variable-length has to be pushed inside a module, which is where per-case code
    /// starts piling up: each module grows its own way of calling other modules and the framework
    /// stops being the thing that mediates. So the loop belongs here, next to the wiring it uses.
    // The variant name would serialise as FOR_EACH under the enum's SCREAMING_SNAKE rule, but
    // every description, prompt and doc says FOREACH — and that is the spelling people write.
    // Pin the wire name and keep the derived one as an alias.
    #[serde(rename = "FOREACH", alias = "FOR_EACH", rename_all = "camelCase")]
    ForEach {
        /// A list: `"$step2.orders"`, `"$prev.rows"`, or a literal array.
        items: Value,
        /// Steps run per item. `$prev` is the current item at the first inner step and the
        /// previous inner result after that; `$stepN` still addresses the OUTER steps, which is
        /// where a loop body's shared inputs live (a cache key fetched once before the loop).
        steps: Vec<PipelineStep>,
        /// Cap on items processed (clamped to `MAX_FOREACH_ITEMS`). Anything dropped is reported
        /// rather than silently skipped.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_items: Option<usize>,
        /// Keep going when one item fails. Off by default: for a list of orders, "three went out
        /// and the fourth failed" should stop, not continue into an unknown state.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continue_on_error: Option<bool>,
    },
}

/// Hard ceiling on one FOREACH. A list that arrives longer than this is a bug upstream, and the
/// blast radius of being wrong here is N real side effects.
pub const MAX_FOREACH_ITEMS: usize = 100;

/// The `pipeline` parameter as the model sees it — the form for a step, published instead of
/// described.
///
/// The enum above IS the form: a tagged union with per-variant fields. It was never handed over
/// as one. Both tool registries declared `pipeline: {items: {type: "object"}}` and carried the
/// entire step vocabulary in a ~1,400-character prose paragraph — two paragraphs, in fact, which
/// had already drifted apart between the FC and MCP copies. A step is the most dialect-prone
/// payload we have and it runs unattended, where a malformed one fails with nobody watching.
///
/// So the shape lives here, beside the enum it mirrors, and both transports publish this. The
/// prose keeps only what a schema cannot say: what `$prev`/`$stepN` resolve to, why TOOL_CALL and
/// not EXECUTE, and what FOREACH scoping means.
///
/// `steps` is declared as a plain object array rather than a recursive `$ref`: nested steps are
/// the same shape, but self-referencing schemas are rejected outright by some providers, and a
/// tool schema that fails to load teaches nothing at all.
pub fn pipeline_param_schema() -> Value {
    serde_json::json!({
        "type": "array",
        "description": "executionMode=pipeline deterministic steps. Reference syntax: **$stepN counts from zero** ($step0 = the first step; the run log numbers from 1). `$prev` IS the previous step's output itself — module {success,data} envelopes auto-unwrap to data, so path from there ($prev.result[0].accountSeq); never invent wrappers like .output[], an unresolved path fails the step. Inside FOREACH, `$prev` is the CURRENT ITEM at the first inner step while `$stepN` still addresses the outer steps — that is how a loop body combines its item with a value fetched once. Call a MODULE with TOOL_CALL tool=sysmod_<name>: EXECUTE runs a file path straight in the sandbox and therefore skips input validation, account resolution and cache-key expansion (a `<param>CacheKey` argument silently never becomes rows). Bake a literal you already know instead of a reference.",
        "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["type"],
            "description": "Required fields per type — EXECUTE{path} · MCP_CALL{tool} · NETWORK_REQUEST{url} · CONDITION{field,op} · LLM_TRANSFORM{instruction} · SAVE_PAGE{slug|inputMap} · TOOL_CALL{tool} · FOREACH{items,steps}. Every other field below is optional and belongs to the types that name it.",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["EXECUTE", "MCP_CALL", "NETWORK_REQUEST", "CONDITION",
                             "LLM_TRANSFORM", "SAVE_PAGE", "TOOL_CALL", "FOREACH"]
                },
                "path": {"type": "string", "description": "EXECUTE: workspace-relative script path"},
                "tool": {"type": "string", "description": "TOOL_CALL / MCP_CALL: tool name (sysmod_<module> for a system module)"},
                "server": {"type": "string", "description": "MCP_CALL: external server; omit for our own tools"},
                "arguments": {"type": "object", "description": "MCP_CALL: tool arguments"},
                "inputData": {"type": ["object", "array", "string", "number", "boolean"],
                              "description": "Literal input, or a reference like \"$prev\" / \"$step0.rows\""},
                "inputMap": {"type": "object",
                             "description": "Per-field references merged into the input, e.g. {\"barsCacheKey\": \"$step0._cacheKey\"}"},
                "url": {"type": "string", "description": "NETWORK_REQUEST"},
                "method": {"type": "string", "description": "NETWORK_REQUEST: GET by default"},
                "body": {"type": ["object", "array", "string"], "description": "NETWORK_REQUEST"},
                "headers": {"type": "object", "description": "NETWORK_REQUEST"},
                "instruction": {"type": "string",
                                "description": "LLM_TRANSFORM: what to write; format directives go here (no auto context)"},
                "model": {"type": "string",
                          "description": "LLM_TRANSFORM: pin a cheaper worker model for this step; omit for the main model"},
                "field": {"type": "string", "description": "CONDITION: path into the previous output"},
                "op": {"type": "string", "description": "CONDITION: comparison operator"},
                "value": {"description": "CONDITION: the value compared against"},
                "slug": {"type": "string", "description": "SAVE_PAGE: page slug"},
                "spec": {"type": "object", "description": "SAVE_PAGE: page spec"},
                "allowOverwrite": {"type": "boolean", "description": "SAVE_PAGE"},
                "items": {"type": ["array", "string"],
                          "description": "FOREACH: a literal list, or a reference to one an earlier step produced (\"$prev.orders\")"},
                "steps": {"type": "array", "items": {"type": "object"},
                          "description": "FOREACH: the steps run once per item (same step shape)"},
                "maxItems": {"type": "integer", "description": "FOREACH: cap; anything dropped is reported"},
                "continueOnError": {"type": "boolean",
                                    "description": "FOREACH: keep going after an item fails (off by default)"}
            }
        }
    })
}

/// The published form must name every step type the executor can run. There is no reflection
/// over enum variants, so this list is the seam: a new variant fails here until it is added to
/// `pipeline_param_schema` too — which is the whole point of keeping the schema beside the enum.
#[cfg(test)]
mod step_schema_tests {
    use super::*;

    #[test]
    fn the_published_form_names_every_step_type() {
        let variants = vec![
            PipelineStep::Execute { path: "s.py".into(), input_data: None, input_map: None },
            PipelineStep::McpCall { server: None, tool: "t".into(), arguments: None, input_data: None, input_map: None },
            PipelineStep::NetworkRequest { url: "https://x".into(), method: None, body: None, headers: None },
            PipelineStep::LlmTransform { instruction: "i".into(), input_data: None, input_map: None, model: None },
            PipelineStep::Condition { field: "f".into(), op: ">".into(), value: None },
            PipelineStep::SavePage { slug: None, spec: None, input_data: None, input_map: None, allow_overwrite: None },
            PipelineStep::ToolCall { tool: "t".into(), input_data: None, input_map: None },
            PipelineStep::ForEach { items: serde_json::json!([]), steps: vec![], max_items: None, continue_on_error: None },
        ];
        let schema = pipeline_param_schema();
        let published: Vec<String> = schema["items"]["properties"]["type"]["enum"]
            .as_array()
            .expect("the form declares the discriminator")
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        for v in &variants {
            let tag = serde_json::to_value(v).unwrap()["type"].as_str().unwrap().to_string();
            assert!(published.contains(&tag), "step type {tag} runs but is not published: {published:?}");
        }
        assert_eq!(published.len(), variants.len(), "the form names a type the executor cannot run");
    }

    /// Fields the executor reads must be publishable — a form that omits one sends the model
    /// back to prose for it.
    #[test]
    fn the_form_declares_the_fields_the_variants_carry() {
        let schema = pipeline_param_schema();
        let props = schema["items"]["properties"].as_object().unwrap();
        for f in ["path", "tool", "server", "arguments", "inputData", "inputMap", "url", "method",
                  "body", "headers", "instruction", "model", "field", "op", "value", "slug",
                  "spec", "allowOverwrite", "items", "steps", "maxItems", "continueOnError"] {
            assert!(props.contains_key(f), "the form omits `{f}`");
        }
    }
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
            PipelineStep::ForEach { .. } => "FOREACH",
        }
    }
}

/// Absorb the plan-step dialect in a pipeline args object (2026-07-12 20차 실측: 모델이
/// schedule_task 파이프라인 스텝을 플랜 스텝 어휘 `{tool, args}`(type 없음)로 씀 → "type
/// 누락" 거부 → 마지막 라운드라 재시도 못 하고 소진). Same class as the fence lenient
/// parser / repair_tool_args: the dialect is unambiguous, so the parser absorbs it.
/// - a step without `type` gets it inferred from its signature field
///   (`tool`→TOOL_CALL, `path`→EXECUTE, `url`→NETWORK_REQUEST, `server`→MCP_CALL,
///    `instruction`→LLM_TRANSFORM — unambiguous keys only, never guesses otherwise)
/// - a lowercase/mixed-case `type` string is canonicalized to UPPER_SNAKE
/// Never overwrites a present, already-uppercase type. Applies to FOREACH bodies too — whatever
/// wrote the outer steps wrote the inner ones the same way.
pub fn normalize_pipeline_dialect(args: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(serde_json::Value::Array(steps)) = args.get_mut("pipeline") else {
        return;
    };
    normalize_steps(steps);
}

fn normalize_steps(steps: &mut Vec<serde_json::Value>) {
    for step in steps {
        // A step that arrived as a JSON *string* — the model serialised each element instead of
        // the array (2026-08-01: every step of a sweep pipeline came through quoted, and the
        // deserializer's "expected internally tagged enum" told the model nothing it could act
        // on). Same class as the stringified-field absorber in ModuleManager: the intent is
        // unambiguous, so parse it rather than teach it.
        if let serde_json::Value::String(raw) = &*step {
            if let Ok(parsed @ serde_json::Value::Object(_)) =
                serde_json::from_str::<serde_json::Value>(raw.trim())
            {
                *step = parsed;
            }
        }
        let Some(o) = step.as_object_mut() else { continue };
        if let Some(serde_json::Value::Array(inner)) = o.get_mut("steps") {
            normalize_steps(inner);
        }
        if let Some(serde_json::Value::String(t)) = o.get_mut("type") {
            let up = t.to_uppercase();
            if up != *t {
                *t = up;
            }
            continue;
        }
        let inferred = if o.contains_key("tool") {
            Some("TOOL_CALL")
        } else if o.contains_key("path") {
            Some("EXECUTE")
        } else if o.contains_key("url") {
            Some("NETWORK_REQUEST")
        } else if o.contains_key("server") {
            Some("MCP_CALL")
        } else if o.contains_key("instruction") {
            Some("LLM_TRANSFORM")
        } else {
            None
        };
        if let Some(t) = inferred {
            o.insert(
                "type".to_string(),
                serde_json::Value::String(t.to_string()),
            );
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
    async fn llm_transform(
        &self,
        instruction: &str,
        input_text: &str,
        model: Option<&str>,
    ) -> InfraResult<String>;
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
    async fn llm_transform(
        &self,
        _instruction: &str,
        _input_text: &str,
        _model: Option<&str>,
    ) -> InfraResult<String> {
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
                PipelineStep::ForEach { items, steps: inner, .. } => {
                    if items.is_null() {
                        return Some(format!("[Step {n}] FOREACH에 items가 없습니다 (예: \"$step2.orders\")."));
                    }
                    if inner.is_empty() {
                        return Some(format!("[Step {n}] FOREACH에 실행할 steps가 없습니다."));
                    }
                    // Nesting is refused rather than supported: the useful cases are one level
                    // deep, and a nested loop multiplies side effects by two unchecked lengths.
                    if inner.iter().any(|s| matches!(s, PipelineStep::ForEach { .. })) {
                        return Some(format!("[Step {n}] FOREACH 안에 FOREACH를 넣을 수 없습니다."));
                    }
                    if let Some(err) = self.validate_pipeline(inner) {
                        return Some(format!("[Step {n}] FOREACH 안 {err}"));
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
                    return unresolved_ref_fail_at("EXECUTE", &bad, Some(step_results.len()));
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
                    return unresolved_ref_fail_at("MCP_CALL", &bad, Some(step_results.len()));
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
                // NETWORK_REQUEST 필드(url/body/headers)는 $prev 해석 대상이 아니다(inputMap 없는
                // 스텝) — 참조가 literal 로 나가면 영문 모를 DNS/HTTP 에러가 된다. 다른 스텝들과
                // 같은 규약으로 fail-fast (동적 값 = TOOL_CALL network_request + inputMap 안내).
                let url_v = Value::String(url.clone());
                for v in [Some(&url_v), body.as_ref(), headers.as_ref()].into_iter().flatten() {
                    if let Some(bad) = crate::utils::pipeline_resolver::find_unresolved_ref(v) {
                        return StepOutcome::Fail(format!(
                            "NETWORK_REQUEST 미해석 참조: '{bad}' — 이 스텝의 url/body/headers 는 $prev 치환을 지원하지 않습니다. 동적 값이 필요하면 TOOL_CALL(tool=network_request) + inputMap 을 사용하세요."
                        ));
                    }
                }
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
                model,
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
                match self
                    .executor
                    .llm_transform(instruction, &input_text, model.as_deref())
                    .await
                {
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
                // spec 안 $prev/$stepN 은 해석되지 않는다 — literal 로 저장되면 페이지가 조용히
                // 깨진다(2026-07-18 실측: data:"$prev...stk_dt_pole_chart_qry" 가 그대로 발행 +
                // auto-cache 절단이라 원리적으로도 성립 불가). 저장 전 fail-fast + 정공 안내.
                if let Some(bad) =
                    crate::utils::pipeline_resolver::find_unresolved_ref(&spec_value)
                {
                    return StepOutcome::Fail(format!(
                        "SAVE_PAGE 실패: spec 안에 해석되지 않는 참조 '{bad}' — spec 내부의 $prev/$stepN 은 지원되지 않습니다. 데이터가 매번 갱신되는 페이지는 spec 에 module 블록({{\"type\":\"module\",\"props\":{{\"module\",\"action\",\"args\",\"when\":\"publish\"}}}})을 넣고 크론 targetPath 를 'rebake:<slug>' 로 등록하세요 (SAVE_PAGE 파이프라인 재발행 불필요)."
                    ));
                }
                let allow = allow_overwrite.unwrap_or(false);
                match self.executor.save_page(&slug_str, &spec_value, allow).await {
                    Ok(v) => StepOutcome::Continue(v),
                    Err(e) => StepOutcome::Fail(format!("SAVE_PAGE 실패: {e}")),
                }
            }
            PipelineStep::ForEach {
                items,
                steps: inner,
                max_items,
                continue_on_error,
            } => {
                let resolved =
                    crate::utils::pipeline_resolver::resolve_value(items, prev, step_results);
                if let Some(bad) = crate::utils::pipeline_resolver::find_unresolved_ref(&resolved) {
                    return unresolved_ref_fail_at("FOREACH", &bad, Some(step_results.len()));
                }
                let Some(list) = resolved.as_array() else {
                    return StepOutcome::Fail(format!(
                        "FOREACH items 가 배열이 아닙니다 (받은 값: {}).",
                        type_name_of(&resolved)
                    ));
                };
                let cap = max_items.unwrap_or(MAX_FOREACH_ITEMS).min(MAX_FOREACH_ITEMS);
                let dropped = list.len().saturating_sub(cap);
                if dropped > 0 {
                    // Saying so is the point: a truncated run that reports success reads as
                    // "everything was handled".
                    self.log.info(&format!(
                        "[Pipeline] FOREACH: {} 개 중 {} 개만 실행합니다 (상한 {}).",
                        list.len(),
                        cap,
                        cap
                    ));
                }
                let keep_going = continue_on_error.unwrap_or(false);
                let mut results: Vec<Value> = Vec::new();
                let mut failed: Vec<Value> = Vec::new();
                for (idx, item) in list.iter().take(cap).enumerate() {
                    let mut inner_prev = item.clone();
                    let mut item_error: Option<String> = None;
                    for st in inner {
                        // Inner steps keep seeing the OUTER `$stepN`, because that is where the
                        // things a loop body needs usually are — the cache key fetched once
                        // before the loop, the config read in step 1. `$prev` carries the item
                        // into the first inner step and the previous inner result after that.
                        match Box::pin(self.run_step(st, &inner_prev, step_results)).await {
                            StepOutcome::Continue(v) => {
                                inner_prev = v;
                            }
                            StepOutcome::EarlyExit(v) => {
                                inner_prev = v;
                                break;
                            }
                            StepOutcome::Fail(e) => {
                                item_error = Some(e);
                                break;
                            }
                        }
                    }
                    match item_error {
                        None => results.push(inner_prev),
                        Some(e) => {
                            let row = serde_json::json!({"index": idx, "error": e});
                            if !keep_going {
                                return StepOutcome::Fail(format!(
                                    "FOREACH {} 번째 항목 실패: {}",
                                    idx + 1,
                                    row["error"].as_str().unwrap_or("")
                                ));
                            }
                            failed.push(row);
                        }
                    }
                }
                StepOutcome::Continue(serde_json::json!({
                    "count": results.len(),
                    "results": results,
                    "failed": failed,
                    "dropped": dropped,
                }))
            }
            PipelineStep::ToolCall {
                tool,
                input_data,
                input_map,
            } => {
                let input = resolve_pipeline_input(input_data, input_map, prev, step_results);
                if let Some(bad) = crate::utils::pipeline_resolver::find_unresolved_ref(&input) {
                    return unresolved_ref_fail_at("TOOL_CALL", &bad, Some(step_results.len()));
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
/// The unresolved-reference message, told with the two facts that actually resolve it: how many
/// steps have run, and that `$stepN` counts from zero.
///
/// `$step1` looks like "the first step" and is the second — the pipeline log calls them Step 1/4
/// while the reference base is 0, so a reader following the log writes the wrong index and gets
/// "no such path" (2026-08-01: `$step2.runs` for the second step resolved to a step that had not
/// run). The indexing cannot change without breaking every stored pipeline, so the error says it.
fn unresolved_ref_fail_at(kind: &str, bad: &str, ran: Option<usize>) -> StepOutcome {
    let counted = match ran {
        Some(n) if n > 0 => format!(
            " 지금까지 {n}개 스텝이 끝났습니다 — **$stepN 은 0부터** 세므로 첫 스텝은 $step0, 직전 스텝은 $step{}.",
            n - 1
        ),
        Some(_) => " 아직 끝난 스텝이 없습니다 — 첫 스텝에서는 $prev·$stepN 을 쓸 수 없습니다.".to_string(),
        None => " **$stepN 은 0부터** 세므로 첫 스텝은 $step0 입니다.".to_string(),
    };
    StepOutcome::Fail(format!(
        "{kind} 미해석 참조: '{bad}' — 그 경로가 없습니다.{counted} $prev = 직전 스텝 출력 자체(모듈 {{success,data}} 래핑은 자동 언랩)이며 .output 같은 래퍼를 지어내지 마세요. 이미 아는 값이면 참조 대신 literal 로 넣으세요."
    ))
}

/// (2)+(3) 호출 결과 → 스텝 outcome — envelope 실패 판정 + 성공 시 data 언랩.
fn type_name_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

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
    fn foreach_deserializes_and_names_itself() {
        let step: PipelineStep = serde_json::from_value(json!({
            "type": "FOREACH",
            "items": "$prev.orders",
            "steps": [{"type": "TOOL_CALL", "tool": "cache_read", "inputMap": {"key": "$prev.id"}}],
            "maxItems": 3
        }))
        .expect("FOREACH should parse");
        assert_eq!(step.step_type(), "FOREACH");
        match step {
            PipelineStep::ForEach { items, steps, max_items, continue_on_error } => {
                assert_eq!(items, json!("$prev.orders"));
                assert_eq!(steps.len(), 1);
                assert_eq!(max_items, Some(3));
                // Stopping on the first failure is the default — a half-placed list of orders
                // must not be reported as a completed run.
                assert_eq!(continue_on_error, None);
            }
            other => panic!("wrong variant: {}", other.step_type()),
        }
    }

    #[test]
    fn foreach_is_spelled_the_way_the_docs_spell_it() {
        for name in ["FOREACH", "FOR_EACH"] {
            let step: PipelineStep = serde_json::from_value(json!({
                "type": name, "items": [], "steps": [{"type": "TOOL_CALL", "tool": "x"}]
            }))
            .unwrap_or_else(|e| panic!("{name} should parse: {e}"));
            assert_eq!(step.step_type(), "FOREACH");
        }
        // And it round-trips as the documented spelling, so a stored pipeline reads back.
        let step = PipelineStep::ForEach {
            items: json!([]), steps: vec![], max_items: None, continue_on_error: None,
        };
        let wire = serde_json::to_value(&step).expect("serialize");
        assert_eq!(wire["type"], "FOREACH");
    }

    #[test]
    fn stringified_steps_are_absorbed_including_inside_a_loop() {
        // What actually arrived: every element serialised as a string, FOREACH body included.
        let mut args = serde_json::Map::new();
        args.insert("pipeline".into(), json!([
            r#"{"type":"TOOL_CALL","tool":"sysmod_yfinance","inputData":{"action":"history"}}"#,
            {
                "type": "foreach",
                "items": "$step1.runs",
                "steps": [r#"{"type":"tool_call","tool":"sysmod_technical_analysis"}"#]
            }
        ]));
        normalize_pipeline_dialect(&mut args);
        let steps: Vec<PipelineStep> =
            serde_json::from_value(args["pipeline"].clone()).expect("should deserialize");
        assert_eq!(steps[0].step_type(), "TOOL_CALL");
        assert_eq!(steps[1].step_type(), "FOREACH");
        let PipelineStep::ForEach { steps: inner, .. } = &steps[1] else { panic!() };
        assert_eq!(inner[0].step_type(), "TOOL_CALL");
    }

    #[test]
    fn foreach_body_can_reach_the_step_before_the_loop() {
        // The shape every sweep needs: fetch once, then repeat something that uses both the item
        // and that one fetch. If `$step1` resolved to an inner result instead, the body would
        // silently receive the wrong value rather than fail.
        let step: PipelineStep = serde_json::from_value(json!({
            "type": "FOREACH",
            "items": "$step2.runs",
            "steps": [{
                "type": "TOOL_CALL",
                "tool": "sysmod_technical_analysis",
                "inputData": "$prev.args",
                "inputMap": {"barsCacheKey": "$step0._cacheKey"}
            }]
        }))
        .expect("FOREACH should parse");
        let PipelineStep::ForEach { steps, .. } = &step else { panic!("wrong variant") };
        let PipelineStep::ToolCall { input_data, input_map, .. } = &steps[0] else {
            panic!("wrong inner variant")
        };
        // `$stepN` indexes the pipeline array from zero: the fetch is step 0, the plan step 1.
        let outer = vec![json!({"_cacheKey": "k-1"}), json!({"runs": []})];
        let item = json!({"args": {"action": "signals", "rules": []}});
        let resolved = resolve_pipeline_input(input_data, input_map, &item, &outer);
        assert_eq!(resolved["action"], "signals");
        assert_eq!(resolved["barsCacheKey"], "k-1");
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

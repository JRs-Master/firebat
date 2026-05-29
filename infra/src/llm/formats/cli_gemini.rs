//! Gemini CLI — `gemini -p` 자식 프로세스 (옛 TS `cli-gemini.ts` 1:1 port).
//!
//! 핵심 기능:
//! - `gemini -p <prompt> --output-format stream-json --approval-mode yolo`
//! - `-m <cli_model>` (CLI 모델 ID)
//! - `--resume <session_id>` (멀티턴) — 실패 시 자동 재시도 (resume 없이)
//! - workspace 디렉토리 (cwd) 구성:
//!   - `<workspace>/GEMINI.md` — Firebat User AI 페르소나 + Gemini CLI 도구 prefix 규칙 + 환경 노출 금지
//!   - `<workspace>/.gemini/settings.json` — `mcpServers.firebat` (HTTP streamable 우선) + `coreTools=[]` + `excludeTools` (내장 차단) + `model.thinkingConfig` (thinking 출력 차단)
//! - 첨부 이미지: workspace 내부 임시 파일 + `@<path>` 구문 (workspace 외 차단됨)
//! - stream-json output: `init/message(thought)/tool_use/tool_result/error/result`
//! - tool_use_id 매칭 → render_* / pending / suggestions 추출
//! - 인라인 `[Thought: true/false]` 마커 stateful 파서 (청크 경계 넘어 isInThought 보존)
//! - `mcp_firebat_render_chart` → `render_chart` prefix strip

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

use crate::llm::adapter::FormatHandler;
use crate::llm::formats::cli_image_helper::{cleanup_temp_file, write_image_temp_file};
use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmTextResponse, LlmToolResponse, ToolDefinition, ToolResult,
};
use firebat_core::utils::render_map::render_tool_map;

pub struct GeminiCliHandler;

impl GeminiCliHandler {
    pub fn new() -> Self {
        Self
    }

    fn workspace_dir() -> PathBuf {
        std::env::temp_dir().join("firebat-gemini-workspace")
    }

    /// `mcp_firebat_schedule_task` / `mcp__firebat__schedule_task` → `schedule_task`.
    /// 옛 TS `stripGeminiMcpPrefix` 1:1.
    fn strip_gemini_mcp_prefix(name: &str) -> &str {
        if let Some(s) = name.strip_prefix("mcp_firebat_") {
            return s;
        }
        if let Some(s) = name.strip_prefix("mcp__") {
            if let Some(idx) = s.find("__") {
                return &s[(idx + 2)..];
            }
        }
        name
    }

    /// workspace 구성 — GEMINI.md (system prompt + 도구 prefix 규칙) + .gemini/settings.json (MCP).
    /// 옛 TS `ensureGeminiWorkspace` 1:1.
    fn ensure_workspace(
        system_prompt: Option<&str>,
        internal_mcp_token: Option<&str>,
        base_url: Option<&str>,
    ) -> Option<PathBuf> {
        let workspace = Self::workspace_dir();
        let gemini_dir = workspace.join(".gemini");
        std::fs::create_dir_all(&gemini_dir).ok()?;

        if let Some(sp) = system_prompt {
            // Gemini CLI 전용 도구 prefix 규칙 + 환경 정보 노출 금지 — 옛 TS 1:1.
            let gemini_cli_note = "\n\n## Gemini CLI 전용 도구 이름 규칙 (매우 중요)\n\n이 런타임에서는 Firebat 내부 도구가 MCP 서버 `firebat` 경유로 등록됩니다. 시스템 프롬프트·도구 문서에 적힌 모든 Firebat 도구 이름 (render, sysmod_*, schedule_task, run_task, save_page, write_file, suggest, request_secret 등) 은 호출 시 반드시 `mcp_firebat_` 접두사를 붙이세요.\n\n예시: `render` → `mcp_firebat_render`, `sysmod_kiwoom_quote` → `mcp_firebat_sysmod_kiwoom_quote`, `schedule_task` → `mcp_firebat_schedule_task`\n\n외부 MCP (gmail 등) 는 각자 네임스페이스 규칙을 따름. 접두사 없이 호출 시 'Tool not found' 로 실패합니다.\n\n## 환경 정보 노출 절대 금지\n현재 작업 디렉토리(/tmp/firebat-gemini-workspace 등), 이 `GEMINI.md` 파일, `.gemini/settings.json`, OS 정보, 세션 메타데이터 등 **시스템·환경 정보를 사용자 답변·도구 인자에 절대 노출하지 마라**.\n\n- \"위/이전/방금/그/이거/저번\" 같은 사용자 참조 표현은 **chat history (대화 기록) 의미**. workspace 파일·환경 정보 절대 아님.\n- 사용자가 \"위 대화 요약\" 등을 요청하면 chat history 와 자동 로드된 컨텍스트를 참조. 이 GEMINI.md 나 settings.json 내용을 답변·카톡 등에 포함시키면 안 됨.\n- \"[Gemini CLI 세션 요약]\", \"운영체제: Linux\", \"작업 디렉토리: /tmp/...\" 같은 메타 응답 절대 금지.\n";
            std::fs::write(workspace.join("GEMINI.md"), format!("{}{}", sp, gemini_cli_note))
                .ok()?;
        }

        // 프로젝트 로컬 MCP 설정
        let mcp_servers = if let Some(token) = internal_mcp_token {
            let mcp_path = std::env::var("FIREBAT_MCP_PATH")
                .unwrap_or_else(|_| "/api/mcp-internal".to_string());
            let url = format!(
                "{}{}",
                base_url.unwrap_or("http://127.0.0.1:3000"),
                mcp_path
            );
            serde_json::json!({
                "firebat": {
                    "httpUrl": url,
                    "headers": { "Authorization": format!("Bearer {}", token) },
                    "timeout": 30000_u64
                }
            })
        } else {
            let project_dir = std::env::current_dir().ok()?;
            let stdio_path = project_dir.join("mcp").join("stdio-user-ai.ts");
            serde_json::json!({
                "firebat": {
                    "command": "npx",
                    "args": ["tsx", stdio_path.to_string_lossy().to_string()],
                    "cwd": project_dir.to_string_lossy().to_string(),
                    "timeout": 30000_u64
                }
            })
        };

        // thinking 출력 활성 — 옛 Node 버전 (이전 주석) 은 'Comparing Major Tech Stocks I'm now...'
        // 같은 reasoning 누출 차단 목적으로 includeThoughts:false 였으나, 현재는 frontend ThinkingBlock
        // 본문에 thinking 을 가시화하므로 stream 안 thought part 를 받아야 한다. budget -1 = 무제한
        // (Gemini 권장 default). 인라인 [Thought:true/false] 마커 파서가 이미 본문/thinking 분리.
        let settings = serde_json::json!({
            "mcpServers": mcp_servers,
            "autoMemory": false,
            "telemetry": { "enabled": false },
            "coreTools": [],
            "excludeTools": [
                "ShellTool", "ReadFileTool", "WriteFileTool", "EditTool",
                "WebFetchTool", "WebSearchTool", "MemoryTool", "GlobTool", "GrepTool",
                "EnterPlanMode", "ExitPlanMode", "PlanMode"
            ],
            "model": { "thinkingConfig": { "includeThoughts": true, "thinkingBudget": -1 } },
            "ui": { "inlineThinkingMode": "off" }
        });
        let payload = serde_json::to_string_pretty(&settings).ok()?;
        std::fs::write(gemini_dir.join("settings.json"), payload).ok()?;
        Some(workspace)
    }

    /// resume 미사용 시 history 를 prompt 앞에 병합 (최근 10턴, 옛 TS `buildPromptWithHistory` 1:1).
    fn build_prompt_with_history(
        prompt: &str,
        history: &[firebat_core::ports::ChatMessage],
    ) -> String {
        if history.is_empty() {
            return prompt.to_string();
        }
        let recent_start = history.len().saturating_sub(10);
        let mut hist_lines: Vec<String> = Vec::new();
        for h in &history[recent_start..] {
            let role = if h.role == "assistant" { "AI" } else { "사용자" };
            let content_str = match &h.content {
                serde_json::Value::String(s) if !s.trim().is_empty() => s.clone(),
                v => serde_json::to_string(v).unwrap_or_default(),
            };
            hist_lines.push(format!("{}: {}", role, content_str));
        }
        format!(
            "[이전 대화]\n{}\n\n[현재 요청]\n{}",
            hist_lines.join("\n\n"),
            prompt
        )
    }

    /// 핵심 실행 — workspace + spawn + stream-json 파싱.
    /// resume_attempt: false → resume 사용, 실패 시 true 로 재시도. 옛 TS 1:1.
    async fn run_cli(
        binary: &str,
        prompt: &str,
        opts: &LlmCallOpts,
        with_tools: bool,
        skip_resume: bool,
    ) -> InfraResult<CliRunOutcome> {
        // workspace 구성 (도구 호출 모드만)
        let workspace = if with_tools {
            Self::ensure_workspace(
                opts.system_prompt.as_deref(),
                opts.mcp_token.as_deref(),
                opts.mcp_base_url.as_deref(),
            )
        } else {
            None
        };

        // 첨부 이미지 — workspace 내부 (workspace 외 경로 @-syntax 차단)
        let img_dir = workspace.as_deref().map(|p| p.to_string_lossy().to_string());
        let tmp_image = write_image_temp_file(
            opts.image.as_deref(),
            opts.image_mime_type.as_deref(),
            img_dir.as_deref(),
        );

        // resume 미사용 시 history 주입
        let prompt_body = if !skip_resume && opts.cli_resume_session_id.is_some() {
            prompt.to_string()
        } else {
            Self::build_prompt_with_history(prompt, &opts.history)
        };
        // system_prompt 는 GEMINI.md 로 이동 — with_tools 면 prompt 에 미포함. text 모드 (no GEMINI.md) 는 inline.
        let base_final_prompt = if with_tools {
            prompt_body
        } else {
            match opts.system_prompt.as_deref() {
                Some(sp) if !sp.is_empty() => format!(
                    "<SYSTEM_INSTRUCTIONS>\n{}\n</SYSTEM_INSTRUCTIONS>\n\n<USER_QUERY>\n{}\n</USER_QUERY>\n\n위 SYSTEM_INSTRUCTIONS 는 행동 규범. 반복·요약 금지. USER_QUERY 에만 답하세요.",
                    sp, prompt_body
                ),
                _ => prompt_body,
            }
        };
        let final_prompt = match &tmp_image {
            Some(t) => format!("@{}\n\n{}", t.path, base_final_prompt),
            None => base_final_prompt,
        };

        let mut args: Vec<String> = vec![
            "-p".to_string(),
            final_prompt,
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--approval-mode".to_string(),
            "yolo".to_string(),
        ];
        if let Some(m) = opts.cli_model.as_deref() {
            if !m.is_empty() {
                args.push("-m".to_string());
                args.push(m.to_string());
            }
        }
        if !skip_resume {
            if let Some(rid) = opts.cli_resume_session_id.as_deref() {
                if !rid.is_empty() {
                    args.push("--resume".to_string());
                    args.push(rid.to_string());
                }
            }
        }

        let mut cmd = Command::new(binary);
        cmd.args(&args);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        if let Some(ws) = &workspace {
            cmd.current_dir(ws);
        }

        let child = cmd.spawn().map_err(|e| {
            cleanup_temp_file(tmp_image.as_ref().map(|t| t.path.as_str()));
            format!(
                "Gemini CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `gemini auth login` 한 번 실행했는지 확인",
                binary, binary
            )
        })?;

        let output = child.wait_with_output().await.map_err(|e| {
            cleanup_temp_file(tmp_image.as_ref().map(|t| t.path.as_str()));
            format!("Gemini CLI wait 실패: {e}")
        })?;

        cleanup_temp_file(tmp_image.as_ref().map(|t| t.path.as_str()));

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr_buf = String::from_utf8_lossy(&output.stderr).to_string();

        let mut outcome = CliRunOutcome::default();
        let mut text_parts: Vec<String> = Vec::new();
        let mut pending_calls: HashMap<String, PendingMcpCall> = HashMap::new();
        let mut errored = false;
        let mut error_msg: Option<String> = None;
        // 인라인 [Thought: true/false] 마커 stateful 파서 — 청크 경계 보존
        let mut is_in_thought = false;

        for line in stdout.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let ev: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // init: session_id
            if ev_type == "init" {
                if outcome.session_id.is_none() {
                    if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                        outcome.session_id = Some(sid.to_string());
                    }
                }
                continue;
            }

            // 에러 이벤트
            if ev_type == "error" || ev.get("error").is_some() {
                errored = true;
                error_msg = ev
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| {
                        ev.get("error")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                    })
                    .or_else(|| Some("Gemini 오류".to_string()));
                continue;
            }

            // message — assistant text + thought 분리
            if ev_type == "message" {
                let role = ev.get("role").and_then(|v| v.as_str()).unwrap_or("");
                if role != "assistant" {
                    continue;
                }
                let raw = match ev.get("content").and_then(|v| v.as_str()) {
                    Some(c) => c.to_string(),
                    None => continue,
                };
                let is_thought_event =
                    ev.get("thought").and_then(|v| v.as_bool()).unwrap_or(false);
                if is_thought_event {
                    // event-level thought 플래그 → 통째 thinking 누적.
                    // 옛 Node 의 onChunk({type:'thinking', content}) 와 동등.
                    if !raw.is_empty() {
                        if !outcome.thinking_acc.is_empty() {
                            outcome.thinking_acc.push('\n');
                        }
                        outcome.thinking_acc.push_str(&raw);
                    }
                    continue;
                }
                // 인라인 [Thought: true/false] 마커 stateful 파서 — text 와 thinking 분리 누적.
                let mut cursor = 0usize;
                let bytes = raw.as_bytes();
                let pattern = "[Thought:";
                // 본문 segment 처리 — isInThought 상태에 따라 text_parts 또는 thinking_acc 누적.
                let push_segment = |seg: &str,
                                    in_thought: bool,
                                    text_parts: &mut Vec<String>,
                                    thinking_acc: &mut String| {
                    if seg.trim().is_empty() {
                        return;
                    }
                    if in_thought {
                        if !thinking_acc.is_empty() {
                            thinking_acc.push('\n');
                        }
                        thinking_acc.push_str(seg);
                    } else {
                        text_parts.push(seg.to_string());
                    }
                };
                while let Some(idx) = raw[cursor..].find(pattern) {
                    let abs_idx = cursor + idx;
                    // 마커 이전 segment
                    if abs_idx > cursor {
                        let seg = &raw[cursor..abs_idx];
                        push_segment(seg, is_in_thought, &mut text_parts, &mut outcome.thinking_acc);
                    }
                    // ] 찾기
                    let close_search = &raw[abs_idx..];
                    let Some(close_rel) = close_search.find(']') else {
                        cursor = bytes.len();
                        break;
                    };
                    let abs_close = abs_idx + close_rel;
                    let marker_body = &raw[(abs_idx + pattern.len())..abs_close];
                    is_in_thought = marker_body.trim() == "true";
                    cursor = abs_close + 1;
                }
                if cursor < raw.len() {
                    let seg = &raw[cursor..];
                    push_segment(seg, is_in_thought, &mut text_parts, &mut outcome.thinking_acc);
                }
                continue;
            }

            // tool_use — 도구 호출 시작
            if ev_type == "tool_use" {
                let raw_name = ev
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .or_else(|| ev.get("name").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let tool_id = ev
                    .get("tool_id")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let params = ev
                    .get("parameters")
                    .cloned()
                    .or_else(|| ev.get("input").cloned())
                    .unwrap_or(serde_json::json!({}));
                if raw_name.is_empty() {
                    continue;
                }
                let bare = Self::strip_gemini_mcp_prefix(raw_name).to_string();
                outcome.used_tools.push(bare.clone());
                // 도구 호출 마커 — frontend ThinkingBlock 본문에 누적 표시.
                // 옛 Node 의 onChunk({type:'thinking', content:'[도구 호출: name]'}) 와 동등.
                if !outcome.thinking_acc.is_empty() {
                    outcome.thinking_acc.push('\n');
                }
                outcome.thinking_acc.push_str(&format!("[도구 호출: {}]", bare));
                if let Some(id) = tool_id {
                    pending_calls.insert(
                        id,
                        PendingMcpCall {
                            name: bare,
                            parameters: params,
                        },
                    );
                }
                continue;
            }

            // tool_result — tool_id 매칭, output JSON 파싱
            if ev_type == "tool_result" {
                let tool_id = ev
                    .get("tool_id")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let pending = match tool_id.as_deref() {
                    Some(id) => pending_calls.remove(id),
                    None => None,
                };
                let Some(pending) = pending else { continue };
                let output = ev.get("output");
                let output_str = output
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| output.map(|v| v.to_string()))
                    .unwrap_or_default();
                if output_str.is_empty() {
                    continue;
                }
                let payload: serde_json::Value = match serde_json::from_str(&output_str) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                // 도구 결과 요약 — 성공/실패 모두 Frontend 에러 뱃지 UI 채널로 push.
                {
                    let success = payload
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let error_msg = payload
                        .get("error")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    outcome.tool_results.push(firebat_core::ports::ToolResultSummary {
                        name: pending.name.clone(),
                        success,
                        error: error_msg,
                        input: Some(pending.parameters.clone()),
                    });
                }
                if !payload.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                    continue;
                }
                // 1a) 단일 render 도구 (옵션 E hybrid, 2026-05-14) — payload.blocks 배열 그대로 push.
                if pending.name == "render" {
                    if let Some(blocks) = payload.get("blocks").and_then(|v| v.as_array()) {
                        for b in blocks {
                            outcome.rendered_blocks.push(b.clone());
                        }
                        continue;
                    }
                }
                // 1b) 옛 render_* / render_iframe / component fallback (legacy 호환).
                let html_content =
                    payload.get("htmlContent").and_then(|v| v.as_str()).map(String::from);
                let component = payload
                    .get("component")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(String::from);
                if pending.name == "render_iframe" && html_content.is_some() {
                    let mut block = serde_json::json!({
                        "type": "html",
                        "htmlContent": html_content.unwrap(),
                    });
                    if let Some(h) = payload.get("htmlHeight").and_then(|v| v.as_str()) {
                        block["htmlHeight"] = serde_json::Value::String(h.to_string());
                    }
                    outcome.rendered_blocks.push(block);
                } else if let Some(comp) = component {
                    outcome.rendered_blocks.push(serde_json::json!({
                        "type": "component",
                        "name": comp,
                        "props": payload.get("props").cloned().unwrap_or(serde_json::json!({})),
                    }));
                } else if let Some(comp_name) = render_tool_map().get(pending.name.as_str()) {
                    outcome.rendered_blocks.push(serde_json::json!({
                        "type": "component",
                        "name": *comp_name,
                        "props": pending.parameters.clone(),
                    }));
                }
                // 2) pending
                let pending_flag =
                    payload.get("pending").and_then(|v| v.as_bool()).unwrap_or(false);
                if pending_flag {
                    if let Some(pid) = payload.get("planId").and_then(|v| v.as_str()) {
                        let summary = payload
                            .get("summary")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&pending.name)
                            .to_string();
                        let mut action = serde_json::json!({
                            "planId": pid,
                            "name": pending.name.clone(),
                            "summary": summary,
                            "args": pending.parameters.clone(),
                        });
                        if payload.get("status").and_then(|v| v.as_str()) == Some("past-runat") {
                            action["status"] = serde_json::Value::String("past-runat".to_string());
                        }
                        if let Some(ora) = payload.get("originalRunAt").and_then(|v| v.as_str()) {
                            action["originalRunAt"] = serde_json::Value::String(ora.to_string());
                        }
                        outcome.pending_actions.push(action);
                    }
                }
                // 3) suggest / propose_plan → suggestions
                if (pending.name == "suggest" || pending.name == "propose_plan")
                    && payload.get("suggestions").and_then(|v| v.as_array()).is_some()
                {
                    for s in payload.get("suggestions").unwrap().as_array().unwrap() {
                        outcome.suggestions.push(s.clone());
                    }
                }
                continue;
            }
            // 그 외 (`result` 등) — 통계만, 무시
        }

        if errored {
            return Err(error_msg.unwrap_or_else(|| "Gemini CLI 알 수 없는 에러".to_string()));
        }
        outcome.text = text_parts.join("");
        if !output.status.success() {
            return Err(format!(
                "Gemini 비정상 종료 (exit {:?}): {}",
                output.status.code(),
                stderr_buf.chars().take(500).collect::<String>()
            ));
        }
        Ok(outcome)
    }
}

#[derive(Default)]
struct CliRunOutcome {
    text: String,
    session_id: Option<String>,
    used_tools: Vec<String>,
    tool_results: Vec<firebat_core::ports::ToolResultSummary>,
    rendered_blocks: Vec<serde_json::Value>,
    pending_actions: Vec<serde_json::Value>,
    suggestions: Vec<serde_json::Value>,
    /// thought 본문 (event-level + 인라인 마커) + 도구 호출 마커 누적. 옛 Node 의
    /// onChunk({type:'thinking', ...}) 와 동등 — frontend ThinkingBlock bodyText 에 표시.
    /// streaming chunk emit 은 아직 X (turn 종료 후 batch 표시).
    thinking_acc: String,
}

struct PendingMcpCall {
    name: String,
    parameters: serde_json::Value,
}

#[async_trait::async_trait]
impl FormatHandler for GeminiCliHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        _api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        // text 모드 — workspace 사용 X (system_prompt 는 inline). 단 첨부 이미지가 있으면 workspace 안 임시 dir 필요.
        // 옛 TS 도 text 모드에서 GEMINI.md 미생성 → systemPrompt 가 prompt 에 inline. 단 workspace dir 자체는 항상 보장.
        let workspace = Self::workspace_dir();
        let _ = std::fs::create_dir_all(&workspace);
        let outcome = Self::run_cli(&config.endpoint, prompt, opts, false, false).await?;
        Ok(LlmTextResponse {
            text: outcome.text,
            model_id: config.id.clone(),
            cost_usd: Some(0.0),
            tokens_in: None,
            tokens_out: None,
        })
    }

    async fn ask_with_tools(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        // hosted MCP / CLI 자체 loop 모델 (features.mcp_connector=true) 은 빈 tools 여도
        // MCP config 가 필요하므로 ask_text 위임 금지.
        if tools.is_empty() && !config.features.mcp_connector {
            let r = self.ask_text(config, api_key, prompt, opts).await?;
            return Ok(LlmToolResponse {
                text: r.text,
                tool_calls: vec![],
                model_id: r.model_id,
                cost_usd: r.cost_usd,
                tokens_in: r.tokens_in,
                tokens_out: r.tokens_out,
                cli_session_id: None,
                response_id: None,
                ..Default::default()
            });
        }
        // 첫 시도: resume 사용
        let mut outcome = Self::run_cli(&config.endpoint, prompt, opts, true, false).await;
        // resume 실패 자동 재시도 (옛 TS 1:1) — Invalid session identifier / Error resuming session
        if let Err(err) = &outcome {
            if opts.cli_resume_session_id.is_some()
                && (err.contains("Invalid session identifier")
                    || err.contains("Error resuming session"))
            {
                outcome = Self::run_cli(&config.endpoint, prompt, opts, true, true).await;
            }
        }
        let outcome = outcome?;
        Ok(LlmToolResponse {
            text: outcome.text,
            tool_calls: vec![],
            model_id: config.id.clone(),
            cost_usd: Some(0.0),
            tokens_in: None,
            tokens_out: None,
            cli_session_id: outcome.session_id.clone(),
            response_id: outcome.session_id,
            internally_used_tools: outcome.used_tools,
            rendered_blocks: outcome.rendered_blocks,
            pending_actions: outcome.pending_actions,
            suggestions: outcome.suggestions,
            raw_model_parts: None,
            tool_results: outcome.tool_results,
            thinking_text: if outcome.thinking_acc.is_empty() { None } else { Some(outcome.thinking_acc) },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_gemini_mcp_prefix_basic() {
        assert_eq!(
            GeminiCliHandler::strip_gemini_mcp_prefix("mcp_firebat_render_chart"),
            "render_chart"
        );
        assert_eq!(
            GeminiCliHandler::strip_gemini_mcp_prefix("mcp__firebat__schedule_task"),
            "schedule_task"
        );
        assert_eq!(
            GeminiCliHandler::strip_gemini_mcp_prefix("render_chart"),
            "render_chart"
        );
    }

    #[test]
    fn build_prompt_with_history_prepends_block() {
        let history = vec![firebat_core::ports::ChatMessage {
            role: "assistant".to_string(),
            content: serde_json::Value::String("hello".to_string()),
            image: None,
            image_mime_type: None,
        }];
        let p = GeminiCliHandler::build_prompt_with_history("now", &history);
        assert!(p.contains("[이전 대화]"));
        assert!(p.contains("AI: hello"));
        assert!(p.ends_with("[현재 요청]\nnow"));
    }
}

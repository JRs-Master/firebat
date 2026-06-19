//! Codex CLI — `codex exec` 자식 프로세스 (옛 TS `cli-codex.ts` 1:1 port).
//!
//! 핵심 기능:
//! - `codex exec <prompt>` non-interactive
//! - `--json --skip-git-repo-check --sandbox read-only --ask-for-approval never`
//! - `--image <path>` (첨부 이미지)
//! - `--model <id>`
//! - `-c model_reasoning_effort="<level>"` (thinking)
//! - `exec resume <session_id> <prompt>` (멀티턴 resume)
//! - `CODEX_HOME` env + `config.toml` (`[mcp_servers.firebat] url + bearer_token_env_var`)
//! - `FIREBAT_MCP_TOKEN` env (config.toml `bearer_token_env_var` 와 짝)
//! - 기존 `~/.codex/auth.json` 복사 (구독 OAuth 세션 유지)
//! - stream-json output: `thread.started` / `turn.failed` / `item.completed (agent_message / mcp_tool_call)`
//! - `mcp_tool_call` 결과 → render_* / pending / suggestions 추출

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

pub struct CodexCliHandler;

impl CodexCliHandler {
    pub fn new() -> Self {
        Self
    }

    /// Firebat thinking level → Codex `model_reasoning_effort` 값.
    /// 옛 TS `mapThinkingToCodex` 1:1. max → xhigh 매핑 (Codex 는 max 미지원).
    fn map_thinking_to_codex(level: Option<&str>) -> Option<&'static str> {
        match level {
            Some("none") | None => None,
            Some("max") => Some("xhigh"),
            Some("minimal") => Some("minimal"),
            Some("low") => Some("low"),
            Some("medium") => Some("medium"),
            Some("high") => Some("high"),
            Some("xhigh") => Some("xhigh"),
            Some(_) => None,
        }
    }

    /// CODEX_HOME 디렉토리 생성 + config.toml + auth.json 복사.
    /// 옛 TS `ensureCodexHome` 1:1. HTTP MCP (`experimental_use_rmcp_client = true`) + `bearer_token_env_var`.
    fn ensure_codex_home(internal_mcp_token: Option<&str>, base_url: Option<&str>) -> Option<PathBuf> {
        let codex_home = std::env::temp_dir().join("firebat-codex-home");
        std::fs::create_dir_all(&codex_home).ok()?;

        // 기존 ~/.codex/auth.json 복사 (로그인 세션 유지)
        if let Some(home) =
            std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        {
            let real_auth = PathBuf::from(home).join(".codex").join("auth.json");
            let tmp_auth = codex_home.join("auth.json");
            if real_auth.exists() && !tmp_auth.exists() {
                let _ = std::fs::copy(&real_auth, &tmp_auth);
            }
        }

        let mut toml = String::new();
        if let Some(_token) = internal_mcp_token {
            let mcp_path = std::env::var("FIREBAT_MCP_PATH")
                .unwrap_or_else(|_| "/api/mcp-internal".to_string());
            let url = format!(
                "{}{}",
                base_url.unwrap_or("http://127.0.0.1:3000"),
                mcp_path
            );
            toml.push_str("[features]\nexperimental_use_rmcp_client = true\n\n");
            toml.push_str("[mcp_servers.firebat]\n");
            toml.push_str(&format!("url = \"{}\"\n", url));
            toml.push_str("bearer_token_env_var = \"FIREBAT_MCP_TOKEN\"\n");
        } else {
            // stdio fallback — Firebat Core 매번 재부팅. 토큰 미설정 시.
            let project_dir = std::env::current_dir().ok()?;
            let stdio_path = project_dir.join("mcp").join("stdio-user-ai.ts");
            let stdio_str = stdio_path.to_string_lossy().replace('\\', "\\\\");
            let cwd_str = project_dir.to_string_lossy().replace('\\', "\\\\");
            toml.push_str("[mcp_servers.firebat]\n");
            toml.push_str("command = \"npx\"\n");
            toml.push_str(&format!("args = [\"tsx\", \"{}\"]\n", stdio_str));
            toml.push_str(&format!("cwd = \"{}\"\n", cwd_str));
        }
        std::fs::write(codex_home.join("config.toml"), toml).ok()?;
        Some(codex_home)
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

    /// 도구 호출 인자 빌더.
    fn build_args(
        prompt: &str,
        opts: &LlmCallOpts,
        tmp_image_path: Option<&str>,
    ) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        let security_flags = [
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--ask-for-approval",
            "never",
        ];

        // resume 시 서브커맨드: `codex exec resume <session_id> <prompt>`
        if let Some(rid) = opts.cli_resume_session_id.as_deref() {
            if !rid.is_empty() {
                args.push("exec".to_string());
                args.push("resume".to_string());
                args.push(rid.to_string());
                args.push(prompt.to_string());
                for f in security_flags {
                    args.push(f.to_string());
                }
                if let Some(m) = opts.cli_model.as_deref() {
                    if !m.is_empty() {
                        args.push("--model".to_string());
                        args.push(m.to_string());
                    }
                }
                if let Some(p) = tmp_image_path {
                    args.push("--image".to_string());
                    args.push(p.to_string());
                }
                if let Some(eff) =
                    Self::map_thinking_to_codex(opts.thinking_level.as_deref())
                {
                    args.push("-c".to_string());
                    args.push(format!("model_reasoning_effort=\"{}\"", eff));
                }
                return args;
            }
        }
        // 일반: `codex exec <prompt>`
        args.push("exec".to_string());
        args.push(prompt.to_string());
        for f in security_flags {
            args.push(f.to_string());
        }
        if let Some(m) = opts.cli_model.as_deref() {
            if !m.is_empty() {
                args.push("--model".to_string());
                args.push(m.to_string());
            }
        }
        if let Some(p) = tmp_image_path {
            args.push("--image".to_string());
            args.push(p.to_string());
        }
        if let Some(eff) = Self::map_thinking_to_codex(opts.thinking_level.as_deref()) {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort=\"{}\"", eff));
        }
        args
    }

    /// stream-json (one event per line) 파싱 + render/pending/suggestions 추출.
    /// 옛 TS `runCodex` + `processLine` 1:1 (onChunk 콜백 제외).
    async fn run_cli(
        binary: &str,
        prompt: &str,
        opts: &LlmCallOpts,
        with_tools: bool,
    ) -> InfraResult<CliRunOutcome> {
        // 첨부 이미지 임시 파일
        let tmp_image =
            write_image_temp_file(opts.image.as_deref(), opts.image_mime_type.as_deref(), None);
        let tmp_image_path = tmp_image.as_ref().map(|t| t.path.as_str());

        // resume 미사용 시 history 주입 + system_prompt prepend
        let final_prompt = if opts.cli_resume_session_id.is_some() {
            prompt.to_string()
        } else {
            Self::build_prompt_with_history(prompt, &opts.history)
        };
        let prompt_with_system = match opts.system_prompt.as_deref() {
            Some(sp) if !sp.is_empty() => format!("{}\n\n{}", sp, final_prompt),
            _ => final_prompt,
        };

        let args = Self::build_args(&prompt_with_system, opts, tmp_image_path);

        // CODEX_HOME 설정 (도구 호출 모드만)
        let codex_home = if with_tools {
            Self::ensure_codex_home(opts.mcp_token.as_deref(), opts.mcp_base_url.as_deref())
        } else {
            None
        };

        let mut cmd = Command::new(binary);
        cmd.args(&args);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        if let Some(p) = &codex_home {
            cmd.env("CODEX_HOME", p);
        }
        if let Some(token) = opts.mcp_token.as_deref() {
            cmd.env("FIREBAT_MCP_TOKEN", token);
        }
        // 턴 종료/취소/SSE 끊김으로 future 가 drop 되면 codex 자식을 kill — orphan 누적(메모리→OOM) 방지.
        cmd.kill_on_drop(true);

        let child = cmd.spawn().map_err(|e| {
            cleanup_temp_file(tmp_image_path);
            format!(
                "Codex CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `codex login` 한 번 실행했는지 확인",
                binary, binary
            )
        })?;

        // 턴 타임아웃 — codex 가 hang 하면 wait_with_output 이 무한 블록. 초과 시 future drop → child drop
        // → kill_on_drop 이 프로세스 kill(orphan→OOM 방지). 배치(스트리밍 X)라 총 시간 기준, 정상 긴
        // 에이전트 턴(수분~십수분) 안 끊기게 넉넉히 20분.
        const CODEX_TURN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1200);
        let output = match tokio::time::timeout(CODEX_TURN_TIMEOUT, child.wait_with_output()).await {
            Ok(r) => r.map_err(|e| {
                cleanup_temp_file(tmp_image_path);
                format!("Codex CLI wait 실패: {e}")
            })?,
            Err(_) => {
                cleanup_temp_file(tmp_image_path);
                return Err(format!(
                    "Codex CLI turn timeout — {}초 초과로 종료(hang/orphan 방지)",
                    CODEX_TURN_TIMEOUT.as_secs()
                ));
            }
        };

        cleanup_temp_file(tmp_image_path);

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr_buf = String::from_utf8_lossy(&output.stderr).to_string();

        let mut outcome = CliRunOutcome::default();
        let mut text_parts: Vec<String> = Vec::new();
        let mut errored = false;
        let mut error_msg: Option<String> = None;
        // CLI 네이티브 계획 도구(update_plan → todo_list 아이템)는 turn 당 한 번만 "계획 정리" 표시로 통합.
        let mut plan_noted = false;

        for line in stdout.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let ev: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match ev_type {
                "thread.started" => {
                    if outcome.session_id.is_none() {
                        if let Some(tid) = ev.get("thread_id").and_then(|v| v.as_str()) {
                            outcome.session_id = Some(tid.to_string());
                        }
                    }
                }
                "turn.failed" => {
                    errored = true;
                    let err_msg = ev
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .or_else(|| {
                            ev.get("error").map(|e| {
                                serde_json::to_string(e).unwrap_or_default()
                            })
                        })
                        .unwrap_or_else(|| "Codex turn 실패".to_string());
                    error_msg = Some(err_msg);
                }
                "error" => {
                    errored = true;
                    error_msg = Some(
                        ev.get("message")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .unwrap_or_else(|| "Codex 오류".to_string()),
                    );
                }
                "turn.started" => {}
                "turn.completed" => {
                    // usage — 비용 통계 토큰. {input_tokens(캐시 포함 총 입력), cached_input_tokens(부분집합),
                    // output_tokens, reasoning_output_tokens}. 누적값이라 매번 덮어써 최종이 합계가 됨.
                    if let Some(usage) = ev.get("usage") {
                        let get_u = |key: &str| -> i64 {
                            usage.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
                        };
                        outcome.tokens_in = get_u("input_tokens");
                        outcome.tokens_out = get_u("output_tokens") + get_u("reasoning_output_tokens");
                        outcome.cached_tokens = get_u("cached_input_tokens");
                    }
                }
                "item.started" | "item.completed" | "item.updated" => {
                    let Some(item) = ev.get("item") else { continue };
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    // agent_message: 최종 텍스트 (completed 만)
                    if item_type == "agent_message" && ev_type == "item.completed" {
                        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                            text_parts.push(t.to_string());
                        }
                        continue;
                    }
                    // reasoning: thinking 누적 — frontend ThinkingBlock 본문에 표시.
                    // 옛 Node 의 onChunk({type:'thinking', content: item.text}) 와 동등.
                    // 동일 item 의 started/updated/completed 중복 emit 회피 — completed 만 채택.
                    if item_type == "reasoning" {
                        if ev_type == "item.completed" {
                            // codex stream-json 의 reasoning 형태:
                            //   { item: { type: "reasoning", text: "..." } }
                            // text 가 비어있고 summary 만 있는 변형도 일부 모델에서 관측 — fallback.
                            let reasoning_text = item
                                .get("text")
                                .and_then(|v| v.as_str())
                                .map(String::from)
                                .or_else(|| {
                                    item.get("summary")
                                        .and_then(|s| s.as_array())
                                        .map(|arr| {
                                            arr.iter()
                                                .filter_map(|s| s.get("text").and_then(|t| t.as_str()))
                                                .collect::<Vec<_>>()
                                                .join("\n")
                                        })
                                });
                            if let Some(t) = reasoning_text {
                                if !t.is_empty() {
                                    if !outcome.thinking_acc.is_empty() {
                                        outcome.thinking_acc.push('\n');
                                    }
                                    outcome.thinking_acc.push_str(&t);
                                }
                            }
                        }
                        continue;
                    }
                    // todo_list: Codex update_plan 의 codex exec --json 표출 — 모델 내부 계획 스캐폴드.
                    // 일반 도구로 노출하지 않고 turn 당 한 번 "계획 정리" 표시로 통합 (propose_plan 과 별개).
                    if item_type == "todo_list" {
                        if !plan_noted {
                            plan_noted = true;
                            if !outcome.thinking_acc.is_empty() {
                                outcome.thinking_acc.push('\n');
                            }
                            outcome.thinking_acc.push_str("[계획 정리]");
                        }
                        continue;
                    }
                    // mcp_tool_call: 도구 호출 + 결과
                    if item_type == "mcp_tool_call" {
                        let server =
                            item.get("server").and_then(|v| v.as_str()).unwrap_or("");
                        let tool_name =
                            item.get("tool").and_then(|v| v.as_str()).unwrap_or("");
                        if tool_name.is_empty() {
                            continue;
                        }
                        // CLI 네이티브 계획 도구가 MCP 경로로 들어오는 경우 방어 — 일반 도구로 노출 X.
                        if firebat_core::ports::is_native_plan_tool(tool_name) {
                            continue;
                        }
                        if ev_type == "item.started" {
                            outcome.used_tools.push(tool_name.to_string());
                            // 도구 호출 마커 — frontend ThinkingBlock 본문에 누적 표시.
                            // 옛 Node 의 onChunk({type:'thinking', content:'[도구 호출: name]'}) 와 동등.
                            if !outcome.thinking_acc.is_empty() {
                                outcome.thinking_acc.push('\n');
                            }
                            outcome.thinking_acc.push_str(&format!("[도구 호출: {}]", tool_name));
                            continue;
                        }
                        if ev_type == "item.completed" && server == "firebat" {
                            let result_obj = item.get("result");
                            let text_payload = result_obj
                                .and_then(|r| r.get("content"))
                                .and_then(|c| c.as_array())
                                .and_then(|arr| arr.first())
                                .and_then(|first| first.get("text").and_then(|t| t.as_str()))
                                .map(String::from);
                            let Some(text_payload) = text_payload else { continue };
                            let payload: serde_json::Value =
                                match serde_json::from_str(&text_payload) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                            let args = item.get("arguments").cloned().unwrap_or(serde_json::json!({}));
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
                                    name: tool_name.to_string(),
                                    success,
                                    error: error_msg,
                                    input: Some(args.clone()),
                                });
                            }
                            if !payload.get("success").and_then(|v| v.as_bool()).unwrap_or(false)
                            {
                                continue;
                            }
                            // 1a) 단일 render 도구 (옵션 E hybrid, 2026-05-14) — payload.blocks 그대로 push.
                            if tool_name == "render" {
                                if let Some(blocks) =
                                    payload.get("blocks").and_then(|v| v.as_array())
                                {
                                    for b in blocks {
                                        outcome.rendered_blocks.push(b.clone());
                                    }
                                    continue;
                                }
                            }
                            // 1b) 옛 render_* / render_iframe / component fallback (legacy 호환).
                            let html_content = payload
                                .get("htmlContent")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            let component = payload
                                .get("component")
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            if tool_name == "render_iframe" && html_content.is_some() {
                                let mut block = serde_json::json!({
                                    "type": "html",
                                    "htmlContent": html_content.unwrap(),
                                });
                                if let Some(h) =
                                    payload.get("htmlHeight").and_then(|v| v.as_str())
                                {
                                    block["htmlHeight"] = serde_json::Value::String(h.to_string());
                                }
                                outcome.rendered_blocks.push(block);
                            } else if let Some(comp) = component {
                                outcome.rendered_blocks.push(serde_json::json!({
                                    "type": "component",
                                    "name": comp,
                                    "props": payload.get("props").cloned().unwrap_or(serde_json::json!({})),
                                }));
                            } else if let Some(comp_name) = render_tool_map().get(tool_name) {
                                outcome.rendered_blocks.push(serde_json::json!({
                                    "type": "component",
                                    "name": *comp_name,
                                    "props": args.clone(),
                                }));
                            }
                            // 2) pending
                            let pending_flag = payload
                                .get("pending")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if pending_flag {
                                if let Some(pid) =
                                    payload.get("planId").and_then(|v| v.as_str())
                                {
                                    let summary = payload
                                        .get("summary")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(tool_name)
                                        .to_string();
                                    let mut action = serde_json::json!({
                                        "planId": pid,
                                        "name": tool_name,
                                        "summary": summary,
                                        "args": args.clone(),
                                    });
                                    if payload.get("status").and_then(|v| v.as_str())
                                        == Some("past-runat")
                                    {
                                        action["status"] =
                                            serde_json::Value::String("past-runat".to_string());
                                    }
                                    if let Some(ora) = payload
                                        .get("originalRunAt")
                                        .and_then(|v| v.as_str())
                                    {
                                        action["originalRunAt"] =
                                            serde_json::Value::String(ora.to_string());
                                    }
                                    outcome.pending_actions.push(action);
                                }
                            }
                            // 3) suggest / propose_plan → suggestions
                            if (tool_name == "suggest" || tool_name == "propose_plan")
                                && payload.get("suggestions").and_then(|v| v.as_array()).is_some()
                            {
                                for s in payload
                                    .get("suggestions")
                                    .unwrap()
                                    .as_array()
                                    .unwrap()
                                {
                                    outcome.suggestions.push(s.clone());
                                }
                            }
                        }
                        continue;
                    }
                    // item.error — 비치명적 도구 오류, thinking 으로 (현재 스킵)
                    if item_type == "error" {
                        continue;
                    }
                }
                _ => {}
            }
        }

        if errored {
            return Err(error_msg.unwrap_or_else(|| "Codex CLI 알 수 없는 에러".to_string()));
        }
        outcome.text = text_parts.join("");
        if !output.status.success() {
            return Err(format!(
                "Codex 비정상 종료 (exit {:?}): {}",
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
    /// turn.completed.usage — 비용 통계 토큰 표시용 (codex 는 구독이라 cost 0). input_tokens 는
    /// 캐시 포함 총 입력, cached_input_tokens 는 그 부분집합. 매 turn.completed 가 누적값이라 덮어씀.
    tokens_in: i64,
    tokens_out: i64,
    cached_tokens: i64,
    /// reasoning event 본문 + 도구 호출 마커 누적. 옛 Node 의 onChunk({type:'thinking', ...})
    /// 와 동등 — frontend ThinkingBlock bodyText 에 표시되어 사용자가 AI 의 추론·도구 호출
    /// 흐름을 본다. streaming chunk emit 은 아직 X (turn 종료 후 batch 표시).
    thinking_acc: String,
}

// codex 의 mcp_tool_call 은 item.completed 한 이벤트에 server/tool/arguments/result 모두 포함되어
// pending → completed 매칭 불필요. Claude/Gemini 와 다른 점.

#[async_trait::async_trait]
impl FormatHandler for CodexCliHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        _api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        let outcome = Self::run_cli(&config.endpoint, prompt, opts, false).await?;
        Ok(LlmTextResponse {
            text: outcome.text,
            model_id: config.id.clone(),
            cost_usd: Some(0.0), // 구독 모드
            tokens_in: Some(outcome.tokens_in),
            tokens_out: Some(outcome.tokens_out),
            cached_tokens: Some(outcome.cached_tokens),
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
                cached_tokens: r.cached_tokens,
                cli_session_id: None,
                response_id: None,
                ..Default::default()
            });
        }
        let outcome = Self::run_cli(&config.endpoint, prompt, opts, true).await?;
        Ok(LlmToolResponse {
            text: outcome.text,
            tool_calls: vec![], // Codex 자체 MCP loop 처리 — 외부 dispatch 없음
            model_id: config.id.clone(),
            cost_usd: Some(0.0),
            tokens_in: Some(outcome.tokens_in),
            tokens_out: Some(outcome.tokens_out),
            cached_tokens: Some(outcome.cached_tokens),
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
    fn map_thinking_known_levels() {
        assert_eq!(CodexCliHandler::map_thinking_to_codex(Some("low")), Some("low"));
        assert_eq!(
            CodexCliHandler::map_thinking_to_codex(Some("max")),
            Some("xhigh")
        );
        assert_eq!(
            CodexCliHandler::map_thinking_to_codex(Some("minimal")),
            Some("minimal")
        );
    }

    #[test]
    fn map_thinking_none_returns_none() {
        assert_eq!(CodexCliHandler::map_thinking_to_codex(Some("none")), None);
        assert_eq!(CodexCliHandler::map_thinking_to_codex(None), None);
    }

    #[test]
    fn build_prompt_with_history_prepends_block() {
        let history = vec![firebat_core::ports::ChatMessage {
            role: "user".to_string(),
            content: serde_json::Value::String("hi".to_string()),
            image: None,
            image_mime_type: None,
        }];
        let p = CodexCliHandler::build_prompt_with_history("now", &history);
        assert!(p.contains("[이전 대화]"));
        assert!(p.contains("사용자: hi"));
    }
}

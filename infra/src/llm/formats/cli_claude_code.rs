//! Claude Code CLI — `claude` 자식 프로세스 (옛 TS `cli-claude-code.ts` 1:1 port).
//!
//! 핵심 기능:
//! - cold spawn 매 turn (옛 daemon LRU 폐기, 2026-04-30 결정)
//! - `--resume <session_id>` (DB 영속 cli_session_id 활용 — 멀티턴 컨텍스트)
//! - `--mcp-config <file>` 로 Firebat MCP 서버 연결 (HTTP streamable 우선, stdio fallback)
//! - `--allowed-tools mcp__firebat__*` + `--disallowed-tools <Claude Code 내장 도구>` (MCP 만 허용)
//! - `--system-prompt <Firebat User AI 페르소나>` (Claude Code 기본 코딩 프롬프트 교체)
//! - `--effort <low|medium|high|xhigh|max>` (extended thinking — opts.thinking_level 매핑)
//! - stream-json output 파싱: assistant.text/thinking/tool_use, user.tool_result, result/error
//! - tool_use_id 매칭 → render_* / pending_actions / suggestions 추출
//! - 첫 turn session_id 캡처 → response.cli_session_id 로 반환 (AiManager 가 DB 영속화)
//! - 종료 후 `~/.claude/projects/*/tool-results/` 10분+ 캐시 청소 (디스크 누적 방지)
//! - 첨부 이미지: stream-json input 모드 (Claude Code 는 `--image` 플래그 없음, Read 도구도 차단되어 있어 stream-json 이 유일한 vision 경로)

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::llm::adapter::FormatHandler;
use crate::llm::formats::cli_image_helper::extract_image_base64;
use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmStreamEvent, LlmStreamSink, LlmTextResponse, LlmToolResponse,
    ToolDefinition, ToolResult,
};
use firebat_core::utils::render_map::render_tool_map;

pub struct ClaudeCodeCliHandler;

impl ClaudeCodeCliHandler {
    pub fn new() -> Self {
        Self
    }

    /// Firebat thinking level → Claude Code `--effort` 값.
    /// 옛 TS `mapThinkingToEffort` 1:1. minimal/none 미지원 (플래그 생략).
    fn map_thinking_to_effort(level: Option<&str>) -> Option<&'static str> {
        match level {
            Some("low") => Some("low"),
            Some("medium") => Some("medium"),
            Some("high") => Some("high"),
            Some("xhigh") => Some("xhigh"),
            Some("max") => Some("max"),
            _ => None, // none / minimal / unknown → 플래그 생략
        }
    }

    /// `mcp__firebat__render_stock_chart` → `render_stock_chart` (옛 TS `stripMcpPrefix` 1:1).
    fn strip_mcp_prefix(name: &str) -> &str {
        // Pattern: `mcp__<server>__<tool>` — 첫 두 `__` 사이 server 이름 무시.
        if let Some(stripped) = name.strip_prefix("mcp__") {
            if let Some(idx) = stripped.find("__") {
                return &stripped[(idx + 2)..];
            }
        }
        name
    }

    /// MCP config 파일 박기 — HTTP streamable 우선 (즉시 도구 사용), stdio fallback (옛 TS `ensureMcpConfigFile` 1:1).
    ///
    /// HTTP streamable: Firebat 메인 프로세스의 `/api/mcp-internal` 에 직접 연결.
    /// 매 spawn 마다 Firebat Core 를 서브프로세스로 재부팅 (~수초) 하지 않고 즉시 도구 사용 가능.
    fn ensure_mcp_config_file(
        internal_mcp_token: Option<&str>,
        base_url: Option<&str>,
    ) -> Option<PathBuf> {
        let dir = std::env::temp_dir();
        let _ = std::fs::create_dir_all(&dir);
        let config_path = dir.join("firebat-claude-mcp-config.json");

        let config = if let Some(token) = internal_mcp_token {
            // path 결정 — FIREBAT_MCP_PATH env override (새 Rust endpoint = `/mcp`, 옛 Next.js = `/api/mcp-internal`).
            let mcp_path = std::env::var("FIREBAT_MCP_PATH")
                .unwrap_or_else(|_| "/api/mcp-internal".to_string());
            let url = format!(
                "{}{}",
                base_url.unwrap_or("http://127.0.0.1:3000"),
                mcp_path
            );
            serde_json::json!({
                "mcpServers": {
                    "firebat": {
                        "type": "http",
                        "url": url,
                        "headers": { "Authorization": format!("Bearer {}", token) }
                    }
                }
            })
        } else {
            // stdio fallback — 토큰 미설정 시. 매번 Firebat Core 재부팅하므로 초기 호출 느림.
            let project_dir = std::env::current_dir().ok()?;
            let stdio_path = project_dir.join("mcp").join("stdio-user-ai.ts");
            serde_json::json!({
                "mcpServers": {
                    "firebat": {
                        "command": "npx",
                        "args": ["tsx", stdio_path.to_string_lossy().to_string()],
                        "cwd": project_dir.to_string_lossy().to_string()
                    }
                }
            })
        };

        let payload = serde_json::to_string_pretty(&config).ok()?;
        std::fs::write(&config_path, payload).ok()?;
        Some(config_path)
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

    /// `~/.claude/projects/*/tool-results/` 의 10분 이전 파일 청소 — 옛 TS `cleanupClaudeCacheFiles` 1:1.
    /// 디스크 누적 방지. 현재 실행 중 참조 방지를 위해 10분+ 만 제거.
    async fn cleanup_claude_cache_files() {
        let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            Some(h) => PathBuf::from(h),
            None => return,
        };
        let claude_projects_dir = home.join(".claude").join("projects");
        if !claude_projects_dir.exists() {
            return;
        }
        let ten_min_ago = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(600))
            .unwrap_or(std::time::UNIX_EPOCH);
        let entries = match std::fs::read_dir(&claude_projects_dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for proj in entries.flatten() {
            let tool_results_dir = proj.path().join("tool-results");
            if !tool_results_dir.exists() {
                continue;
            }
            let files = match std::fs::read_dir(&tool_results_dir) {
                Ok(f) => f,
                Err(_) => continue,
            };
            for f in files.flatten() {
                let fp = f.path();
                if let Ok(meta) = std::fs::metadata(&fp) {
                    if let Ok(mt) = meta.modified() {
                        if mt < ten_min_ago {
                            let _ = std::fs::remove_file(&fp);
                        }
                    }
                }
            }
        }
    }

    /// 도구 호출 인자 빌더 — opts + system prompt + history + MCP / resume / model / effort.
    fn build_args(
        prompt: &str,
        opts: &LlmCallOpts,
        has_image: bool,
        mcp_config_path: Option<&str>,
        with_tools: bool,
    ) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        // Claude Code 내장 도구 차단 — Firebat MCP 만 허용. 옛 TS 1:1.
        const ALLOWED_TOOLS: &str = "mcp__firebat__*";
        const DISALLOWED_TOOLS: &str = "Agent,Task,TaskOutput,TaskStop,ToolSearch,SlashCommand,Bash,BashOutput,KillBash,KillShell,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,TodoWrite,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,Monitor,PushNotification,RemoteTrigger,ScheduleWakeup,Skill,AskUserQuestion,CronCreate,CronDelete,CronList,ListMcpResources,ReadMcpResource";

        if has_image {
            // stream-json input 모드 — stdin 으로 user message 전달. -p (print) 는 query 인자 없이 사용.
            args.push("-p".to_string());
            args.push("--input-format".to_string());
            args.push("stream-json".to_string());
            args.push("--output-format".to_string());
            args.push("stream-json".to_string());
            args.push("--verbose".to_string());
        } else {
            args.push("--print".to_string());
            args.push(prompt.to_string());
            args.push("--output-format".to_string());
            args.push("stream-json".to_string());
            args.push("--verbose".to_string());
        }

        if with_tools {
            args.push("--allowed-tools".to_string());
            args.push(ALLOWED_TOOLS.to_string());
            args.push("--disallowed-tools".to_string());
            args.push(DISALLOWED_TOOLS.to_string());
            // 권한 모드 — non-interactive subprocess 환경. default 의 모든 도구 사용 전
            // 사용자 prompt → stream-json output 으로 prompt 미노출 → LLM 이 "권한 승인" 응답으로
            // 우회 시도 → sysmod 도구 호출 silent skip. Firebat 자체 approval gate (destructive
            // 도구 검증) 가 있어 CLI 권한 모드 우회 정공.
            // bypassPermissions 는 root/sudo 거부 → acceptEdits 사용 (file edit 자동 승인 +
            // mcp 도구 자동 호출 + Firebat approval gate 여전히 동작).
            args.push("--permission-mode".to_string());
            args.push("acceptEdits".to_string());
        }

        if let Some(sp) = opts.system_prompt.as_deref() {
            if !sp.is_empty() {
                args.push("--system-prompt".to_string());
                args.push(sp.to_string());
            }
        }
        if let Some(rid) = opts.cli_resume_session_id.as_deref() {
            if !rid.is_empty() {
                args.push("--resume".to_string());
                args.push(rid.to_string());
            }
        }
        if let Some(p) = mcp_config_path {
            args.push("--mcp-config".to_string());
            args.push(p.to_string());
        }
        if let Some(m) = opts.cli_model.as_deref() {
            if !m.is_empty() {
                args.push("--model".to_string());
                args.push(m.to_string());
            }
        }
        if let Some(effort) = Self::map_thinking_to_effort(opts.thinking_level.as_deref()) {
            args.push("--effort".to_string());
            args.push(effort.to_string());
        }
        args
    }

    /// stream-json line 파싱 + tool 결과 매칭 → 풍부 메타 누적.
    /// 옛 TS `processLine` + `runClaude` 1:1 port. emit 있으면 turn 중 thinking/tool step 실시간 흘림
    /// (stdout 줄 단위 streaming) — 옛 Node onChunk 콜백 동등. emit None 이면 누적만 (batch 동작).
    async fn run_cli(
        binary: &str,
        prompt: &str,
        opts: &LlmCallOpts,
        with_tools: bool,
        mcp_config_path: Option<&str>,
        emit: Option<&LlmStreamSink>,
    ) -> InfraResult<CliRunOutcome> {
        let image_data = extract_image_base64(opts.image.as_deref(), opts.image_mime_type.as_deref());
        let has_image = image_data.is_some();
        // resume 미사용 시 history 주입 (옛 TS 1:1)
        let final_prompt = if opts.cli_resume_session_id.is_some() {
            prompt.to_string()
        } else {
            Self::build_prompt_with_history(prompt, &opts.history)
        };
        let args = Self::build_args(&final_prompt, opts, has_image, mcp_config_path, with_tools);

        let mut cmd = Command::new(binary);
        cmd.args(&args);
        if has_image {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child: Child = cmd.spawn().map_err(|e| {
            format!(
                "Claude Code CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `claude auth login` 한 번 실행했는지 확인",
                binary, binary
            )
        })?;

        // stream-json input 모드 — stdin 에 user message JSON line 전송 후 close.
        if has_image {
            if let (Some((data, media_type)), Some(mut stdin)) = (image_data, child.stdin.take()) {
                let user_msg = serde_json::json!({
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": final_prompt},
                            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}
                        ]
                    }
                });
                let payload = serde_json::to_string(&user_msg).unwrap_or_default() + "\n";
                let _ = stdin.write_all(payload.as_bytes()).await;
                drop(stdin);
            }
        }

        // stdout 줄 단위 streaming — 옛 wait_with_output batch 대신. 각 stream-json 라인을 즉시 파싱·emit.
        let stdout_pipe = child
            .stdout
            .take()
            .ok_or_else(|| "Claude Code CLI stdout 파이프 없음".to_string())?;
        let stderr_pipe = child.stderr.take();
        // stderr 동시 드레인 — pipe 버퍼 막힘(deadlock) 방지.
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            if let Some(se) = stderr_pipe {
                let _ = BufReader::new(se).read_to_string(&mut buf).await;
            }
            buf
        });

        let mut outcome = CliRunOutcome::default();
        let mut current_text = String::new();
        let mut pending_tool_uses: HashMap<String, PendingToolUse> = HashMap::new();
        let mut errored = false;
        let mut error_msg: Option<String> = None;

        let mut reader = BufReader::new(stdout_pipe).lines();
        while let Some(line) = reader
            .next_line()
            .await
            .map_err(|e| format!("Claude Code CLI stdout 읽기 실패: {e}"))?
        {
            if line.trim().is_empty() {
                continue;
            }
            let ev: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // session_id 캡처 (init 또는 첫 응답)
            if outcome.session_id.is_none() {
                if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                    outcome.session_id = Some(sid.to_string());
                }
            }

            // 에러 이벤트
            let is_error = ev.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let subtype = ev.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
            if is_error || subtype == "error" {
                errored = true;
                let detail = ev
                    .get("result")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| ev.get("error").and_then(|v| v.as_str()).map(String::from))
                    .or_else(|| {
                        ev.get("message")
                            .and_then(|m| m.get("content"))
                            .map(|c| c.to_string())
                    })
                    .unwrap_or_else(|| ev.to_string().chars().take(300).collect());
                error_msg = Some(format!("Claude CLI: {}", detail));
                continue;
            }

            let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");

            // assistant: text / thinking / tool_use
            if ev_type == "assistant" {
                if let Some(content) = ev
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for c in content {
                        let c_type = c.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match c_type {
                            "text" => {
                                if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                    current_text.push_str(t);
                                }
                            }
                            "thinking" => {
                                // Extended thinking 본문 — outcome.thinking_acc 에 누적해 final response 의
                                // thinking_text 로 전달 (frontend ThinkingBlock bodyText). 옛 Node 의 onChunk
                                // ({type:'thinking', content}) 와 동등.
                                if let Some(t) = c.get("thinking").and_then(|v| v.as_str()) {
                                    if !t.is_empty() {
                                        if !outcome.thinking_acc.is_empty() {
                                            outcome.thinking_acc.push('\n');
                                        }
                                        outcome.thinking_acc.push_str(t);
                                        // 실시간 emit — frontend ThinkingBlock bodyText 누적.
                                        if let Some(tx) = emit {
                                            let _ = tx.try_send(LlmStreamEvent::Thinking(t.to_string()));
                                        }
                                    }
                                }
                            }
                            "tool_use" => {
                                let raw_name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                if raw_name.is_empty() {
                                    continue;
                                }
                                let bare = Self::strip_mcp_prefix(raw_name).to_string();
                                outcome.used_tools.push(bare.clone());
                                // 도구 호출 마커도 thinking 본문에 추가 — 사용자가 turn 중 어떤 도구가
                                // 호출됐는지 자연어로 본다. 옛 Node 의 onChunk({type:'thinking',
                                // content:'[도구 호출: name]'}) 와 동등.
                                if !outcome.thinking_acc.is_empty() {
                                    outcome.thinking_acc.push('\n');
                                }
                                outcome.thinking_acc.push_str(&format!("[도구 호출: {bare}]"));
                                // 실시간 emit — frontend "생각중 → 도구 진행" 표시 (ToolStep start).
                                if let Some(tx) = emit {
                                    let _ = tx.try_send(LlmStreamEvent::ToolStep {
                                        name: bare.clone(),
                                        status: "start".to_string(),
                                    });
                                }
                                let tool_use_id =
                                    c.get("id").and_then(|v| v.as_str()).map(String::from);
                                if let Some(id) = tool_use_id {
                                    pending_tool_uses.insert(
                                        id,
                                        PendingToolUse {
                                            name: bare,
                                            input: c.get("input").cloned().unwrap_or(serde_json::json!({})),
                                        },
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }

            // user: tool_result — render_* / pending / suggestions 추출
            if ev_type == "user" {
                if let Some(content) = ev
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for c in content {
                        if c.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                            continue;
                        }
                        let tool_use_id =
                            c.get("tool_use_id").and_then(|v| v.as_str()).map(String::from);
                        let pending = match tool_use_id.as_deref() {
                            Some(id) => pending_tool_uses.remove(id),
                            None => None,
                        };
                        let Some(pending) = pending else { continue };
                        // content: array[{type:'text', text: '<json>'}]
                        let text_payload = c
                            .get("content")
                            .and_then(|v| v.as_array())
                            .and_then(|arr| arr.first())
                            .and_then(|first| first.get("text").and_then(|t| t.as_str()))
                            .map(String::from)
                            .or_else(|| c.get("content").and_then(|v| v.as_str()).map(String::from));
                        let Some(text_payload) = text_payload else { continue };
                        let payload: serde_json::Value =
                            match serde_json::from_str(&text_payload) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                        // 도구 결과 요약 — 성공/실패 모두 Frontend 에러 뱃지 UI 채널로 push.
                        // 옛 TS 의 에러 뱃지 표시 메커니즘 1:1.
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
                                input: Some(pending.input.clone()),
                            });
                            // 실시간 emit — 도구 완료/에러 (ToolStep done|error).
                            if let Some(tx) = emit {
                                let _ = tx.try_send(LlmStreamEvent::ToolStep {
                                    name: pending.name.clone(),
                                    status: if success { "done".to_string() } else { "error".to_string() },
                                });
                            }
                        }
                        if !payload.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
                            continue;
                        }
                        // 1a) 단일 render 도구 (옵션 E hybrid, 2026-05-14) — payload.blocks 그대로 push.
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
                        let component =
                            payload.get("component").and_then(|v| v.as_str()).map(String::from);
                        if pending.name == "render_iframe" && html_content.is_some() {
                            let html = html_content.unwrap();
                            let mut block = serde_json::json!({
                                "type": "html",
                                "htmlContent": html,
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
                                "props": payload.get("props").cloned().unwrap_or(serde_json::json!({}))
                            }));
                        } else if let Some(comp_name) = render_tool_map().get(pending.name.as_str()) {
                            outcome.rendered_blocks.push(serde_json::json!({
                                "type": "component",
                                "name": *comp_name,
                                "props": pending.input.clone()
                            }));
                        }
                        // 2) 승인 대기 도구 → pendingActions
                        let pending_flag =
                            payload.get("pending").and_then(|v| v.as_bool()).unwrap_or(false);
                        let plan_id =
                            payload.get("planId").and_then(|v| v.as_str()).map(String::from);
                        if pending_flag {
                            if let Some(pid) = plan_id {
                                let summary = payload
                                    .get("summary")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&pending.name)
                                    .to_string();
                                let mut action = serde_json::json!({
                                    "planId": pid,
                                    "name": pending.name.clone(),
                                    "summary": summary,
                                    "args": pending.input.clone(),
                                });
                                if payload.get("status").and_then(|v| v.as_str()) == Some("past-runat") {
                                    action["status"] = serde_json::Value::String("past-runat".to_string());
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
                        if (pending.name == "suggest" || pending.name == "propose_plan")
                            && payload.get("suggestions").and_then(|v| v.as_array()).is_some()
                        {
                            for s in payload.get("suggestions").unwrap().as_array().unwrap() {
                                outcome.suggestions.push(s.clone());
                            }
                        }
                    }
                }
            }

            // result — 실행 종료, 최종 text 결정
            if ev_type == "result" {
                let result_is_err =
                    ev.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                if result_is_err {
                    errored = true;
                    let r = ev
                        .get("result")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .unwrap_or_else(|| "실행 오류".to_string());
                    error_msg = Some(r);
                } else {
                    // result.result field 가 Claude Code stream-json 의 final answer.
                    // 옛 node 버전에서 이 필드를 사용해 답변 길이 회복.
                    // 이 필드가 없는 경우 (옛 동작) = current_text 를 폴백으로 사용.
                    let result_text = ev
                        .get("result")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .filter(|s| !s.is_empty());
                    outcome.text = result_text
                        .unwrap_or_else(|| std::mem::take(&mut current_text));
                }
                let cost_usd = ev
                    .get("total_cost_usd")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                outcome.cost_usd = cost_usd;
            }
        }

        // stdout 스트림 종료 → 프로세스 wait + stderr 수거 + 캐시 청소.
        let status = child
            .wait()
            .await
            .map_err(|e| format!("Claude Code CLI wait 실패: {e}"))?;
        let stderr_buf = stderr_task.await.unwrap_or_default();
        Self::cleanup_claude_cache_files().await;

        if errored {
            return Err(error_msg.unwrap_or_else(|| "Claude Code CLI 알 수 없는 에러".to_string()));
        }
        // result 이벤트 없이 종료 → current_text 가 최종
        if outcome.text.is_empty() && !current_text.is_empty() {
            outcome.text = current_text;
        }
        // exit code 비정상
        if !status.success() {
            return Err(format!(
                "Claude Code 비정상 종료 (exit {:?}): {}",
                status.code(),
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
    cost_usd: f64,
    /// Extended thinking 본문 + 도구 호출 마커 누적. 옛 Node 의 onChunk({type:'thinking', ...})
    /// 와 동등 — frontend ThinkingBlock bodyText 에 표시되어 사용자가 AI 의 추론·도구 호출
    /// 흐름을 본다. 옛 Rust 는 None 반환이라 표시 0 이었음 (사용자 보고 2026-05-24).
    /// streaming chunk emit 은 아직 X (batch 결과 시점 채워서 turn 종료 후 표시).
    thinking_acc: String,
}

struct PendingToolUse {
    name: String,
    input: serde_json::Value,
}

#[async_trait::async_trait]
impl FormatHandler for ClaudeCodeCliHandler {
    async fn ask_text(
        &self,
        config: &LlmModelConfig,
        _api_key: Option<&str>,
        prompt: &str,
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmTextResponse> {
        // 단순 텍스트 — MCP / 도구 미설정. system_prompt 만 활용.
        let outcome = Self::run_cli(&config.endpoint, prompt, opts, false, None, None).await?;
        Ok(LlmTextResponse {
            text: outcome.text,
            model_id: config.id.clone(),
            cost_usd: Some(outcome.cost_usd),
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
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        // 비스트리밍 = 스트리밍 변형에 emit None 위임 (단일 구현).
        self.ask_with_tools_streaming(config, api_key, prompt, tools, prior_results, opts, None)
            .await
    }

    async fn ask_with_tools_streaming(
        &self,
        config: &LlmModelConfig,
        api_key: Option<&str>,
        prompt: &str,
        tools: &[ToolDefinition],
        _prior_results: &[ToolResult],
        opts: &LlmCallOpts,
        emit: Option<LlmStreamSink>,
    ) -> InfraResult<LlmToolResponse> {
        // 도구 0건 (단순 텍스트) — ask_text 위임. 단 hosted MCP / CLI 자체 loop 모델
        // (features.mcp_connector=true) 은 빈 tools 여도 MCP config + 권한 모드가 필요하므로
        // ask_text 위임 금지 (ai.rs 가 hosted MCP 모델은 effective_tools 빈 배열로 호출).
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
        // MCP config — opts.mcp_token 우선, 없으면 stdio fallback.
        let mcp_config_path = Self::ensure_mcp_config_file(
            opts.mcp_token.as_deref(),
            opts.mcp_base_url.as_deref(),
        );
        let mcp_path_str = mcp_config_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let streamed = emit.is_some();
        let outcome = Self::run_cli(
            &config.endpoint,
            prompt,
            opts,
            true,
            mcp_path_str.as_deref(),
            emit.as_ref(),
        )
        .await?;
        Ok(LlmToolResponse {
            text: outcome.text,
            tool_calls: vec![], // CLI 가 자체 MCP loop 처리 — 외부 dispatch 없음
            model_id: config.id.clone(),
            cost_usd: Some(outcome.cost_usd),
            tokens_in: None,
            tokens_out: None,
            cli_session_id: outcome.session_id.clone(),
            response_id: outcome.session_id, // CLI 는 session_id 를 response_id 자리에도 노출
            internally_used_tools: outcome.used_tools,
            rendered_blocks: outcome.rendered_blocks,
            pending_actions: outcome.pending_actions,
            suggestions: outcome.suggestions,
            raw_model_parts: None,
            tool_results: outcome.tool_results,
            // 스트리밍 시 thinking_acc 는 turn 중 이미 emit 됨 → AiManager post-emit 중복 방지 위해 None.
            thinking_text: if streamed || outcome.thinking_acc.is_empty() {
                None
            } else {
                Some(outcome.thinking_acc)
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_mcp_prefix_basic() {
        assert_eq!(
            ClaudeCodeCliHandler::strip_mcp_prefix("mcp__firebat__render_chart"),
            "render_chart"
        );
        assert_eq!(
            ClaudeCodeCliHandler::strip_mcp_prefix("mcp__gmail__send_email"),
            "send_email"
        );
    }

    #[test]
    fn strip_mcp_prefix_passthrough() {
        assert_eq!(
            ClaudeCodeCliHandler::strip_mcp_prefix("render_chart"),
            "render_chart"
        );
        assert_eq!(ClaudeCodeCliHandler::strip_mcp_prefix(""), "");
    }

    #[test]
    fn map_thinking_to_effort_known_levels() {
        assert_eq!(
            ClaudeCodeCliHandler::map_thinking_to_effort(Some("low")),
            Some("low")
        );
        assert_eq!(
            ClaudeCodeCliHandler::map_thinking_to_effort(Some("max")),
            Some("max")
        );
    }

    #[test]
    fn map_thinking_to_effort_unsupported_returns_none() {
        assert_eq!(ClaudeCodeCliHandler::map_thinking_to_effort(Some("none")), None);
        assert_eq!(
            ClaudeCodeCliHandler::map_thinking_to_effort(Some("minimal")),
            None
        );
        assert_eq!(ClaudeCodeCliHandler::map_thinking_to_effort(None), None);
    }

    #[test]
    fn build_prompt_with_history_empty_returns_prompt() {
        let p = ClaudeCodeCliHandler::build_prompt_with_history("hi", &[]);
        assert_eq!(p, "hi");
    }

    #[test]
    fn build_prompt_with_history_appends_recent() {
        let history = vec![
            firebat_core::ports::ChatMessage {
                role: "user".to_string(),
                content: serde_json::Value::String("first".to_string()),
                image: None,
                image_mime_type: None,
            },
            firebat_core::ports::ChatMessage {
                role: "assistant".to_string(),
                content: serde_json::Value::String("answer".to_string()),
                image: None,
                image_mime_type: None,
            },
        ];
        let p = ClaudeCodeCliHandler::build_prompt_with_history("now", &history);
        assert!(p.contains("[이전 대화]"));
        assert!(p.contains("사용자: first"));
        assert!(p.contains("AI: answer"));
        assert!(p.contains("[현재 요청]\nnow"));
    }

    #[test]
    fn build_prompt_with_history_truncates_to_10() {
        let mut history = Vec::new();
        for i in 0..15 {
            history.push(firebat_core::ports::ChatMessage {
                role: "user".to_string(),
                content: serde_json::Value::String(format!("msg {}", i)),
                image: None,
                image_mime_type: None,
            });
        }
        let p = ClaudeCodeCliHandler::build_prompt_with_history("now", &history);
        // 처음 5개는 truncate, 마지막 10개만 포함
        assert!(!p.contains("msg 0"));
        assert!(!p.contains("msg 4"));
        assert!(p.contains("msg 5"));
        assert!(p.contains("msg 14"));
    }
}

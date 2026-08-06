//! Codex CLI — `codex exec` 자식 프로세스 (옛 TS `cli-codex.ts` 1:1 port).
//!
//! 핵심 기능:
//! - `codex exec <prompt>` non-interactive
//! - CLI 인자 최소화: `--json --skip-git-repo-check` 만 — sandbox/approval/model/effort 는 전부
//!   config.toml(`sandbox_mode`/`approval_policy`/`model`/`model_reasoning_effort`, 매 턴 재생성).
//!   신버전 codex 가 `exec` 에서 `--ask-for-approval`, `exec resume` 에서 `--sandbox` 를 제거해
//!   (clap exit 2, 2026-07-15 실측) 플래그는 서브커맨드별 지뢰 → config 단일 소스.
//! - `--image <path>` (첨부 이미지)
//! - `--model <id>`
//! - `-c model_reasoning_effort="<level>"` (thinking)
//! - `exec resume <session_id> <prompt>` (멀티턴 resume)
//! - `CODEX_HOME` env + `config.toml` (`[mcp_servers.firebat] url + bearer_token_env_var`)
//! - `FIREBAT_MCP_TOKEN` env (config.toml `bearer_token_env_var` 와 짝)
//! - 기존 `~/.codex/auth.json` 복사 (구독 OAuth 세션 유지)
//! - stream-json output: `thread.started` / `turn.failed` / `item.completed (agent_message / mcp_tool_call)`
//! - `mcp_tool_call` 결과 → render_* / pending / suggestions 추출

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::SystemTime;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

/// 홈 디렉토리 해석 — env(HOME/USERPROFILE) 우선 + unix getpwuid 폴백(`std::env::home_dir`).
/// systemd 루트 서비스는 `User=` 미지정 시 HOME env 가 없어서 env 만 보면 `~/.codex` 복사가
/// 조용히 스킵되어 codex 가 무인증으로 나가 401 Missing bearer 가 나던 버그(2026-07-15 실측).
#[allow(deprecated)]
pub(crate) fn resolve_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
}

/// `~/.codex/auth.json` → 우리 CODEX_HOME 복사 (구독 OAuth 세션 계승).
///
/// **재로그인 전파**: 원본이 사본보다 새로우면 덮어씀. 옛 "없을 때만 복사"는 사용자가 재로그인해도
/// (새 로그인 = 옛 세션 무효화) 죽은 토큰 사본이 남아 401 Missing bearer 가 나던 버그(2026-07-15
/// 실측). 사본이 더 새로우면(codex 자체 토큰 갱신 회전) 그대로 유지.
///
/// LLM 경로·이미지 경로가 각자 CODEX_HOME 을 두므로 공용.
pub(crate) fn copy_auth_json(codex_home: &Path) {
    let Some(home) = resolve_home_dir() else {
        return;
    };
    let real_auth = home.join(".codex").join("auth.json");
    if !real_auth.exists() {
        return;
    }
    let tmp_auth = codex_home.join("auth.json");
    let real_newer = match (
        std::fs::metadata(&real_auth).and_then(|m| m.modified()),
        std::fs::metadata(&tmp_auth).and_then(|m| m.modified()),
    ) {
        (Ok(r), Ok(t)) => r > t,
        // 사본 없음 / mtime 판독 불가 = 복사
        _ => true,
    };
    if real_newer {
        let _ = std::fs::copy(&real_auth, &tmp_auth);
    }
}

/// The other half of the auth story, run AFTER each codex child exits: if this home's copy
/// rotated during the run (codex refreshed and rewrote it), push it back to the real
/// `~/.codex/auth.json`. ChatGPT refresh tokens are single-use — two homes rotating
/// independent copies burn each other's lineage. Measured 2026-08-06: the image home died
/// with "refresh token was already used", every image call sat on a silent 401 until the
/// 420s timeout, and mtime comparison alone could never see it (a newer file can hold an
/// already-spent token). With the write-back, the real file is the hub every home converges
/// through.
pub(crate) fn sync_auth_back(codex_home: &Path) {
    let Some(home) = resolve_home_dir() else {
        return;
    };
    let real_auth = home.join(".codex").join("auth.json");
    let tmp_auth = codex_home.join("auth.json");
    let copy_newer = match (
        std::fs::metadata(&real_auth).and_then(|m| m.modified()),
        std::fs::metadata(&tmp_auth).and_then(|m| m.modified()),
    ) {
        (Ok(r), Ok(t)) => t > r,
        // 실물이 없고 사본만 있으면 사본이 곧 진실.
        (Err(_), Ok(_)) => true,
        _ => false,
    };
    if copy_newer {
        if let Some(parent) = real_auth.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::copy(&tmp_auth, &real_auth);
    }
}

/// codex 이미지 확장자 allowlist — 수확 대상 판별.
const CODEX_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];

/// codex 내장 `image_gen` 도구 산출물 수확 — `since` 이후 생성된 파일만, mtime 오름차순.
///
/// **왜 파일시스템인가**: 내장 도구는 stdout 이벤트에 이미지 바이트를 싣지 않고
/// `$CODEX_HOME/generated_images/<session-id>/call_*.png` 로 저장한다. codex 내장 imagegen 스킬이
/// 문서화한 계약("Codex saves generated images under `$CODEX_HOME/*`" / "move or copy the selected
/// output from `$CODEX_HOME/generated_images/...`")이고 서버 실측으로 확인됨(2026-07-27). 옛 구현이
/// stdout 에서 base64·path 를 찾던 3패턴은 실제로 한 번도 매칭될 수 없어 타임아웃까지 대기했다.
///
/// 원래 이 이동은 codex 가 자기 쉘로 하지만 우리 config 는 `shell_tool = false` + read-only
/// sandbox 라 codex 쪽 배달 경로가 없다 → 호스트가 거둔다.
///
/// `since` 워터마크로 이전 실행 잔여물 재수확을 차단한다.
pub(crate) fn harvest_generated_images(codex_home: &Path, since: SystemTime) -> Vec<PathBuf> {
    let root = codex_home.join("generated_images");
    let mut found: Vec<(SystemTime, PathBuf)> = Vec::new();
    // 세션 하위 디렉토리 1단 + 루트 직속 둘 다 — 저장 레이아웃 변화에 견디게.
    collect_new_images(&root, since, &mut found);
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                collect_new_images(&entry.path(), since, &mut found);
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// 그 이미지를 만든 **실제 프롬프트** — codex 가 자기 내장 도구에 넘긴 원문.
///
/// 왜 가능한가: 산출 파일명이 `call_<call_id>.png` 이고, 세션 rollout 의 그 호출 레코드에
/// 같은 `call_id` 와 `arguments.prompt` 가 함께 있다. 파일명 stem == call_id 라 추측 없는 정확
/// 조인이다. 경로만으로 세션·홈을 역산한다: `<home>/generated_images/<session>/call_x.png`.
///
/// 없으면 None — 갤러리는 호출자가 주는 폴백(사용자 요청문)을 쓴다. 사용자 요청문은 "가을 제주
/// 여행 사진" 한 줄인데 모델이 실제로 넘긴 건 장면·조명·구도까지 적힌 문단이라, 갤러리 검색·
/// 재생성에서 값이 다르다(사용자 지적 2026-07-28).
pub(crate) fn extract_image_prompt(image_path: &Path) -> Option<String> {
    let call_id = image_path.file_stem()?.to_str()?;
    let session_dir = image_path.parent()?;
    let session_id = session_dir.file_name()?.to_str()?;
    let home = session_dir.parent()?.parent()?; // generated_images/ → <home>
    let rollout = find_rollout(&home.join("sessions"), session_id)?;
    let file = std::fs::File::open(rollout).ok()?;
    use std::io::BufRead;
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains(call_id) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let p = v.get("payload").unwrap_or(&v);
        if p.get("call_id").and_then(|c| c.as_str()) != Some(call_id) {
            continue;
        }
        // arguments 는 JSON 문자열(function_call) 또는 객체 — 둘 다 수용.
        let args = p.get("arguments").or_else(|| p.get("input"))?;
        let parsed: serde_json::Value = match args.as_str() {
            Some(s) => serde_json::from_str(s).ok()?,
            None => args.clone(),
        };
        let prompt = parsed.get("prompt")?.as_str()?.trim();
        if !prompt.is_empty() {
            return Some(prompt.to_string());
        }
    }
    None
}

/// `sessions/YYYY/MM/DD/rollout-*-<session_id>.jsonl` 탐색 — 날짜 경로를 모르므로 3단 순회.
fn find_rollout(sessions_root: &Path, session_id: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, session_id: &str, depth: u8) -> Option<PathBuf> {
        let entries = std::fs::read_dir(dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth == 0 {
                    continue;
                }
                if let Some(found) = walk(&p, session_id, depth - 1) {
                    return Some(found);
                }
            } else if p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains(session_id) && n.ends_with(".jsonl"))
                .unwrap_or(false)
            {
                return Some(p);
            }
        }
        None
    }
    walk(sessions_root, session_id, 3)
}

fn collect_new_images(dir: &Path, since: SystemTime, out: &mut Vec<(SystemTime, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| CODEX_IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if modified > since {
            out.push((modified, path));
        }
    }
}

use crate::llm::adapter::FormatHandler;
use crate::llm::formats::cli_image_helper::{cleanup_temp_file, write_image_temp_file};
use firebat_core::llm::config::LlmModelConfig;
use firebat_core::ports::{
    InfraResult, LlmCallOpts, LlmStreamEvent, LlmStreamSink, LlmTextResponse, LlmToolResponse,
    ToolDefinition, ToolResult,
};
use firebat_core::utils::render_map::render_tool_map;

pub struct CodexCliHandler;

/// CODEX_HOME base directory — **on disk, not in `/tmp`**.
///
/// `/tmp` on the production box is tmpfs: the rollout logs were consuming 179 MB of a 1 GB server's
/// RAM, and every restart wiped them (2026-07-29 실측). Those rollouts are the only record of what a
/// CLI model actually reasoned about — reading them is a standing practice, so they must survive a
/// reboot and must not compete with the server for memory. Falls back to the temp dir only when the
/// workspace is unavailable, so a dev box without the env var still works.
pub fn codex_home_base() -> PathBuf {
    match std::env::var("FIREBAT_WORKSPACE_ROOT") {
        Ok(root) if !root.trim().is_empty() => PathBuf::from(root).join("data").join("codex"),
        _ => std::env::current_dir()
            .map(|d| d.join("data").join("codex"))
            .unwrap_or_else(|_| std::env::temp_dir()),
    }
}

/// Drop rollout/session files older than `days` so the reasoning archive does not grow without
/// bound. Best-effort: a failure here must never affect a turn.
fn prune_codex_sessions(codex_home: &std::path::Path, days: u64) {
    let cutoff = std::time::SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(days * 86_400));
    let Some(cutoff) = cutoff else { return };
    fn walk(dir: &std::path::Path, cutoff: std::time::SystemTime) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                walk(&path, cutoff);
                let _ = std::fs::remove_dir(&path); // only succeeds when empty
            } else if e
                .metadata()
                .and_then(|m| m.modified())
                .map(|m| m < cutoff)
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    walk(&codex_home.join("sessions"), cutoff);
}

impl CodexCliHandler {
    pub fn new() -> Self {
        Self
    }

    /// Firebat thinking level → Codex `model_reasoning_effort` 값.
    ///
    /// **레벨 지원 여부는 여기서 판단하지 않는다** — models.json `thinking.levels` 선언이 단일
    /// 진실이고 선택 UI 도 그 선언만 보여준다. 옛 TS 시절엔 레벨 목록이 전 모델 공통이라 핸들러가
    /// `max → xhigh` 로 깎아야 했지만(그때는 max 를 가진 GPT 가 없었다), 모델별 선언으로 바뀐
    /// 지금 그 강등표는 새 모델이 나오는 순간 조용히 거짓이 된다 — 실제로 GPT-5.6 이 max 를
    /// 지원하는데도 UI 는 Max, 실제 전송은 xhigh 였다(2026-07-27). 선언을 그대로 통과시킨다.
    fn map_thinking_to_codex(level: Option<&str>) -> Option<&'static str> {
        match level {
            Some("none") | None => None,
            Some("minimal") => Some("minimal"),
            Some("low") => Some("low"),
            Some("medium") => Some("medium"),
            Some("high") => Some("high"),
            Some("xhigh") => Some("xhigh"),
            Some("max") => Some("max"),
            Some(_) => None,
        }
    }

    /// CODEX_HOME 디렉토리 생성 + config.toml + auth.json 복사.
    /// 옛 TS `ensureCodexHome` 1:1. HTTP MCP (`experimental_use_rmcp_client = true`) + `bearer_token_env_var`.
    /// sandbox·model·effort 도 config.toml 로 기입 — `exec resume` 이 해당 플래그들을 안 받아
    /// (clap exit 2) CLI 인자 대신 config 가 단일 소스(매 턴 재생성이라 옵션 변경도 반영됨).
    fn ensure_codex_home(
        internal_mcp_token: Option<&str>,
        base_url: Option<&str>,
        cli_model: Option<&str>,
        effort: Option<&str>,
    ) -> Option<PathBuf> {
        let codex_home = codex_home_base().join("chat");
        std::fs::create_dir_all(&codex_home).ok()?;
        // 14일 보존 — 추론 판독은 보통 며칠 안이고, 그보다 오래된 건 용량만 먹는다.
        prune_codex_sessions(&codex_home, 14);

        // 기존 ~/.codex/auth.json 복사 (로그인 세션 유지) — 이미지 경로와 공용 헬퍼.
        copy_auth_json(&codex_home);

        let mut toml = String::new();
        // 승인 정책 — 옛 `--ask-for-approval never` CLI 플래그의 config 등가(전 버전 유효 키).
        // TOML 최상위 키라 첫 [table] 헤더보다 앞에 와야 함.
        toml.push_str("approval_policy = \"never\"\n");
        // sandbox 도 config 로 — `exec resume` 이 `--sandbox` 플래그를 안 받음(2026-07-15 실측).
        toml.push_str("sandbox_mode = \"read-only\"\n");
        // codex 자체 웹서치 제거 — 외부 검색은 Firebat 도구(naver-search 등)로만.
        // Claude CLI 의 --allowed-tools "mcp__firebat__*"(내장 도구 전면 차단)와 동등한 자세.
        toml.push_str("web_search = \"disabled\"\n");
        // reasoning 요약 노출 — 미설정 시 summary 가 빈 배열(encrypted 만)이라 생각중 본문이
        // 비어 있던 것(2026-07-15 실측). 요약을 받아 ThinkingBlock 에 표시.
        toml.push_str("model_reasoning_summary = \"auto\"\n");
        if let Some(m) = cli_model.filter(|m| !m.is_empty()) {
            toml.push_str(&format!("model = \"{}\"\n", m));
        }
        if let Some(eff) = effort {
            toml.push_str(&format!("model_reasoning_effort = \"{}\"\n", eff));
        }
        toml.push('\n');
        if let Some(_token) = internal_mcp_token {
            let mcp_path = std::env::var("FIREBAT_MCP_PATH")
                .unwrap_or_else(|_| "/api/mcp-internal".to_string());
            let url = format!(
                "{}{}",
                base_url.unwrap_or("http://127.0.0.1:3000"),
                mcp_path
            );
            // shell_tool = false — 내장 쉘 차단(Claude allowlist 동등). sandbox read-only 는 쓰기·
            // 네트워크만 막고 읽기는 허용이라, 내장 쉘이 살아 있으면 vault.db 등 시크릿 read 유출 +
            // 서버 탐색 쿼터 낭비(2026-06-19 Claude 사고 클래스) 벡터가 남는다. MCP 도구는 별도
            // 서브시스템이라 영향 0(공식 config 레퍼런스 확인).
            toml.push_str("[features]\nexperimental_use_rmcp_client = true\nshell_tool = false\n\n");
            toml.push_str("[mcp_servers.firebat]\n");
            toml.push_str(&format!("url = \"{}\"\n", url));
            toml.push_str("bearer_token_env_var = \"FIREBAT_MCP_TOKEN\"\n");
            // 신버전 codex(0.144 실측)는 MCP 도구 호출을 승인 대상으로 분류 — 비대화형(exec)은
            // 승인을 물을 수 없어 전부 자동 취소("user cancelled MCP tool call") → 서버별 자동
            // 승인. 파괴 작업 승인은 Firebat 자체 승인카드 계층이 게이트하므로 여기선 정당.
            toml.push_str("default_tools_approval_mode = \"approve\"\n");
        } else {
            // stdio fallback — Firebat Core 매번 재부팅. 토큰 미설정 시.
            let project_dir = std::env::current_dir().ok()?;
            let stdio_path = project_dir.join("mcp").join("stdio-user-ai.ts");
            let stdio_str = stdio_path.to_string_lossy().replace('\\', "\\\\");
            let cwd_str = project_dir.to_string_lossy().replace('\\', "\\\\");
            toml.push_str("[features]\nshell_tool = false\n\n");
            toml.push_str("[mcp_servers.firebat]\n");
            toml.push_str("command = \"npx\"\n");
            toml.push_str(&format!("args = [\"tsx\", \"{}\"]\n", stdio_str));
            toml.push_str(&format!("cwd = \"{}\"\n", cwd_str));
            toml.push_str("default_tools_approval_mode = \"approve\"\n");
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
    ///
    /// `options_in_config = true`(with_tools = 우리 CODEX_HOME 사용) 면 sandbox·model·effort 를
    /// **config.toml 로 이전**하고 CLI 인자는 `--json --skip-git-repo-check` 만 남긴다 —
    /// `codex exec resume` 서브커맨드가 `--sandbox`(및 잠재적으로 --model/-c)를 안 받아
    /// clap exit 2 가 나던 것(2026-07-15 실측). exec/resume 공통 최소 인자 = 서브커맨드 차이 원천 회피.
    /// tool-less(기본 ~/.codex 사용, resume 없음) 는 기존 플래그 유지.
    fn build_args(
        prompt: &str,
        opts: &LlmCallOpts,
        tmp_image_path: Option<&str>,
        options_in_config: bool,
    ) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        // `--ask-for-approval never` 는 신버전 codex exec 에서 플래그 자체가 제거되어(unknown
        // argument = exit 2, 2026-07-15 실측) config.toml `approval_policy = "never"` 로 이전.
        let base_flags = ["--json", "--skip-git-repo-check"];

        // resume 시 서브커맨드: `codex exec resume <session_id> <prompt>` — with_tools 전용
        // (options_in_config=true 라 sandbox/model/effort 는 config.toml 이 담당).
        if let Some(rid) = opts.cli_resume_session_id.as_deref() {
            if !rid.is_empty() {
                args.push("exec".to_string());
                args.push("resume".to_string());
                args.push(rid.to_string());
                args.push(prompt.to_string());
                for f in base_flags {
                    args.push(f.to_string());
                }
                if let Some(p) = tmp_image_path {
                    args.push("--image".to_string());
                    args.push(p.to_string());
                }
                return args;
            }
        }
        // 일반: `codex exec <prompt>`
        args.push("exec".to_string());
        args.push(prompt.to_string());
        for f in base_flags {
            args.push(f.to_string());
        }
        if let Some(p) = tmp_image_path {
            args.push("--image".to_string());
            args.push(p.to_string());
        }
        if !options_in_config {
            // tool-less = 기본 ~/.codex 이므로 sandbox·model·effort 를 플래그로 (fresh exec 은 전부 수용).
            args.push("--sandbox".to_string());
            args.push("read-only".to_string());
            if let Some(m) = opts.cli_model.as_deref() {
                if !m.is_empty() {
                    args.push("--model".to_string());
                    args.push(m.to_string());
                }
            }
            if let Some(eff) = Self::map_thinking_to_codex(opts.thinking_level.as_deref()) {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{}\"", eff));
            }
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
        emit: Option<&LlmStreamSink>,
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

        let args = Self::build_args(&prompt_with_system, opts, tmp_image_path, with_tools);

        // CODEX_HOME 설정 (도구 호출 모드만) — sandbox/model/effort 는 config.toml 이 담당
        // (build_args 의 options_in_config=with_tools 와 짝).
        let codex_home = if with_tools {
            Self::ensure_codex_home(
                opts.mcp_token.as_deref(),
                opts.mcp_base_url.as_deref(),
                opts.cli_model.as_deref(),
                Self::map_thinking_to_codex(opts.thinking_level.as_deref()),
            )
        } else {
            None
        };

        // 내장 이미지 도구 산출물 수확 워터마크 — spawn 직전에 찍어 이전 턴 잔여물을 배제.
        let harvest_since = SystemTime::now();

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

        let mut child = cmd.spawn().map_err(|e| {
            cleanup_temp_file(tmp_image_path);
            format!(
                "Codex CLI spawn 실패 ({}): {e} — `{}` binary PATH 확인 / `codex login` 한 번 실행했는지 확인",
                binary, binary
            )
        })?;

        // stdout 줄 단위 스트리밍 — 옛 wait_with_output batch 는 턴이 끝나야 전부 파싱돼
        // "생각중" 본문·도구 스텝이 라이브로 전혀 안 보였다(2026-07-15 사용자 보고). claude 미러:
        // stderr 동시 드레인(파이프 버퍼 deadlock 방지) + idle timeout(hang/orphan 방지).
        let stdout_pipe = child.stdout.take().ok_or_else(|| {
            cleanup_temp_file(tmp_image_path);
            "Codex CLI stdout 파이프 없음".to_string()
        })?;
        let stderr_pipe = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            if let Some(se) = stderr_pipe {
                let _ = BufReader::new(se).read_to_string(&mut buf).await;
            }
            buf
        });

        let mut outcome = CliRunOutcome::default();
        let mut text_parts: Vec<String> = Vec::new();
        let mut errored = false;
        let mut error_msg: Option<String> = None;
        // CLI 네이티브 계획 도구(update_plan → todo_list 아이템)는 turn 당 한 번만 "계획 정리" 표시로 통합.
        let mut plan_noted = false;

        // stdout 무응답 감지 — 장고 추론도 reasoning/tool 이벤트가 주기적으로 흐르므로 10분 무응답 =
        // hang 으로 간주 kill(orphan→OOM 방지). kill_on_drop(future drop 케이스)과 보완.
        const CODEX_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
        let mut reader = BufReader::new(stdout_pipe).lines();
        loop {
            let line = match tokio::time::timeout(CODEX_IDLE_TIMEOUT, reader.next_line()).await {
                Ok(read_result) => match read_result {
                    Ok(Some(line)) => line,
                    Ok(None) => break, // EOF — codex 종료
                    Err(e) => {
                        errored = true;
                        error_msg = Some(firebat_core::i18n::t(
                            "core.error.llm.cli_failed",
                            None,
                            &[("name", "Codex"), ("stage", "stdout"), ("detail", &e.to_string())],
                        ));
                        break;
                    }
                },
                Err(_elapsed) => {
                    let _ = child.start_kill();
                    errored = true;
                    error_msg = Some(format!(
                        "Codex CLI idle timeout — stdout {}초 무응답으로 종료(hang/orphan 방지)",
                        CODEX_IDLE_TIMEOUT.as_secs()
                    ));
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            let ev: serde_json::Value = match serde_json::from_str(&line) {
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
                    // agent_message (completed 만) — 신버전 codex 는 `phase` 로 채널 구분:
                    // commentary = 작업 중 중간 코멘트("…하겠습니다") → 답변이 아니라 생각중 채널.
                    // 옛 파서가 둘 다 답변에 합쳐 같은 말이 두 번 나오던 버그(2026-07-15 실측:
                    // "정리할게요"+"정리했습니다"). phase 부재(구버전) = 최종 답변으로 간주.
                    if item_type == "agent_message" && ev_type == "item.completed" {
                        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                            let is_commentary =
                                item.get("phase").and_then(|v| v.as_str()) == Some("commentary");
                            if is_commentary {
                                if !outcome.thinking_acc.is_empty() {
                                    outcome.thinking_acc.push('\n');
                                }
                                outcome.thinking_acc.push_str(t);
                                if let Some(tx) = emit {
                                    let _ = tx.try_send(LlmStreamEvent::Thinking(format!("{t}\n")));
                                }
                            } else {
                                text_parts.push(t.to_string());
                            }
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
                                    // 실시간 emit — frontend ThinkingBlock bodyText 누적 (claude 미러).
                                    if let Some(tx) = emit {
                                        let _ = tx.try_send(LlmStreamEvent::Thinking(format!("{t}\n")));
                                    }
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
                            if let Some(tx) = emit {
                                let _ = tx.try_send(LlmStreamEvent::Thinking("[계획 정리]\n".to_string()));
                                let _ = tx.try_send(LlmStreamEvent::ToolStep {
                                    name: "plan".to_string(),
                                    status: "start".to_string(),
                                });
                            }
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
                            let marker = firebat_core::i18n::t("core.llm.tool_call_marker", None, &[("name", &tool_name)]);
                            outcome.thinking_acc.push_str(&marker);
                            // 실시간 emit — Thinking(마커) + ToolStep(진행 라벨) (claude 미러).
                            if let Some(tx) = emit {
                                let _ = tx.try_send(LlmStreamEvent::Thinking(format!("{marker}\n")));
                                let _ = tx.try_send(LlmStreamEvent::ToolStep {
                                    name: tool_name.to_string(),
                                    status: "start".to_string(),
                                });
                            }
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
                                let (success, error_msg) =
                                    firebat_core::ports::summarize_tool_payload(&payload);
                                outcome.tool_results.push(firebat_core::ports::ToolResultSummary {
                                    name: tool_name.to_string(),
                                    success,
                                    error: error_msg,
                                    input: Some(args.clone()),
                                    cache_key: firebat_core::ports::extract_cache_key(&payload),
                                    rows: firebat_core::ports::extract_result_rows(&payload),
                                });
                                // 실시간 emit — 도구 완료/에러 (ToolStep done|error, claude 미러).
                                if let Some(tx) = emit {
                                    let _ = tx.try_send(LlmStreamEvent::ToolStep {
                                        name: tool_name.to_string(),
                                        status: if success { "done" } else { "error" }.to_string(),
                                    });
                                }
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

        cleanup_temp_file(tmp_image_path);
        // 자식 reap + stderr 회수 (스트리밍 전환으로 wait_with_output 폐기).
        let status = child.wait().await.ok();
        // Rotated tokens go home — see sync_auth_back. Runs on every exit, success or not.
        if let Some(h) = codex_home.as_ref() {
            sync_auth_back(h);
        }
        let stderr_buf = stderr_task.await.unwrap_or_default();

        if errored {
            return Err(error_msg.unwrap_or_else(|| "Codex CLI 알 수 없는 에러".to_string()));
        }
        // 각 조각 = 완결된 agent_message 한 통(item.completed 단위)이지 스트림 파편이 아니다.
        // 빈 문자열로 이으면 도구 앞 메시지와 최종 답변이 "…확인해 보겠습니다.부산에는" 처럼
        // 문장 경계 없이 붙는다(2026-07-27 실측). 메시지 사이는 문단으로 띄운다.
        outcome.text = text_parts
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !status.map(|s| s.success()).unwrap_or(false) {
            return Err(format!(
                "Codex 비정상 종료 (exit {:?}): {}",
                status.and_then(|s| s.code()),
                stderr_buf.chars().take(500).collect::<String>()
            ));
        }
        // 내장 이미지 도구 산출물 수확 — codex 가 `image_gen` 도구 대신 자기 내장 도구를 쓰면
        // 결과가 CODEX_HOME 에 갇혀 사용자에게 안 닿는다(2026-07-27 토익 턴 실측: 1.88MB PNG 가
        // 파일로만 남고 Firebat 은 인지 0). shell_tool=false + read-only 라 codex 스스로 옮길
        // 수단도 없으므로 호스트가 거둬 callee 가 갤러리에 담는다. 정공은 프롬프트가 `image_gen`
        // 도구로 유도하는 것(URL 이 있어야 컴포넌트에 박힌다) — 이건 유실 0 안전망.
        if let Some(home) = &codex_home {
            outcome.generated_images = harvest_generated_images(home, harvest_since)
                .into_iter()
                .map(|p| firebat_core::ports::CliGeneratedImage {
                    prompt: extract_image_prompt(&p),
                    path: p.to_string_lossy().into_owned(),
                })
                .collect();
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
    /// reasoning 요약 + commentary + 도구 호출 마커 누적 — frontend ThinkingBlock bodyText.
    /// 2026-07-15 스트리밍 전환: run_cli 가 줄 단위로 파싱하며 emit(Thinking/ToolStep)을 실시간
    /// 흘림(claude 미러). 이 누적본은 턴 종료 후 영속·리로드 표시용.
    thinking_acc: String,
    /// codex 가 자기 내장 이미지 도구로 CODEX_HOME 에 남긴 산출 파일 — 턴 종료 후 수확.
    generated_images: Vec<firebat_core::ports::CliGeneratedImage>,
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
        let outcome = Self::run_cli(&config.endpoint, prompt, opts, false, None).await?;
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
        prior_results: &[ToolResult],
        opts: &LlmCallOpts,
    ) -> InfraResult<LlmToolResponse> {
        // 비스트리밍 = 스트리밍 변형에 emit None 위임 (단일 구현, claude 미러).
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
        let outcome = Self::run_cli(&config.endpoint, prompt, opts, true, emit.as_ref()).await?;
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
            cli_generated_images: outcome.generated_images,
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
        // max 는 그대로 통과 — 지원 여부는 models.json 선언이 정하고 UI 도 그것만 보여준다.
        // 옛 `max → xhigh` 강등은 GPT-5.6(max 지원) 등장으로 거짓이 됐다.
        assert_eq!(
            CodexCliHandler::map_thinking_to_codex(Some("max")),
            Some("max")
        );
        assert_eq!(
            CodexCliHandler::map_thinking_to_codex(Some("xhigh")),
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

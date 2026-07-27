//! Codex CLI 이미지 생성 — 내장 `image_gen` 도구 (구독 기반, gpt-image-2 native).
//!
//! `codex exec --json --skip-git-repo-check "$imagegen <prompt>"` spawn → 프로세스 종료 후
//! **`$CODEX_HOME/generated_images/` 에서 산출 파일 수확**.
//!
//! **stdout 파싱을 안 쓰는 이유**(2026-07-27 서버 실측): 내장 도구는 이벤트 스트림에 이미지
//! 바이트를 싣지 않고 파일로만 저장한다 — codex 내장 imagegen 스킬이 문서화한 계약
//! ("In built-in tool mode, Codex saves generated images under `$CODEX_HOME/*` by default" /
//! "move or copy the selected output from `$CODEX_HOME/generated_images/...`"). 옛 구현은 stdout
//! 에서 base64·path 를 찾는 3패턴이라 매칭이 원리적으로 불가능했고, 그래서 생성이 성공해도
//! 타임아웃까지 기다렸다가 실패했다(제주 4장 요청 = 정확히 300초 후 `bytes: 0` 에러 레코드).
//!
//! 원래 그 이동은 codex 가 자기 쉘로 하지만 우리 config 는 `shell_tool = false` + read-only
//! sandbox 라 codex 쪽 배달 수단이 없다 → 호스트가 거둔다.
//!
//! cost_usd None (구독 포함).

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::image_gen::format_handler::{ImageFormatHandler, ImageFormatHandlerContext};
use crate::llm::formats::cli_codex::{copy_auth_json, harvest_generated_images};
use firebat_core::ports::{ImageGenCallOpts, ImageGenOpts, ImageGenResult, InfraResult};

/// 1장 생성 기준 여유 — 실측 단일 이미지 60~90초. 옛 300초는 프롬프트에 "4장" 이 들어오면
/// (모델이 순차로 4번 호출) 그대로 벽에 부딪혔다. 아래에서 1장으로 고정하므로 이 값은 재시도·
/// 추론 지연까지 덮는 여유분.
const CODEX_TIMEOUT: Duration = Duration::from_secs(420);

/// 이미지 전용 CODEX_HOME — LLM 채팅 경로(`firebat-codex-home`)와 분리.
/// 분리 이유: 수확 워터마크가 채팅 턴의 산출물과 섞이지 않게(경로별 독립).
const IMAGE_CODEX_HOME_DIR: &str = "firebat-codex-image-home";

/// 산출 파일 폴링 주기 / 크기 안정 확인 간격(쓰는 중 truncated read 방지).
const HARVEST_POLL: Duration = Duration::from_millis(1000);
const HARVEST_SETTLE: Duration = Duration::from_millis(700);

/// 실행이 어떻게 끝났나 — 에러 메시지 문맥 + 재수확 여부 결정.
enum RunEnd {
    /// 산출 파일을 먼저 건져 조기 종료(정상 경로).
    Harvested(Vec<PathBuf>),
    /// codex 가 스스로 끝남. 마지막 stdout 줄들(진단용).
    Exited(Vec<String>),
    TimedOut,
}

/// 파일별 크기 — 두 번 찍어 같으면 쓰기 완료로 본다.
fn file_sizes(paths: &[PathBuf]) -> Vec<u64> {
    paths
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .collect()
}

pub struct CliCodexImageFormat;

impl CliCodexImageFormat {
    pub fn new() -> Self {
        Self
    }

    /// 이미지 전용 CODEX_HOME 준비 — auth 복사 + 최소 config.toml.
    /// MCP 서버는 등록하지 않는다(이미지 생성에 Firebat 도구 불필요 = 표면 최소).
    fn ensure_image_codex_home() -> Option<PathBuf> {
        let codex_home = std::env::temp_dir().join(IMAGE_CODEX_HOME_DIR);
        std::fs::create_dir_all(&codex_home).ok()?;
        copy_auth_json(&codex_home);

        // 비대화형이라 승인 불가 → never. sandbox read-only + 쉘 차단 = LLM 경로와 같은 자세
        // (산출물은 우리가 파일로 거두므로 codex 에 쓰기 권한을 줄 이유가 없다).
        let toml = concat!(
            "approval_policy = \"never\"\n",
            "sandbox_mode = \"read-only\"\n",
            "web_search = \"disabled\"\n",
            "\n",
            "[features]\nshell_tool = false\n",
        );
        std::fs::write(codex_home.join("config.toml"), toml).ok()?;
        Some(codex_home)
    }
}

impl Default for CliCodexImageFormat {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ImageFormatHandler for CliCodexImageFormat {
    async fn generate(
        &self,
        opts: &ImageGenOpts,
        _call_opts: &ImageGenCallOpts,
        _ctx: ImageFormatHandlerContext<'_>,
    ) -> InfraResult<ImageGenResult> {
        // $imagegen 명시적 호출 + size/quality 는 프롬프트로 (Codex CLI 구조화 flag 미지원)
        let size_hint = match opts.size.as_deref() {
            Some(s) if s != "auto" => format!(" size:{}", s),
            _ => String::new(),
        };
        let quality_hint = match opts.quality.as_deref() {
            Some(q) => format!(" quality:{}", q),
            _ => String::new(),
        };
        // "정확히 1장" 고정 — 이 포트는 1 호출 = 1 이미지 계약(openai-image·gemini 와 동일)이고,
        // 프롬프트에 장수가 섞여 들어오면 codex 가 순차로 N 번 호출해 시간만 N 배가 된다.
        let prompt = format!(
            "$imagegen {}{}{}\n\nGenerate exactly one image.",
            opts.prompt, size_hint, quality_hint
        );

        let codex_home = Self::ensure_image_codex_home();
        // 수확 워터마크 — spawn 직전. 이전 실행 잔여물 재수확 차단.
        let started_at = SystemTime::now();

        // 플래그 = `--json --skip-git-repo-check` 만 (LLM 경로 `cli_codex.rs` 와 동일 base_flags).
        // 옛 `--output-format stream-json` 은 신버전 codex exec 에서 제거돼 exit 2 로 죽는다
        // (2026-07-23 실측). spawn 지점이 둘이면 둘 다 갱신할 것.
        let mut cmd = Command::new("codex");
        cmd.arg("exec")
            .arg("--json")
            .arg("--skip-git-repo-check")
            .arg(&prompt)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(home) = &codex_home {
            cmd.env("CODEX_HOME", home);
        }

        let mut child = cmd.spawn().map_err(|e| format!("Codex CLI spawn 실패: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex stdout pipe 없음".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex stderr pipe 없음".to_string())?;

        // stdout 은 진단용으로만 흘려보낸다(파이프가 차서 자식이 멈추는 것도 방지).
        let drain = async {
            let mut reader = BufReader::new(stdout).lines();
            let mut last_lines: Vec<String> = Vec::new();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                last_lines.push(line);
                if last_lines.len() > 20 {
                    last_lines.remove(0);
                }
            }
            last_lines
        };

        let run = async {
            let last_lines = drain.await;
            let _ = child.wait().await;
            last_lines
        };

        // **완료 신호 = 산출 파일, 프로세스 종료가 아니다.** codex 는 이미지를 낸 뒤에도 한참
        // 안 끝난다(2026-07-27 실측: 생성 56초 / 종료 대기 420초 = 타임아웃까지 감). 도구 결과에
        // "The generated image is already displayed to the user" 라고 적혀 있어 모델은 더 할 일이
        // 없다고 보고 마무리를 서두르지 않는다 — 우리가 기다릴 이유가 없다.
        // 파일이 보이면 크기가 안정될 때까지만 확인(쓰는 중 truncated read 방지) 후 즉시 종료.
        let watch = async {
            loop {
                tokio::time::sleep(HARVEST_POLL).await;
                let Some(home) = codex_home.as_ref() else {
                    continue;
                };
                let files = harvest_generated_images(home, started_at);
                if files.is_empty() {
                    continue;
                }
                let before = file_sizes(&files);
                tokio::time::sleep(HARVEST_SETTLE).await;
                let after = harvest_generated_images(home, started_at);
                if after.len() == files.len() && file_sizes(&after) == before {
                    return after;
                }
            }
        };

        let end = match timeout(CODEX_TIMEOUT, async {
            tokio::select! {
                files = watch => RunEnd::Harvested(files),
                lines = run => RunEnd::Exited(lines),
            }
        })
        .await
        {
            Ok(e) => e,
            Err(_) => RunEnd::TimedOut,
        };
        // child kill — 파일을 먼저 건졌으면 아직 살아 있다(그게 정상 경로).
        let _ = child.kill().await;

        // 종료·타임아웃으로 끝난 경우엔 여기서 한 번 더 훑는다. 타임아웃이어도 수확을 시도하는
        // 이유 = 이미 떨어진 산출물을 버릴 이유가 없어서.
        let harvested = match end {
            RunEnd::Harvested(ref files) => files.clone(),
            _ => codex_home
                .as_ref()
                .map(|h| harvest_generated_images(h, started_at))
                .unwrap_or_default(),
        };

        if harvested.is_empty() {
            let stderr_text = read_stderr(stderr).await;
            let tail = match &end {
                RunEnd::TimedOut => {
                    format!("타임아웃 ({}초) — 산출 파일 없음", CODEX_TIMEOUT.as_secs())
                }
                RunEnd::Exited(lines) => {
                    format!("마지막 stdout: {}", truncate(&lines.join("\n"), 500))
                }
                // Harvested 인데 비었다 = 도달 불가(watch 는 비면 return 안 함)
                RunEnd::Harvested(_) => "산출 파일 없음".to_string(),
            };
            return Err(format!(
                "Codex CLI 이미지 수확 실패 ({tail} / stderr: {})",
                truncate(&stderr_text, 500)
            ));
        }

        // 이 포트는 1장 계약 — 가장 최근 파일을 쓴다. 여러 장이 나오면 나머지는 쓰이지 않으므로
        // 조용히 버리지 않고 남긴다(호출자가 장수 불일치를 판독할 수 있게).
        if harvested.len() > 1 {
            tracing::info!(
                target: "media",
                "[cli-codex-image] {} 장 수확 — 포트 계약상 1 장만 사용(나머지 {} 장 폐기)",
                harvested.len(),
                harvested.len() - 1
            );
        }
        let picked = harvested.last().expect("non-empty");
        let binary = std::fs::read(picked)
            .map_err(|e| format!("이미지 파일 읽기 실패 ({}): {e}", picked.display()))?;
        let content_type = content_type_for(picked);

        // 소비한 산출물 정리 — /tmp 무한 증식 방지(장당 ~2MB).
        for path in &harvested {
            let _ = std::fs::remove_file(path);
        }

        Ok(ImageGenResult {
            binary,
            content_type,
            width: None,
            height: None,
            revised_prompt: None,
            cost_usd: None,
        })
    }
}

async fn read_stderr(stderr: tokio::process::ChildStderr) -> String {
    let mut buf = Vec::new();
    let mut reader = BufReader::new(stderr);
    let _ = reader.read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).to_string()
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 확장자 → MIME. 수확 파일은 codex 가 이름 짓는다.
fn content_type_for(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "webp" => "image/webp".to_string(),
        _ => "image/png".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn content_type_maps_by_extension() {
        assert_eq!(content_type_for(std::path::Path::new("a/b.png")), "image/png");
        assert_eq!(content_type_for(std::path::Path::new("a/b.JPG")), "image/jpeg");
        assert_eq!(content_type_for(std::path::Path::new("a/b.webp")), "image/webp");
        // 확장자 없음 = png 기본
        assert_eq!(content_type_for(std::path::Path::new("a/b")), "image/png");
    }

    /// 수확기는 워터마크 이후 파일만, 세션 하위 디렉토리까지 훑는다.
    #[test]
    fn harvest_respects_watermark_and_nested_dirs() {
        let root = std::env::temp_dir().join(format!(
            "firebat-harvest-test-{}",
            std::process::id()
        ));
        let session = root.join("generated_images").join("sess-1");
        std::fs::create_dir_all(&session).unwrap();

        // 워터마크 이전 파일
        let old = session.join("call_old.png");
        std::fs::File::create(&old).unwrap().write_all(b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let watermark = SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(30));

        // 워터마크 이후 파일 + 이미지 아닌 파일
        let new = session.join("call_new.png");
        std::fs::File::create(&new).unwrap().write_all(b"y").unwrap();
        let txt = session.join("notes.txt");
        std::fs::File::create(&txt).unwrap().write_all(b"z").unwrap();

        let found = harvest_generated_images(&root, watermark);
        assert_eq!(found.len(), 1, "워터마크 이후 이미지 1장만: {:?}", found);
        assert_eq!(found[0].file_name().unwrap(), "call_new.png");

        let _ = std::fs::remove_dir_all(&root);
    }
}

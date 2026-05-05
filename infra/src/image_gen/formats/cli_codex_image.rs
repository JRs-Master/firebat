//! Codex CLI 이미지 생성 — `$imagegen` skill (구독 기반, gpt-image-2 native).
//!
//! 옛 TS `infra/image/formats/cli-codex-image.ts` 1:1 port.
//! `codex exec --output-format stream-json --skip-git-repo-check "$imagegen <prompt>"` spawn →
//! stream-json 이벤트에서 image binary 추출 (3가지 패턴 매칭).
//!
//! 공식 프로토콜 문서 부재 — 옛 TS 와 같이 실측 후 보강. cost_usd None (구독 포함).

use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::image_gen::format_handler::{ImageFormatHandler, ImageFormatHandlerContext};
use firebat_core::ports::{ImageGenCallOpts, ImageGenOpts, ImageGenResult, InfraResult};

const CODEX_TIMEOUT: Duration = Duration::from_secs(300);

pub struct CliCodexImageFormat;

impl CliCodexImageFormat {
    pub fn new() -> Self {
        Self
    }

    /// stream-json 이벤트에서 이미지 binary 추출. 옛 TS `tryExtractImage` 1:1.
    /// 공식 프로토콜 미문서화 — 3가지 패턴 매칭 + 실측 후 보강 필요.
    fn try_extract_image(ev: &serde_json::Value) -> Option<InfraResult<ImageGenResult>> {
        let event_type = ev.get("type").and_then(|v| v.as_str())?;
        let item = ev.get("item");

        // 패턴 1: item.completed + item.type=image/agent_image/generated_image + data(base64) | path
        if event_type == "item.completed" {
            if let Some(item_obj) = item.and_then(|v| v.as_object()) {
                let item_type = item_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if matches!(item_type, "image" | "agent_image" | "generated_image") {
                    let mime_type = item_obj
                        .get("mime_type")
                        .and_then(|v| v.as_str())
                        .or_else(|| item_obj.get("mimeType").and_then(|v| v.as_str()))
                        .unwrap_or("image/png")
                        .to_string();
                    if let Some(data) = item_obj.get("data").and_then(|v| v.as_str()) {
                        match base64::engine::general_purpose::STANDARD.decode(data) {
                            Ok(binary) => {
                                return Some(Ok(ImageGenResult {
                                    binary,
                                    content_type: mime_type,
                                    width: None,
                                    height: None,
                                    revised_prompt: None,
                                    cost_usd: None,
                                }));
                            }
                            Err(e) => {
                                return Some(Err(format!("base64 decode 실패: {e}")));
                            }
                        }
                    }
                    if let Some(path) = item_obj.get("path").and_then(|v| v.as_str()) {
                        return Some(read_image_file(path, &mime_type));
                    }
                }
            }
        }

        // 패턴 2: tool_result + content 의 .png/.jpg/.webp path 매칭
        if event_type == "tool_result" {
            if let Some(content) = ev.get("content").and_then(|v| v.as_str()) {
                if let Some(path) = extract_image_path(content) {
                    return Some(read_image_file(&path, "image/png"));
                }
            }
        }

        None
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
        let prompt = format!("$imagegen {}{}{}", opts.prompt, size_hint, quality_hint);

        let mut cmd = Command::new("codex");
        cmd.arg("exec")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--skip-git-repo-check")
            .arg(&prompt)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Codex CLI spawn 실패: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex stdout pipe 없음".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Codex stderr pipe 없음".to_string())?;

        let extraction = async {
            let mut reader = BufReader::new(stdout).lines();
            let mut last_lines: Vec<String> = Vec::new();
            while let Some(line) = reader
                .next_line()
                .await
                .map_err(|e| format!("Codex stdout read: {e}"))?
            {
                if line.trim().is_empty() {
                    continue;
                }
                last_lines.push(line.clone());
                if last_lines.len() > 20 {
                    last_lines.remove(0);
                }
                if let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(result) = Self::try_extract_image(&ev) {
                        return result;
                    }
                }
            }
            // EOF without 추출 — stderr / 마지막 stdout 으로 진단
            let stderr_text = read_stderr(stderr).await;
            Err(format!(
                "Codex CLI 이미지 추출 실패 (stderr: {} / 마지막 stdout: {})",
                truncate(&stderr_text, 500),
                truncate(&last_lines.join("\n"), 500),
            ))
        };

        let result = match timeout(CODEX_TIMEOUT, extraction).await {
            Ok(r) => r,
            Err(_) => Err(format!(
                "Codex CLI 이미지 생성 타임아웃 ({}초)",
                CODEX_TIMEOUT.as_secs()
            )),
        };

        // child kill — 이미 종료됐어도 silent ok
        let _ = child.kill().await;
        result
    }
}

async fn read_stderr(stderr: tokio::process::ChildStderr) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut reader = BufReader::new(stderr);
    let _ = reader.read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).to_string()
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// `~` home 확장 + 파일 read.
fn read_image_file(path: &str, mime_type: &str) -> InfraResult<ImageGenResult> {
    let expanded = expand_home(path);
    let binary =
        std::fs::read(&expanded).map_err(|e| format!("이미지 파일 읽기 실패 ({}): {e}", expanded))?;
    Ok(ImageGenResult {
        binary,
        content_type: mime_type.to_string(),
        width: None,
        height: None,
        revised_prompt: None,
        cost_usd: None,
    })
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
        {
            return std::path::PathBuf::from(home)
                .join(rest)
                .to_string_lossy()
                .into_owned();
        }
    }
    path.to_string()
}

/// 옛 TS 의 `/([/~][\w/.-]+\.(?:png|jpg|webp))/` 매칭. 일반 로직 — 단순 substring + ext 검사.
fn extract_image_path(content: &str) -> Option<String> {
    // 모든 단어를 후보로 — `/` 또는 `~` 로 시작하고 `.png|.jpg|.webp` 로 끝나는 토큰 찾음.
    for token in content.split(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
        if (token.starts_with('/') || token.starts_with('~'))
            && (token.ends_with(".png") || token.ends_with(".jpg") || token.ends_with(".webp"))
        {
            return Some(token.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_image_path_finds_png_path() {
        assert_eq!(
            extract_image_path("Saved to /tmp/abc-123.png yay"),
            Some("/tmp/abc-123.png".to_string())
        );
        assert_eq!(
            extract_image_path("File: ~/Pictures/out.jpg"),
            Some("~/Pictures/out.jpg".to_string())
        );
        assert_eq!(extract_image_path("no image here"), None);
        // ext 만 있고 path 안 보이면 null
        assert_eq!(extract_image_path(".png alone"), None);
    }

    #[test]
    fn try_extract_image_pattern_1_base64() {
        let ev = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "image",
                "data": "iVBORw0KGgo=",
                "mime_type": "image/png"
            }
        });
        let result = CliCodexImageFormat::try_extract_image(&ev);
        let Some(Ok(image)) = result else {
            panic!("expected Some(Ok)");
        };
        assert_eq!(image.content_type, "image/png");
        // base64 decode "iVBORw0KGgo=" → PNG header bytes
        assert_eq!(&image.binary[..4], &[0x89, 0x50, 0x4E, 0x47]);
        assert_eq!(image.cost_usd, None);
    }

    #[test]
    fn try_extract_image_pattern_1_camelcase_mime() {
        let ev = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "agent_image",
                "data": "iVBORw0KGgo=",
                "mimeType": "image/webp"
            }
        });
        let result = CliCodexImageFormat::try_extract_image(&ev);
        let Some(Ok(image)) = result else {
            panic!("expected Some(Ok)");
        };
        assert_eq!(image.content_type, "image/webp");
    }

    #[test]
    fn try_extract_image_unrelated_event_returns_none() {
        let ev = serde_json::json!({"type": "item.started", "item": {"type": "thinking"}});
        assert!(CliCodexImageFormat::try_extract_image(&ev).is_none());
    }

    #[test]
    fn try_extract_image_invalid_base64_errors() {
        let ev = serde_json::json!({
            "type": "item.completed",
            "item": {
                "type": "image",
                "data": "not-valid-base64-!!!"
            }
        });
        let result = CliCodexImageFormat::try_extract_image(&ev);
        let Some(Err(e)) = result else {
            panic!("expected Some(Err)");
        };
        assert!(e.contains("base64 decode"));
    }
}

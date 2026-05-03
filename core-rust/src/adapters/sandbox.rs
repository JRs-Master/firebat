//! ProcessSandboxAdapter — ISandboxPort 의 tokio::process 구현체 (Phase B stub).
//!
//! Phase B 단계: minimum 동작 — 절대 경로 spawn + stdin JSON + stdout JSON 파싱.
//! 옛 TS sandbox (`infra/sandbox/index.ts`) 의 풍부한 기능 (Vault 시크릿 env 주입 +
//! path containment + timeout + 패키지 자동 install + 진행도 streaming 등) 은 후속 phase.
//!
//! Phase B-8 의 ModuleManager 가 이 adapter 활용. 실 sysmod 호출 검증은 Phase B 후속.

use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::ports::{ISandboxPort, InfraResult, ModuleOutput, SandboxExecuteOpts};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;

pub struct ProcessSandboxAdapter {
    workspace_root: PathBuf,
    /// Node binary 경로 (Phase D 자동 install 시 [data]/runtime/node/bin/node).
    /// Phase B 에선 시스템 PATH 의 'node' 사용 (default).
    node_bin: String,
    /// Python binary 경로 — 같은 패턴.
    python_bin: String,
}

impl ProcessSandboxAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            node_bin: std::env::var("FIREBAT_NODE_BIN").unwrap_or_else(|_| "node".to_string()),
            python_bin: std::env::var("FIREBAT_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string()),
        }
    }

    /// 모듈 entry path → 실행할 binary 결정 (확장자 기반).
    fn resolve_runtime(target_path: &str) -> Option<&'static str> {
        if target_path.ends_with(".mjs") || target_path.ends_with(".js") || target_path.ends_with(".cjs") {
            Some("node")
        } else if target_path.ends_with(".py") {
            Some("python")
        } else {
            None
        }
    }
}

#[async_trait::async_trait]
impl ISandboxPort for ProcessSandboxAdapter {
    async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        // path containment — workspace_root 안 보장
        if target_path.contains("..") || target_path.starts_with('/') {
            return Err(format!("workspace zone 밖 path 거부: {}", target_path));
        }
        let full_path = self.workspace_root.join(target_path);
        if !full_path.exists() {
            return Err(format!("모듈 entry 없음: {}", target_path));
        }
        let runtime = Self::resolve_runtime(target_path)
            .ok_or_else(|| format!("지원되지 않는 모듈 확장자: {}", target_path))?;
        let bin = match runtime {
            "node" => &self.node_bin,
            "python" => &self.python_bin,
            _ => return Err(format!("unknown runtime: {runtime}")),
        };

        let mut cmd = Command::new(bin);
        cmd.arg(&full_path)
            .current_dir(&self.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // env 주입 (Vault 시크릿 자동 주입은 후속 — Phase B-8 minimum 은 명시 env 만)
        for (k, v) in opts.env.iter() {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| format!("spawn 실패: {e}"))?;

        // stdin 에 input JSON 박음
        if let Some(mut stdin) = child.stdin.take() {
            let json = serde_json::to_string(input_data)
                .map_err(|e| format!("input JSON 직렬화 실패: {e}"))?;
            stdin
                .write_all(json.as_bytes())
                .await
                .map_err(|e| format!("stdin write 실패: {e}"))?;
            stdin.shutdown().await.ok();
        }

        // timeout 처리
        let timeout_ms = opts.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        let timeout = tokio::time::Duration::from_millis(timeout_ms);

        let stdout_handle = child.stdout.take();
        let stderr_handle = child.stderr.take();

        let wait_result = tokio::time::timeout(timeout, child.wait()).await;
        let exit_status = match wait_result {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => return Err(format!("child wait 실패: {e}")),
            Err(_) => {
                let _ = child.kill().await;
                return Err(format!("sandbox timeout ({timeout_ms}ms)"));
            }
        };

        // stdout / stderr 수집
        let mut stdout_buf = String::new();
        if let Some(mut h) = stdout_handle {
            h.read_to_string(&mut stdout_buf).await.ok();
        }
        let mut stderr_buf = String::new();
        if let Some(mut h) = stderr_handle {
            h.read_to_string(&mut stderr_buf).await.ok();
        }

        let exit_code = exit_status.code();
        if !exit_status.success() {
            return Ok(ModuleOutput {
                success: false,
                data: serde_json::Value::Null,
                error: Some(format!("exit code: {:?}", exit_code)),
                stderr: if stderr_buf.is_empty() { None } else { Some(stderr_buf) },
                exit_code,
            });
        }

        // stdout JSON parse
        let trimmed = stdout_buf.trim();
        let data: serde_json::Value = if trimmed.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({"stdout": trimmed}))
        };

        Ok(ModuleOutput {
            success: true,
            data,
            error: None,
            stderr: if stderr_buf.is_empty() { None } else { Some(stderr_buf) },
            exit_code,
        })
    }
}

/// Stub adapter — 실 spawn 안 하고 미리 박은 응답 반환. 단위 테스트 용.
#[cfg(test)]
pub struct StubSandboxAdapter {
    pub fixed_output: ModuleOutput,
}

#[cfg(test)]
#[async_trait::async_trait]
impl ISandboxPort for StubSandboxAdapter {
    async fn execute(
        &self,
        _target_path: &str,
        _input_data: &serde_json::Value,
        _opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        Ok(self.fixed_output.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn rejects_path_traversal() {
        let tmp = tempdir().unwrap();
        let sandbox = ProcessSandboxAdapter::new(tmp.path().to_path_buf());

        let result = sandbox
            .execute(
                "../etc/passwd",
                &serde_json::json!({}),
                &SandboxExecuteOpts::default(),
            )
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_absolute_path() {
        let tmp = tempdir().unwrap();
        let sandbox = ProcessSandboxAdapter::new(tmp.path().to_path_buf());

        let result = sandbox
            .execute("/tmp/x.js", &serde_json::json!({}), &SandboxExecuteOpts::default())
            .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_unknown_extension() {
        let tmp = tempdir().unwrap();
        // 빈 파일 박음 (path 존재 검사 통과 위해)
        let path = tmp.path().join("foo.exe");
        std::fs::write(&path, "").unwrap();
        let sandbox = ProcessSandboxAdapter::new(tmp.path().to_path_buf());

        let result = sandbox
            .execute("foo.exe", &serde_json::json!({}), &SandboxExecuteOpts::default())
            .await;
        assert!(result.is_err());
    }
}

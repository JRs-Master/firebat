//! ProcessSandboxAdapter — ISandboxPort 의 tokio::process 구현체 (Phase B stub).
//!
//! Phase B 단계: minimum 동작 — 절대 경로 spawn + stdin JSON + stdout JSON 파싱.
//! 옛 TS sandbox (`infra/sandbox/index.ts`) 의 풍부한 기능 (Vault 시크릿 env 주입 +
//! path containment + timeout + 패키지 자동 install + 진행도 streaming 등) 은 후속 phase.
//!
//! Phase B-8 의 ModuleManager 가 이 adapter 활용. 실 sysmod 호출 검증은 Phase B 후속.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::ports::{ISandboxPort, IVaultPort, InfraResult, ModuleOutput, SandboxExecuteOpts};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;

/// Runtime spec — 확장자 → command + 추가 인자.
/// 새 runtime (Ruby / Bun / Deno / etc) 추가 시 ProcessSandboxAdapter::with_runtime() 또는
/// ctor 의 default registry 에 박음. 코드 분기 (if-else 체인) 없음.
#[derive(Debug, Clone)]
pub struct RuntimeSpec {
    pub command: String,
    pub args: Vec<String>,
}

pub struct ProcessSandboxAdapter {
    workspace_root: PathBuf,
    /// 확장자 → RuntimeSpec 매핑. Default 는 node (mjs/js/cjs/ts) + python (py/py3).
    /// env 변수로 binary 경로 override (FIREBAT_NODE_BIN / FIREBAT_PYTHON_BIN).
    runtimes: HashMap<String, RuntimeSpec>,
    /// Vault — config.json `secrets` 배열의 키를 자동으로 env 에 주입.
    /// 옛 TS setVault / loadSecretsEnv 1:1. 미박힘 시 secrets 주입 스킵.
    vault: Option<Arc<dyn IVaultPort>>,
}

impl ProcessSandboxAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        let node_bin = std::env::var("FIREBAT_NODE_BIN").unwrap_or_else(|_| "node".to_string());
        let python_bin =
            std::env::var("FIREBAT_PYTHON_BIN").unwrap_or_else(|_| "python3".to_string());

        let mut runtimes = HashMap::new();
        for ext in ["mjs", "js", "cjs", "ts"] {
            runtimes.insert(
                ext.to_string(),
                RuntimeSpec {
                    command: node_bin.clone(),
                    args: vec![],
                },
            );
        }
        for ext in ["py", "py3"] {
            runtimes.insert(
                ext.to_string(),
                RuntimeSpec {
                    command: python_bin.clone(),
                    args: vec![],
                },
            );
        }

        Self {
            workspace_root,
            runtimes,
            vault: None,
        }
    }

    /// Runtime 등록 — 새 언어 (Ruby / Bun / Deno) 추가 시 ctor 후 호출.
    /// 코드 분기 추가 없이 dispatch table 확장.
    pub fn with_runtime(mut self, ext: impl Into<String>, spec: RuntimeSpec) -> Self {
        self.runtimes.insert(ext.into(), spec);
        self
    }

    /// Vault 박은 채로 부팅 — sysmod 실행 시 `secrets` 배열의 키를 자동으로 env 에 주입.
    /// 옛 TS sandbox.setVault 1:1. 미박힘 시 secrets 자동 주입 비활성 (manual env 만 사용).
    pub fn with_vault(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.vault = Some(vault);
        self
    }

    /// config.json 의 `secrets` 배열 + 모듈 settings 를 읽어 env 객체 반환.
    /// 옛 TS loadSecretsEnv 1:1.
    ///
    /// 흐름:
    /// 1. `<module_dir>/config.json` 파싱 → `secrets: ["KEY1", "KEY2"]` 배열
    /// 2. 각 키마다 Vault `user:KEY` 조회 → env 박음
    /// 3. 모듈 settings (`system:module:<name>:settings`) 의 모든 필드 → `MODULE_<KEY>` env 주입
    /// 4. tokenCache 패턴 (옛 TS) — Phase B-19+ 후속
    fn load_secrets_env(&self, module_dir: &Path) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = HashMap::new();
        let Some(vault) = &self.vault else {
            return env;
        };
        let manifest_path = module_dir.join("config.json");
        let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
            return env;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return env;
        };

        // 1. secrets 배열 → user: 접두사로 Vault 조회
        if let Some(secrets) = parsed.get("secrets").and_then(|v| v.as_array()) {
            for s in secrets {
                if let Some(name) = s.as_str() {
                    if let Some(value) = vault.get_secret(&format!("user:{name}")) {
                        env.insert(name.to_string(), value);
                    }
                }
            }
        }

        // 2. 모듈 settings → MODULE_<KEY> env 주입 (옛 TS 1:1)
        let module_name = parsed
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                module_dir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string()
            });
        let settings_key = format!("system:module:{module_name}:settings");
        if let Some(settings_raw) = vault.get_secret(&settings_key) {
            if let Ok(settings) = serde_json::from_str::<serde_json::Value>(&settings_raw) {
                if let Some(map) = settings.as_object() {
                    for (k, v) in map {
                        if v.is_null() {
                            continue;
                        }
                        let str_val = match v {
                            serde_json::Value::String(s) if s.is_empty() => continue,
                            serde_json::Value::String(s) => s.clone(),
                            other => other.to_string(),
                        };
                        env.insert(format!("MODULE_{}", k.to_uppercase()), str_val);
                    }
                }
            }
        }

        env
    }

    /// 확장자 → RuntimeSpec lookup. 매칭 안 되면 None.
    fn resolve_runtime(&self, target_path: &str) -> Option<&RuntimeSpec> {
        let ext = target_path.rsplit('.').next()?.to_lowercase();
        self.runtimes.get(&ext)
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
        let runtime = self
            .resolve_runtime(target_path)
            .ok_or_else(|| format!("지원되지 않는 모듈 확장자: {}", target_path))?;

        let mut cmd = Command::new(&runtime.command);
        for arg in &runtime.args {
            cmd.arg(arg);
        }
        cmd.arg(&full_path)
            .current_dir(&self.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Vault secrets 자동 주입 — config.json `secrets` 배열 → env (옛 TS loadSecretsEnv 1:1).
        // module_dir = full_path 의 부모 (e.g. system/modules/firecrawl/index.mjs → system/modules/firecrawl).
        if let Some(module_dir) = full_path.parent() {
            for (k, v) in self.load_secrets_env(module_dir) {
                cmd.env(k, v);
            }
        }
        // 명시 env 는 secrets 위에 (사용자가 명시 박은 게 우선)
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

    #[test]
    fn load_secrets_env_reads_config_secrets_from_vault() {
        use crate::adapters::vault::SqliteVaultAdapter;
        let tmp = tempdir().unwrap();
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(tmp.path().join("vault.db")).unwrap());
        // Vault 에 시크릿 미리 박음
        vault.set_secret("user:KIWOOM_APP_KEY", "test-app-key");
        vault.set_secret("user:KIWOOM_APP_SECRET", "test-app-secret");
        vault.set_secret("user:UNRELATED_KEY", "skip-me");

        // 모듈 디렉토리 + config.json 박음
        let module_dir = tmp.path().join("system/modules/kiwoom");
        std::fs::create_dir_all(&module_dir).unwrap();
        let config_json = serde_json::json!({
            "name": "kiwoom",
            "secrets": ["KIWOOM_APP_KEY", "KIWOOM_APP_SECRET"]
        });
        std::fs::write(
            module_dir.join("config.json"),
            serde_json::to_string(&config_json).unwrap(),
        )
        .unwrap();

        let sandbox =
            ProcessSandboxAdapter::new(tmp.path().to_path_buf()).with_vault(vault);
        let env = sandbox.load_secrets_env(&module_dir);
        // secrets 배열에 박힌 키만 주입
        assert_eq!(env.get("KIWOOM_APP_KEY").map(|s| s.as_str()), Some("test-app-key"));
        assert_eq!(
            env.get("KIWOOM_APP_SECRET").map(|s| s.as_str()),
            Some("test-app-secret")
        );
        // secrets 배열에 미박은 키는 주입 안 됨
        assert!(env.get("UNRELATED_KEY").is_none());
    }

    #[test]
    fn load_secrets_env_no_vault_returns_empty() {
        let tmp = tempdir().unwrap();
        let module_dir = tmp.path().join("system/modules/kiwoom");
        std::fs::create_dir_all(&module_dir).unwrap();
        let config_json = serde_json::json!({"secrets": ["X"]});
        std::fs::write(
            module_dir.join("config.json"),
            serde_json::to_string(&config_json).unwrap(),
        )
        .unwrap();

        // Vault 미박힘 → empty env (회귀 안전)
        let sandbox = ProcessSandboxAdapter::new(tmp.path().to_path_buf());
        let env = sandbox.load_secrets_env(&module_dir);
        assert!(env.is_empty());
    }

    #[test]
    fn load_secrets_env_module_settings_injected_as_module_prefix() {
        use crate::adapters::vault::SqliteVaultAdapter;
        let tmp = tempdir().unwrap();
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(tmp.path().join("vault.db")).unwrap());
        // 모듈 settings 박음 (옛 TS MODULE_<KEY> env 패턴 1:1)
        let settings = serde_json::json!({
            "endpoint": "https://api.test.com",
            "timeout_ms": 30000,
            "enabled": true,
            "empty_field": "",
            "null_field": null
        });
        vault.set_secret(
            "system:module:firecrawl:settings",
            &serde_json::to_string(&settings).unwrap(),
        );

        let module_dir = tmp.path().join("system/modules/firecrawl");
        std::fs::create_dir_all(&module_dir).unwrap();
        std::fs::write(
            module_dir.join("config.json"),
            serde_json::to_string(&serde_json::json!({"name": "firecrawl"})).unwrap(),
        )
        .unwrap();

        let sandbox =
            ProcessSandboxAdapter::new(tmp.path().to_path_buf()).with_vault(vault);
        let env = sandbox.load_secrets_env(&module_dir);
        // 정상 settings 는 MODULE_<UPPER> 형태로 주입
        assert_eq!(
            env.get("MODULE_ENDPOINT").map(|s| s.as_str()),
            Some("https://api.test.com")
        );
        assert_eq!(env.get("MODULE_TIMEOUT_MS").map(|s| s.as_str()), Some("30000"));
        // null / empty 필드는 skip (옛 TS 1:1)
        assert!(env.get("MODULE_EMPTY_FIELD").is_none());
        assert!(env.get("MODULE_NULL_FIELD").is_none());
    }
}

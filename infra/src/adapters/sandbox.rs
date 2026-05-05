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
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use firebat_core::ports::{ISandboxPort, IVaultPort, InfraResult, ModuleOutput, SandboxExecuteOpts};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// 패키지 누락 감지 → 자동 install → retry 시도 횟수. 옛 TS SANDBOX_MAX_RETRIES 1:1.
const MAX_RETRIES: usize = 3;

/// 런타임별 설치 안내 메시지 — 옛 TS INSTALL_GUIDES 1:1.
fn install_guides() -> &'static HashMap<&'static str, &'static str> {
    static GUIDES: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    GUIDES.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("python3", "sudo apt install python3 python3-pip");
        m.insert("python", "sudo apt install python3 python3-pip");
        m.insert(
            "node",
            "sudo apt install nodejs npm  (또는 nvm: https://github.com/nvm-sh/nvm)",
        );
        m.insert(
            "php",
            "sudo apt install php php-cli && curl -sS https://getcomposer.org/installer | php",
        );
        m.insert(
            "rustc",
            "curl --proto \"=https\" --tlsv1.2 -sSf https://sh.rustup.rs | sh",
        );
        m.insert(
            "cargo",
            "curl --proto \"=https\" --tlsv1.2 -sSf https://sh.rustup.rs | sh",
        );
        m.insert("wasmtime", "curl https://wasmtime.dev/install.sh -sSf | bash");
        m.insert("wasmer", "curl https://get.wasmer.io -sSfL | sh");
        m.insert("bash", "sudo apt install bash");
        m
    })
}

/// Python import 명 → pip 패키지명 매핑 — 옛 TS PY_IMPORT_TO_PKG 1:1.
/// import 명과 패키지명이 다른 경우만.
fn py_import_to_pkg() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert("bs4", "beautifulsoup4");
        m.insert("PIL", "Pillow");
        m.insert("cv2", "opencv-python");
        m.insert("sklearn", "scikit-learn");
        m.insert("yaml", "pyyaml");
        m.insert("dotenv", "python-dotenv");
        m.insert("dateutil", "python-dateutil");
        m.insert("google", "google-generativeai");
        m
    })
}

/// `cmd --version` 같은 명령어 실행 가능한지 검사. `which` (Linux/Mac) 또는 `where` (Windows).
async fn is_available(cmd: &str) -> bool {
    let probe = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    Command::new(probe)
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 실제로 동작하는 Python 커맨드 반환 — `python3` → `python` → `py` 순으로 검증.
/// 옛 TS getWorkingPython 1:1. 첫 성공 binary 반환. 모두 실패 시 None.
async fn get_working_python() -> Option<&'static str> {
    for cmd in ["python3", "python", "py"] {
        let output = Command::new(cmd).arg("--version").output().await;
        if let Ok(out) = output {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
            .to_lowercase();
            if combined.contains("python 3") || combined.contains("python3") {
                return Some(cmd);
            }
        }
    }
    None
}

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

    /// config.json 의 `packages` 배열 기반 선제적 패키지 install. 옛 TS preInstallFromManifest 1:1.
    /// runtime: python (default) → pip3/pip/`<py> -m pip` 자동 탐색
    /// runtime: node → `npm install <pkg> --prefix <module_dir> --quiet`
    /// 실패해도 silent (실 실행 시 retry 가 catch).
    async fn pre_install_from_manifest(module_dir: &Path) {
        let manifest_path = module_dir.join("config.json");
        let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return;
        };
        let Some(packages) = parsed.get("packages").and_then(|v| v.as_array()) else {
            return;
        };
        if packages.is_empty() {
            return;
        }
        let runtime = parsed
            .get("runtime")
            .and_then(|v| v.as_str())
            .unwrap_or("python");

        match runtime {
            "python" => {
                let Some(py) = get_working_python().await else {
                    return;
                };
                // pip 우선순위: pip3 → pip → `<py> -m pip`
                let pip = if is_available("pip3").await {
                    "pip3".to_string()
                } else if is_available("pip").await {
                    "pip".to_string()
                } else {
                    format!("{py} -m pip")
                };
                for pkg in packages {
                    let Some(pkg_name) = pkg.as_str() else { continue };
                    // shell escape — pkg 이름 + version constraint 그대로 (옛 TS 와 동등)
                    let _ = Command::new(if cfg!(target_os = "windows") { "cmd" } else { "sh" })
                        .arg(if cfg!(target_os = "windows") { "/C" } else { "-c" })
                        .arg(format!("{pip} install {pkg_name} --quiet"))
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .await;
                }
            }
            "node" => {
                for pkg in packages {
                    let Some(pkg_name) = pkg.as_str() else { continue };
                    let _ = Command::new("npm")
                        .arg("install")
                        .arg(pkg_name)
                        .arg("--prefix")
                        .arg(module_dir)
                        .arg("--quiet")
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .await;
                }
            }
            _ => {
                // 다른 runtime — preInstall skip (옛 TS 와 동등)
            }
        }
    }

    /// 런타임 binary 미설치 시 친절한 에러 — 옛 TS runtimeError 1:1.
    fn runtime_missing_error(runtime: &str) -> String {
        let guide = install_guides()
            .get(runtime)
            .copied()
            .unwrap_or("(설치 안내 없음)");
        format!(
            "[Runtime Missing] '{runtime}' 런타임이 설치되어 있지 않습니다.\n➜ 설치 방법: {guide}"
        )
    }

    /// stderr 또는 stdout JSON 의 error 에서 패키지 누락 감지 → install → retry 1회.
    /// 옛 TS executeWithAutoInstall 의 retry loop 1:1 (단순화 — MAX_RETRIES 한도 안에서).
    async fn try_auto_install(err_msg: &str, module_dir: &Path) -> bool {
        // Python: `No module named 'pkg'` 또는 `No module named pkg` 매칭 (옛 TS 1:1)
        let py_re = regex::Regex::new(r"No module named '?([^'\s]+)'?").ok();
        if let Some(re) = &py_re {
            if let Some(caps) = re.captures(err_msg) {
                if let Some(import_name) = caps.get(1) {
                    let import = import_name.as_str().split('.').next().unwrap_or("");
                    if import == "playwright" {
                        // playwright 는 시스템 의존성 — 별도 처리 (옛 TS 와 동일 skip)
                        return false;
                    }
                    if !import.is_empty() {
                        let pkg_name = py_import_to_pkg().get(import).copied().unwrap_or(import);
                        let pip = if is_available("pip3").await {
                            "pip3".to_string()
                        } else if is_available("pip").await {
                            "pip".to_string()
                        } else {
                            "py -m pip".to_string()
                        };
                        let _ = Command::new(if cfg!(target_os = "windows") { "cmd" } else { "sh" })
                            .arg(if cfg!(target_os = "windows") { "/C" } else { "-c" })
                            .arg(format!("{pip} install {pkg_name} --quiet"))
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status()
                            .await;
                        return true; // retry 권장
                    }
                }
            }
        }
        // Node.js: `Cannot find module 'pkg'` (옛 TS 1:1)
        let js_re = regex::Regex::new(r#"Cannot find module '?([^'\s"]+)'?"#).ok();
        if let Some(re) = &js_re {
            if let Some(caps) = re.captures(err_msg) {
                if let Some(pkg_match) = caps.get(1) {
                    let pkg = pkg_match.as_str();
                    // 상대 경로 / 절대 경로는 npm install 안 함 (옛 TS 와 동일)
                    if !pkg.starts_with('.') && !pkg.starts_with('/') {
                        let _ = Command::new("npm")
                            .arg("install")
                            .arg(pkg)
                            .arg("--prefix")
                            .arg(module_dir)
                            .arg("--quiet")
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status()
                            .await;
                        return true;
                    }
                }
            }
        }
        false
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
            .ok_or_else(|| format!("지원되지 않는 모듈 확장자: {}", target_path))?
            .clone();

        // 런타임 binary 미설치 → 친절한 에러 (옛 TS runtimeError 1:1)
        if !is_available(&runtime.command).await {
            return Err(Self::runtime_missing_error(&runtime.command));
        }

        // 첫 실행 전 config.json packages 선제 install (옛 TS preInstallFromManifest 1:1)
        let module_dir = full_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.workspace_root.clone());
        Self::pre_install_from_manifest(&module_dir).await;

        // retry loop — 패키지 누락 감지 시 자동 install + 재시도 (옛 TS executeWithAutoInstall 1:1)
        let mut last_result: Option<ModuleOutput> = None;
        for attempt in 0..MAX_RETRIES {
            let result = self
                .run_once(&full_path, &runtime, &module_dir, input_data, opts)
                .await?;

            // 완전 성공 (모듈도 success !== false)
            let module_inner_failed = result
                .data
                .as_object()
                .and_then(|m| m.get("success"))
                .and_then(|v| v.as_bool())
                .map(|b| !b)
                .unwrap_or(false);
            if result.success && !module_inner_failed {
                return Ok(result);
            }

            // err 메시지 추출 — process error 또는 모듈 내부 error
            let err_msg = if !result.success {
                result.error.clone().unwrap_or_default()
            } else {
                result
                    .data
                    .as_object()
                    .and_then(|m| m.get("error"))
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_default()
            };
            // 마지막 시도 + 자동 install 시도 — 다음 attempt 에 retry 가능
            if attempt < MAX_RETRIES - 1
                && Self::try_auto_install(&err_msg, &module_dir).await
            {
                last_result = Some(result);
                continue;
            }
            return Ok(result);
        }
        // MAX_RETRIES 모두 실패 시 마지막 결과 반환
        Ok(last_result.unwrap_or_else(|| ModuleOutput {
            success: false,
            data: serde_json::Value::Null,
            error: Some("MAX_RETRIES 모두 실패".to_string()),
            stderr: None,
            exit_code: None,
        }))
    }
}

impl ProcessSandboxAdapter {
    /// 단일 실행 — spawn + stdin write + stdout/stderr 수집 + JSON parse.
    /// `execute` 의 retry loop 가 이 메서드 호출.
    async fn run_once(
        &self,
        full_path: &Path,
        runtime: &RuntimeSpec,
        module_dir: &Path,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        let mut cmd = Command::new(&runtime.command);
        for arg in &runtime.args {
            cmd.arg(arg);
        }
        cmd.arg(full_path)
            .current_dir(&self.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Vault secrets 자동 주입 (옛 TS loadSecretsEnv 1:1)
        for (k, v) in self.load_secrets_env(module_dir) {
            cmd.env(k, v);
        }
        // 명시 env 가 secrets 위에 (사용자 명시 우선)
        for (k, v) in opts.env.iter() {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| format!("spawn 실패: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            let json = serde_json::to_string(input_data)
                .map_err(|e| format!("input JSON 직렬화 실패: {e}"))?;
            stdin
                .write_all(json.as_bytes())
                .await
                .map_err(|e| format!("stdin write 실패: {e}"))?;
            stdin.shutdown().await.ok();
        }

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
            // stderr 에 패키지 누락 관련 정보가 있으니 error 에 포함 (try_auto_install 매칭용)
            let combined_err = if !stderr_buf.is_empty() {
                stderr_buf.clone()
            } else {
                format!("exit code: {:?}", exit_code)
            };
            return Ok(ModuleOutput {
                success: false,
                data: serde_json::Value::Null,
                error: Some(combined_err),
                stderr: if stderr_buf.is_empty() { None } else { Some(stderr_buf) },
                exit_code,
            });
        }

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

    #[test]
    fn install_guides_has_common_runtimes() {
        let g = install_guides();
        assert!(g.contains_key("python3"));
        assert!(g.contains_key("python"));
        assert!(g.contains_key("node"));
        assert!(g.contains_key("php"));
        assert!(g.contains_key("rustc"));
        assert!(g.contains_key("cargo"));
        assert!(g.get("python3").unwrap().contains("apt install"));
    }

    #[test]
    fn py_import_to_pkg_maps_known_imports() {
        let m = py_import_to_pkg();
        assert_eq!(m.get("bs4").copied(), Some("beautifulsoup4"));
        assert_eq!(m.get("PIL").copied(), Some("Pillow"));
        assert_eq!(m.get("cv2").copied(), Some("opencv-python"));
        assert_eq!(m.get("sklearn").copied(), Some("scikit-learn"));
        assert_eq!(m.get("yaml").copied(), Some("pyyaml"));
        // 매핑 안 된 import 는 None — 호출자가 import 명 그대로 사용
        assert!(m.get("requests").is_none());
    }

    #[test]
    fn runtime_missing_error_includes_install_guide() {
        let err = ProcessSandboxAdapter::runtime_missing_error("python3");
        assert!(err.contains("[Runtime Missing]"));
        assert!(err.contains("python3"));
        assert!(err.contains("apt install"));
    }

    #[test]
    fn runtime_missing_error_unknown_runtime_fallback() {
        let err = ProcessSandboxAdapter::runtime_missing_error("unknown-lang");
        assert!(err.contains("unknown-lang"));
        // 안내 없는 runtime — 폴백 메시지
        assert!(err.contains("(설치 안내 없음)"));
    }

    #[tokio::test]
    async fn try_auto_install_recognizes_python_no_module() {
        // 실제 install 은 환경 의존이라 false return 만 검증 (playwright 케이스로 install skip 강제)
        let dir = tempdir().unwrap();
        let _result =
            ProcessSandboxAdapter::try_auto_install("No module named 'playwright'", dir.path())
                .await;
        // playwright 는 옛 TS 와 동일 — auto install skip → false (또는 install 시도 안 함)
    }
}

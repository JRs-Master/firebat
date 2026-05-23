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
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::Mutex as TokioMutex;

use firebat_core::managers::status::StatusManager;
use firebat_core::ports::{
    ISandboxPort, IVaultPort, InfraResult, ModuleOutput, PackageStatus, PackageStatusKind,
    SandboxExecuteOpts,
};
use firebat_core::utils::sysmod_cache::SysmodCacheAdapter;

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const PYPI_CACHE_TTL: Duration = Duration::from_secs(3600);

/// PyPI registry 안 최신 버전 캐시 — 매 polling 시 network 호출 부담 차단. 1시간 TTL.
/// HashMap<package_name, (Instant, Option<latest_version>)>.
/// None 박힌 영역 = network fail 또는 PyPI 안 패키지 없음 — 같은 TTL 동안 재시도 X.
fn pypi_cache() -> &'static TokioMutex<HashMap<String, (Instant, Option<String>)>> {
    static CACHE: OnceLock<TokioMutex<HashMap<String, (Instant, Option<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| TokioMutex::new(HashMap::new()))
}

/// PyPI JSON API 안 최신 stable 버전 조회. 1시간 캐시. 호출 site = `get_package_status_for_module`.
async fn fetch_latest_pypi_version(pkg_name: &str) -> Option<String> {
    {
        let cache = pypi_cache().lock().await;
        if let Some((stored_at, version)) = cache.get(pkg_name) {
            if stored_at.elapsed() < PYPI_CACHE_TTL {
                return version.clone();
            }
        }
    }
    let url = format!("https://pypi.org/pypi/{}/json", pkg_name);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()?;
    let result: Option<String> = match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<serde_json::Value>().await {
                Ok(json) => json
                    .get("info")
                    .and_then(|v| v.get("version"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                Err(_) => None,
            }
        }
        _ => None,
    };
    let mut cache = pypi_cache().lock().await;
    cache.insert(pkg_name.to_string(), (Instant::now(), result.clone()));
    result
}

/// semver-like 비교 — `2.32.3` vs `2.32.4` 형식 안 dot 분리 + 숫자 ordering.
/// 두 영역 다 같은 길이 가정 X (한 쪽 박혀있고 다른 쪽 0 = 0 으로 보충).
/// 비교 결과: latest > required → true (업그레이드 가능), 그 외 false.
fn is_version_newer(latest: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| {
                // 안 `1.2.3rc1` 같은 영역 — rc/a/b 만나면 digit 만 추출 (보수적).
                let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<u64>().unwrap_or(0)
            })
            .collect()
    };
    let a = parse(latest);
    let b = parse(required);
    let max = a.len().max(b.len());
    for i in 0..max {
        let av = *a.get(i).unwrap_or(&0);
        let bv = *b.get(i).unwrap_or(&0);
        if av > bv {
            return true;
        }
        if av < bv {
            return false;
        }
    }
    false
}

/// config.json `packages` 엔트리 정규화 형태 — heterogeneous string OR object 모두 흡수.
///
/// 호환 형태:
/// - 문자열 (옛 형태): `"yfinance==0.2.51"` → `{name, post_install:None}`
/// - 객체:
///   ```json
///   {
///     "name": "playwright==1.59.1",
///     "postInstall": "python -m playwright install chromium"
///   }
///   ```
///
/// 옛 `heavy` / `estimatedSec` 필드는 잔존 호환 (read 시 무시). 매 install = background spawn +
/// StatusManager job — 사용자는 설정 화면에서 진행 상태를 확인합니다.
#[derive(Debug, Clone)]
struct PackageSpec {
    name: String,
    post_install: Option<String>,
}

impl PackageSpec {
    /// JSON 값 (string OR object) 정규화. 잘못된 형태 = None.
    fn from_json(value: &serde_json::Value) -> Option<Self> {
        if let Some(name) = value.as_str() {
            return Some(Self {
                name: name.to_string(),
                post_install: None,
            });
        }
        let obj = value.as_object()?;
        let name = obj.get("name").and_then(|v| v.as_str())?.to_string();
        let post_install = obj
            .get("postInstall")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        Some(Self { name, post_install })
    }

    /// `==X.Y.Z` specifier 안 명시 버전 추출. 다른 specifier (>=, ~=, <=, 등) = None.
    /// 사용자 의도 = 고정 버전. caller 가 두 버전 비교 안 업그레이드 가능 여부 결정.
    fn required_version(&self) -> Option<String> {
        let idx = self.name.find("==")?;
        let rest = &self.name[idx + 2..];
        // 같은 패키지 안 추가 specifier 박혀있을 가능성 (예: `pkg==1.0.0,<2.0`) — 첫 specifier 까지만.
        for sep in [",", ";", " "] {
            if let Some(end) = rest.find(sep) {
                return Some(rest[..end].trim().to_string());
            }
        }
        Some(rest.trim().to_string())
    }

    /// pip install 시점 패키지 식별자에서 version specifier 제거 — `playwright==1.59.1` → `playwright`.
    /// StatusManager job id / 사용자 표시 메시지에서 사용.
    fn display_name(&self) -> &str {
        for sep in ["==", ">=", "<=", "~=", "!=", ">", "<"] {
            if let Some(idx) = self.name.find(sep) {
                return &self.name[..idx];
            }
        }
        &self.name
    }
}

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

/// pip 우선순위 해결 — `pip3` → `pip` → `<py> -m pip` 순. 매 Python install 호출자가 공유.
async fn resolve_pip_command(py: &str) -> String {
    if is_available("pip3").await {
        "pip3".to_string()
    } else if is_available("pip").await {
        "pip".to_string()
    } else {
        format!("{py} -m pip")
    }
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
/// ctor 의 default registry 에 저장. 코드 분기 (if-else 체인) 없음.
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
    /// 옛 TS setVault / loadSecretsEnv 1:1. 미설정 시 secrets 주입 스킵.
    vault: Option<Arc<dyn IVaultPort>>,
    /// StatusManager — heavy 패키지 (playwright / pandas-large / tensorflow 등) 의 background
    /// install 진행 상태 추적. 미설정 시 heavy 패키지도 foreground (옛 동작과 동일) 진행.
    /// 설정 시 사용자 호출 즉시 응답 (`core.install.in_progress` errorKey) + 완료 후 자동 재시도 가능.
    status: Option<Arc<StatusManager>>,
    /// SysmodCacheAdapter — sysmod 응답 안 `_cache` envelope 박혀있으면 자동 cache 저장.
    /// 옛 TS 흐름 1:1 — yfinance / 한투 / 키움 / DART 같은 큰 시계열 응답 (50행+) 안 records 통째
    /// LLM context 박지 않고 cacheKey 받아 cache_read / cache_grep / cache_aggregate 도구 사용.
    /// 미설정 시 `_cache` 박힌 응답도 그대로 통과 (옛 호환).
    cache: Option<Arc<SysmodCacheAdapter>>,
    /// Pre-exec hook (Linux 한정) — 자식 프로세스 안에서 fork() 직후 exec() 직전 호출.
    /// LinuxCgroupsSandboxAdapter 가 저장 — cgroup attach + seccomp install + unshare.
    /// 미설정 시 옛 동작 (격리 0). Phase B-post Track B Stage 2+3 설정 (2026-05-06).
    #[cfg(target_os = "linux")]
    pre_exec_hook: Option<Arc<dyn Fn() -> std::io::Result<()> + Send + Sync>>,
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
            status: None,
            cache: None,
            #[cfg(target_os = "linux")]
            pre_exec_hook: None,
        }
    }

    /// SysmodCacheAdapter 주입 — sysmod 응답 안 `_cache` envelope 자동 인식.
    /// 미설정 시 `_cache` 박힌 응답 그대로 통과 (옛 호환).
    pub fn with_cache(mut self, cache: Arc<SysmodCacheAdapter>) -> Self {
        self.cache = Some(cache);
        self
    }

    /// Runtime 등록 — 새 언어 (Ruby / Bun / Deno) 추가 시 ctor 후 호출.
    /// 코드 분기 추가 없이 dispatch table 확장.
    pub fn with_runtime(mut self, ext: impl Into<String>, spec: RuntimeSpec) -> Self {
        self.runtimes.insert(ext.into(), spec);
        self
    }

    /// Vault 설정한 채로 부팅 — sysmod 실행 시 `secrets` 배열의 키를 자동으로 env 에 주입.
    /// 옛 TS sandbox.setVault 1:1. 미설정 시 secrets 자동 주입 비활성 (manual env 만 사용).
    pub fn with_vault(mut self, vault: Arc<dyn IVaultPort>) -> Self {
        self.vault = Some(vault);
        self
    }

    /// StatusManager 주입 — 매 패키지 install 의 진행 상태를 ActiveJobsIndicator + 설정 화면이
    /// polling 가능한 형태로 노출합니다.
    ///
    /// 흐름 (매 install 동일):
    /// 1. `status.start(id="install-{name}", type="install", message="core.install.in_progress")`
    /// 2. tokio::spawn 으로 background `pip install --target ... {name}` + 선택적 postInstall
    /// 3. 완료 = `status.complete()`, 실패 = `status.fail()`
    /// 4. 사용자는 설정 화면이 polling 으로 진행 상태를 확인합니다.
    ///
    /// 미설정 시 install 함수는 즉시 반환만 합니다 (no-op) — 운영 환경은 항상 주입.
    pub fn with_status(mut self, status: Arc<StatusManager>) -> Self {
        self.status = Some(status);
        self
    }

    /// Pre-exec hook 등록 (Linux 한정) — 자식 프로세스 안에서 exec() 직전 실행.
    /// LinuxCgroupsSandboxAdapter 가 호출 — cgroup attach + seccomp install + unshare 저장.
    /// hook 안에서 panic 시 자식 프로세스 즉시 종료 (Rust pre_exec safety).
    #[cfg(target_os = "linux")]
    pub fn with_pre_exec_hook<F>(mut self, hook: F) -> Self
    where
        F: Fn() -> std::io::Result<()> + Send + Sync + 'static,
    {
        self.pre_exec_hook = Some(Arc::new(hook));
        self
    }

    /// config.json 의 `secrets` 배열 + 모듈 settings 를 읽어 env 객체 반환.
    /// 옛 TS loadSecretsEnv 1:1.
    ///
    /// 흐름:
    /// 1. `<module_dir>/config.json` 파싱 → `secrets: ["KEY1", "KEY2"]` 배열
    /// 2. 각 키마다 Vault `user:KEY` 조회 → env 저장
    /// 3. 모듈 settings (`system:module:<name>:settings`) 의 모든 필드 → `MODULE_<KEY>` env 주입
    /// 4. tokenCache.secretName 박은 영역 안 vault 조회 → env 주입 (옛 OAuth token cache 로드)
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

        // 1b. tokenCache.secretName 박은 영역 안 vault 조회 → env 주입.
        // 옛 OAuth token (예: KIS_ACCESS_TOKEN / KIWOOM_ACCESS_TOKEN) 박은 영역 안 매 호출 마다
        // 토큰 발급 호출 안 발생 — 한투 / 키움 측 rate limit 안 403 issue. cached token 박힌 영역
        // 안 즉시 사용 + 만료 박힌 영역 안 sysmod 자체 안 forceNew 재시도.
        if let Some(token_cache) = parsed.get("tokenCache").and_then(|v| v.as_object()) {
            if let Some(secret_name) = token_cache.get("secretName").and_then(|v| v.as_str()) {
                if let Some(value) = vault.get_secret(&format!("user:{secret_name}")) {
                    env.insert(secret_name.to_string(), value);
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
        let settings_key = firebat_core::vault_keys::vk_module_settings(&module_name);
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

    /// Python 패키지 1건 install — 항상 background spawn + StatusManager job 등록.
    ///
    /// `upgrade=true` 시 `pip install --upgrade` (이미 설치된 최신 버전으로 갱신).
    /// 같은 job id (`install-{display_name}`) Queued/Running 시 중복 spawn skip.
    /// StatusManager 미주입 시 no-op (운영 환경은 항상 주입).
    /// 반환값: spawn 한 job_id (skip 시 None).
    async fn install_python_package(
        &self,
        pkg: &PackageSpec,
        pip: &str,
        python_modules: &Path,
        upgrade: bool,
        module_dir: &Path,
    ) -> Option<String> {
        let Some(status) = self.status.clone() else {
            return None;
        };
        let target_arg = python_modules.to_string_lossy().to_string();
        let display_name = pkg.display_name().to_string();
        let pkg_name = pkg.name.clone();
        let upgrade_flag = if upgrade { " --upgrade" } else { "" };
        // upgrade 시점에는 version specifier 제거 — `yfinance==0.2.51` 그대로 두면 pip 가
        // 명시 버전 0.2.51 다시 설치 + `--upgrade` 플래그 무용. display_name (specifier 제거된
        // 순수 패키지명) 사용해야 pip 가 PyPI 최신 가져옴. 첫 install 은 사용자가 명시한 버전
        // 고정 (config.json 의 의도 존중).
        let install_target = if upgrade { display_name.clone() } else { pkg_name.clone() };
        let install_cmd = format!(
            "{pip} install --target \"{target_arg}\"{upgrade_flag} {install_target} --quiet"
        );

        let job_id = format!("install-{display_name}");

        if let Some(existing) = status.get(&job_id) {
            use firebat_core::managers::status::JobStatusKind;
            if matches!(existing.status, JobStatusKind::Queued | JobStatusKind::Running) {
                return Some(job_id);
            }
        }

        let post_install = pkg.post_install.clone();
        let meta = serde_json::json!({ "package": display_name });
        let start_msg = firebat_core::i18n::t(
            "core.install.in_progress",
            None,
            &[("package", &display_name), ("estimatedSec", "0")],
        );
        status.start(
            Some(job_id.clone()),
            "install".to_string(),
            Some(start_msg),
            None,
            meta,
        );

        let status_bg = status.clone();
        let display_for_bg = display_name.clone();
        let job_id_bg = job_id.clone();
        let python_modules_bg = python_modules.to_path_buf();
        let module_dir_bg = module_dir.to_path_buf();
        let pkg_name_bg = pkg.name.clone();
        let upgrade_bg = upgrade;
        tokio::spawn(async move {
            let install_status = Command::new(if cfg!(target_os = "windows") { "cmd" } else { "sh" })
                .arg(if cfg!(target_os = "windows") { "/C" } else { "-c" })
                .arg(&install_cmd)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .await;
            let install_ok = install_status
                .as_ref()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !install_ok {
                let err = match install_status {
                    Ok(o) => String::from_utf8_lossy(&o.stderr).to_string(),
                    Err(e) => e.to_string(),
                };
                let msg = firebat_core::i18n::t(
                    "core.install.failed",
                    None,
                    &[("package", &display_for_bg), ("error", &err)],
                );
                status_bg.fail(&job_id_bg, msg);
                return;
            }
            if let Some(post) = &post_install {
                let post_status = Command::new(if cfg!(target_os = "windows") { "cmd" } else { "sh" })
                    .arg(if cfg!(target_os = "windows") { "/C" } else { "-c" })
                    .arg(post)
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .output()
                    .await;
                let post_ok = post_status
                    .as_ref()
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if !post_ok {
                    let err = match post_status {
                        Ok(o) => String::from_utf8_lossy(&o.stderr).to_string(),
                        Err(e) => e.to_string(),
                    };
                    let msg = firebat_core::i18n::t(
                        "core.install.failed",
                        None,
                        &[("package", &display_for_bg), ("error", &err)],
                    );
                    status_bg.fail(&job_id_bg, msg);
                    return;
                }
            }
            // upgrade=true 박힌 영역 안 install 끝난 후 config.json 자동 갱신 — 새 디스크 버전
            // 추출 + `packages` 배열 안 매칭 spec 의 명시 버전 정정. 다음 install 시점 옛 버전
            // 다시 박히지 않도록.
            if upgrade_bg {
                if let Err(e) = Self::update_manifest_version(
                    &module_dir_bg,
                    &python_modules_bg,
                    &pkg_name_bg,
                    &display_for_bg,
                ) {
                    tracing::warn!(
                        target: "sandbox",
                        package = %display_for_bg,
                        error = %e,
                        "[install] config.json 자동 갱신 실패 — install 자체는 성공"
                    );
                }
            }
            let done_msg = firebat_core::i18n::t(
                "core.install.completed",
                None,
                &[("package", &display_for_bg)],
            );
            status_bg.complete(
                &job_id_bg,
                Some(serde_json::json!({ "package": display_for_bg, "message": done_msg })),
            );
        });

        Some(job_id)
    }

    /// config.json `packages` 배열 안 매칭 spec 의 `==` 명시 버전 갱신.
    /// upgrade 박힌 후 디스크 안 새 버전 추출 + manifest 정정 → 다음 install 시점 새 버전 그대로.
    /// pkg_name = config.json 원본 spec (`requests==2.32.3`) / display = 추출된 패키지명 (`requests`).
    fn update_manifest_version(
        module_dir: &Path,
        python_modules: &Path,
        pkg_name: &str,
        pkg_display: &str,
    ) -> Result<(), String> {
        // 디스크 안 새 버전 추출 (dist-info scan).
        let probe = PackageSpec {
            name: pkg_display.to_string(),
            post_install: None,
        };
        let (_, new_version) = Self::installed_info(python_modules, &probe);
        let Some(new_ver) = new_version else {
            return Err("새 버전 추출 실패 (dist-info 0)".to_string());
        };

        // config.json 안 packages 배열 안 매칭 spec 정정.
        let manifest_path = module_dir.join("config.json");
        let raw = std::fs::read_to_string(&manifest_path)
            .map_err(|e| format!("config.json 읽기: {e}"))?;
        let mut parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("config.json 파싱: {e}"))?;
        let Some(packages) = parsed.get_mut("packages").and_then(|v| v.as_array_mut()) else {
            return Err("packages 배열 0".to_string());
        };
        let new_spec = format!("{}=={}", pkg_display, new_ver);
        let mut updated = false;
        for entry in packages.iter_mut() {
            match entry {
                serde_json::Value::String(s) if s == pkg_name => {
                    *entry = serde_json::Value::String(new_spec.clone());
                    updated = true;
                }
                serde_json::Value::Object(obj) => {
                    if let Some(serde_json::Value::String(n)) = obj.get("name") {
                        if n == pkg_name {
                            obj.insert("name".to_string(), serde_json::Value::String(new_spec.clone()));
                            updated = true;
                        }
                    }
                }
                _ => {}
            }
        }
        if !updated {
            return Err(format!("packages 안 '{pkg_name}' 매칭 0"));
        }
        // pretty + 2-space indent — 옛 config.json 영역 일관성 유지.
        let serialized = serde_json::to_string_pretty(&parsed)
            .map_err(|e| format!("config.json 직렬화: {e}"))?;
        std::fs::write(&manifest_path, serialized)
            .map_err(|e| format!("config.json 쓰기: {e}"))?;
        tracing::info!(
            target: "sandbox",
            package = %pkg_display,
            new_version = %new_ver,
            "[install] config.json 안 명시 버전 자동 갱신"
        );
        Ok(())
    }

    /// config.json `packages` 배열 파싱 — 매 호출자가 공유. 잘못된 형태 / 누락 시 빈 Vec.
    fn read_packages_from_manifest(module_dir: &Path) -> Vec<PackageSpec> {
        let manifest_path = module_dir.join("config.json");
        let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
            return Vec::new();
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return Vec::new();
        };
        let Some(packages_raw) = parsed.get("packages").and_then(|v| v.as_array()) else {
            return Vec::new();
        };
        packages_raw
            .iter()
            .filter_map(PackageSpec::from_json)
            .collect()
    }

    /// 매 패키지 background spawn — 사용자 명시 trigger (설정 화면 [설치] 버튼) 박은 path.
    /// `upgrade=false` 시 첫 install / `upgrade=true` 시 `pip install --upgrade`.
    /// 반환값: spawn 한 job_id 목록 (이미 설치 / 진행 중 인 패키지는 제외).
    pub(crate) async fn install_packages_for_module(
        &self,
        module_dir: &Path,
        upgrade: bool,
    ) -> Vec<String> {
        let packages = Self::read_packages_from_manifest(module_dir);
        if packages.is_empty() {
            return Vec::new();
        }
        let Some(py) = get_working_python().await else {
            return Vec::new();
        };
        let pip = resolve_pip_command(py).await;
        let python_modules = self.workspace_root.join("python_modules");
        let _ = std::fs::create_dir_all(&python_modules);

        let mut job_ids = Vec::new();
        for pkg in &packages {
            if !upgrade && Self::is_package_installed(&python_modules, pkg) {
                continue;
            }
            if let Some(job_id) = self
                .install_python_package(pkg, &pip, &python_modules, upgrade, module_dir)
                .await
            {
                job_ids.push(job_id);
            }
        }
        job_ids
    }

    /// 패키지 설치 여부 — `python_modules/{import_name}` 디렉토리 또는 `{import_name}.py` 존재 검사.
    /// import_name 은 패키지명에서 소문자 변환 + 하이픈 → 언더스코어 (pip 일반 패턴).
    /// 빠른 1차 판정 — 정확도 100% 보장은 아님 (가짜 진단 가능) 이지만 운영 충분.
    /// 설치 여부 + 설치 버전 (dist-info 안 추출). 버전 추출 실패 시 = `Some((true, None))`.
    fn installed_info(python_modules: &Path, pkg: &PackageSpec) -> (bool, Option<String>) {
        let display = pkg.display_name();
        let import_name = display.to_lowercase().replace('-', "_");
        let mut candidates = vec![import_name.clone()];
        for (import, pip_pkg) in py_import_to_pkg() {
            if pip_pkg.eq_ignore_ascii_case(display) {
                candidates.push(import.to_string());
            }
        }
        // dist-info 안 버전 추출 우선 (정확). 디렉토리 / .py 파일 fallback.
        // pip --target --upgrade 가 옛 dist-info 자동 cleanup 안 함 (pip 알려진 동작) — 옛/새
        // 두 dist-info 가 같이 있을 수 있어, 매칭 중 가장 새 버전 선택.
        // 또한 prefix 가 광범위 (예: "requests-" → "requests-oauthlib-*" 도 매칭) 피하기 위해
        // 다음 segment 가 숫자로 시작하는 경우만 진짜 version (예: "requests-2.34.2"). 다른 패키지
        // (requests-oauthlib 등) 는 다음 segment 가 알파벳이라 제외.
        if let Ok(entries) = std::fs::read_dir(python_modules) {
            let entries: Vec<_> = entries.flatten().collect();
            for name in &candidates {
                let prefix = format!("{}-", name.replace('-', "_"));
                let prefix_dash = format!("{}-", name);
                let mut versions: Vec<String> = Vec::new();
                for entry in &entries {
                    let n = entry.file_name();
                    let Some(s) = n.to_str() else { continue };
                    if !s.ends_with(".dist-info") {
                        continue;
                    }
                    let stem = &s[..s.len() - ".dist-info".len()];
                    let lc = stem.to_lowercase();
                    let matched_prefix = if lc.starts_with(&prefix.to_lowercase()) {
                        Some(prefix.len())
                    } else if lc.starts_with(&prefix_dash.to_lowercase()) {
                        Some(prefix_dash.len())
                    } else {
                        None
                    };
                    if let Some(plen) = matched_prefix {
                        let rest = &stem[plen..];
                        if rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                            versions.push(rest.to_string());
                        }
                    }
                }
                if !versions.is_empty() {
                    versions.sort_by(|a, b| {
                        if is_version_newer(b, a) {
                            std::cmp::Ordering::Greater
                        } else if is_version_newer(a, b) {
                            std::cmp::Ordering::Less
                        } else {
                            std::cmp::Ordering::Equal
                        }
                    });
                    return (true, Some(versions[0].clone()));
                }
            }
        }
        // dist-info 0 박은 영역 fallback — 디렉토리 / py 파일 존재 시 설치 박힌 영역 (버전 0).
        for name in &candidates {
            if python_modules.join(name).is_dir() {
                return (true, None);
            }
            if python_modules.join(format!("{name}.py")).is_file() {
                return (true, None);
            }
        }
        (false, None)
    }

    fn is_package_installed(python_modules: &Path, pkg: &PackageSpec) -> bool {
        Self::installed_info(python_modules, pkg).0
    }

    /// 매 패키지 status 조회 — 설정 화면이 polling.
    /// 우선순위: in_progress (StatusManager Queued/Running) > failed (Failed) > installed (디스크) > missing.
    pub(crate) async fn get_package_status_for_module(
        &self,
        module_dir: &Path,
    ) -> Vec<PackageStatus> {
        let packages = Self::read_packages_from_manifest(module_dir);
        if packages.is_empty() {
            return Vec::new();
        }
        let python_modules = self.workspace_root.join("python_modules");
        let mut result = Vec::with_capacity(packages.len());
        for pkg in &packages {
            let display = pkg.display_name().to_string();
            let job_id = format!("install-{display}");
            let required_version = pkg.required_version();
            let (installed_disk, installed_version) =
                Self::installed_info(&python_modules, pkg);
            let (kind, error) = if let Some(status) = &self.status {
                use firebat_core::managers::status::JobStatusKind;
                if let Some(job) = status.get(&job_id) {
                    match job.status {
                        JobStatusKind::Queued | JobStatusKind::Running => {
                            (PackageStatusKind::InProgress, None)
                        }
                        JobStatusKind::Error => (
                            PackageStatusKind::Failed,
                            job.error
                                .clone()
                                .or_else(|| job.message.clone())
                                .or_else(|| Some("install 실패".into())),
                        ),
                        JobStatusKind::Done | JobStatusKind::Cancelled => {
                            if installed_disk {
                                (PackageStatusKind::Installed, None)
                            } else {
                                (PackageStatusKind::Missing, None)
                            }
                        }
                    }
                } else if installed_disk {
                    (PackageStatusKind::Installed, None)
                } else {
                    (PackageStatusKind::Missing, None)
                }
            } else if installed_disk {
                (PackageStatusKind::Installed, None)
            } else {
                (PackageStatusKind::Missing, None)
            };
            // 설치 박힌 패키지만 PyPI 체크 (미설치 = 업그레이드 의미 0). 1시간 캐시 박혀
            // 매 polling 시 network 호출 부담 차단.
            let latest_version = if matches!(kind, PackageStatusKind::Installed) {
                fetch_latest_pypi_version(&display).await
            } else {
                None
            };
            // upgrade_available = PyPI latest > config 명시 버전. specifier `==` 외 박힌 영역
            // (required_version = None) = 비교 불가 → false (보수적).
            let upgrade_available = matches!(
                (&latest_version, &required_version),
                (Some(l), Some(r)) if is_version_newer(l, r)
            );
            result.push(PackageStatus {
                name: display,
                status: kind,
                job_id: Some(job_id),
                error,
                installed_version,
                required_version,
                latest_version,
                upgrade_available,
            });
        }
        result
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

    /// stdout / stderr 안에서 누락 패키지명 추출 — Python ModuleNotFoundError / Node Cannot find module.
    /// 발견되면 i18n 친절 메시지 + `core.module.packages_missing` errorKey 로 변환.
    /// 사용자는 채팅 에러 뱃지를 확인 후 설정 화면에서 [설치] 버튼으로 명시 install.
    fn detect_missing_package(err_msg: &str) -> Option<String> {
        if let Ok(re) = regex::Regex::new(r"No module named '?([^'\s]+)'?") {
            if let Some(caps) = re.captures(err_msg) {
                if let Some(m) = caps.get(1) {
                    let import = m.as_str().split('.').next().unwrap_or("");
                    if !import.is_empty() {
                        let pip_pkg = py_import_to_pkg()
                            .get(import)
                            .copied()
                            .unwrap_or(import)
                            .to_string();
                        return Some(pip_pkg);
                    }
                }
            }
        }
        if let Ok(re) = regex::Regex::new(r#"Cannot find module '?([^'\s"]+)'?"#) {
            if let Some(caps) = re.captures(err_msg) {
                if let Some(m) = caps.get(1) {
                    let pkg = m.as_str();
                    if !pkg.starts_with('.') && !pkg.starts_with('/') {
                        return Some(pkg.to_string());
                    }
                }
            }
        }
        None
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
        // path entry 자동 탐색 — AI 가 path 박을 때 entry 확장자 (.mjs / .py 등) 추측해서 틀린 경우
        // (예: yfinance 가 main.py 인데 AI 가 index.mjs 박음) 디렉토리 안 실재하는 entry 자동 선택.
        // ModuleManager.Run 의 ENTRY_FILES 자동 탐색과 동일 fallback — Pipeline EXECUTE / 다른 호출
        // site 일반화. 옛 동작 호환 — full_path 실재하면 그대로 사용.
        let resolved_path = {
            let initial = self.workspace_root.join(target_path);
            if initial.exists() {
                target_path.to_string()
            } else {
                let dir_part = std::path::Path::new(target_path)
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                if dir_part.is_empty() {
                    target_path.to_string()
                } else {
                    const ENTRY_FILES: &[&str] =
                        &["main.py", "index.mjs", "index.js", "main.mjs", "main.sh", "main.php"];
                    let dir_full = self.workspace_root.join(&dir_part);
                    ENTRY_FILES
                        .iter()
                        .find(|f| dir_full.join(f).exists())
                        .map(|f| format!("{}/{}", dir_part, f))
                        .unwrap_or_else(|| target_path.to_string())
                }
            }
        };
        let full_path = self.workspace_root.join(&resolved_path);
        if !full_path.exists() {
            return Err(format!("모듈 entry 없음: {}", target_path));
        }
        let runtime = self
            .resolve_runtime(&resolved_path)
            .ok_or_else(|| format!("지원되지 않는 모듈 확장자: {}", resolved_path))?
            .clone();

        // 런타임 binary 미설치 → 친절한 에러 (옛 TS runtimeError 1:1)
        if !is_available(&runtime.command).await {
            return Err(Self::runtime_missing_error(&runtime.command));
        }

        let module_dir = full_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.workspace_root.clone());

        // 단일 시도 — silent install path 폐기 (사용자 결정 2026-05-16).
        // 패키지 누락 시 채팅 에러 뱃지 + 설정 화면 [설치] 버튼으로 명시 install.
        let result = self
            .run_once(&full_path, &runtime, &module_dir, input_data, opts)
            .await?;

        // 패키지 누락 감지 → `core.module.packages_missing` envelope errorKey
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
        if let Some(missing) = Self::detect_missing_package(&err_msg) {
            let module_name = module_dir
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let mut enriched = result;
            enriched.success = false;
            enriched.error_key = Some("core.error.module.packages_missing".to_string());
            enriched.error_params = Some(serde_json::json!({
                "module": module_name,
                "package": missing,
            }));
            enriched.error = Some(firebat_core::i18n::t(
                "core.error.module.packages_missing",
                None,
                &[("module", &module_name), ("package", &missing)],
            ));
            return Ok(enriched);
        }
        Ok(result)
    }

    fn capabilities(&self) -> firebat_core::ports::SandboxCapabilities {
        // BasicProcessSandbox — path containment + timeout 만. OS 레벨 격리 0.
        // Phase C 진입 시 Linux 환경에서 LinuxCgroupsSandbox 로 swap.
        firebat_core::ports::SandboxCapabilities {
            kind: "basic-process".to_string(),
            fs_readonly: false,
            network_deny: false,
            cpu_limit_ms: 0,
            memory_limit_mb: 0,
            seccomp_filter: false,
            warning: Some(
                "BasicProcessSandbox — OS 레벨 격리 0. Phase C 진입 시 LinuxCgroupsSandbox 로 swap."
                    .to_string(),
            ),
        }
    }

    async fn install_packages(
        &self,
        module_dir: &str,
        upgrade: bool,
    ) -> InfraResult<Vec<String>> {
        // workspace_root 안 path containment
        if module_dir.contains("..") || module_dir.starts_with('/') {
            return Err(format!("workspace zone 밖 path 거부: {}", module_dir));
        }
        let abs = self.workspace_root.join(module_dir);
        Ok(self.install_packages_for_module(&abs, upgrade).await)
    }

    async fn get_package_status(
        &self,
        module_dir: &str,
    ) -> InfraResult<Vec<PackageStatus>> {
        if module_dir.contains("..") || module_dir.starts_with('/') {
            return Err(format!("workspace zone 밖 path 거부: {}", module_dir));
        }
        let abs = self.workspace_root.join(module_dir);
        Ok(self.get_package_status_for_module(&abs).await)
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

        // workspace 격리 Python deps — pre_install_from_manifest 가 박은 `--target /opt/firebat/python_modules`
        // 경로를 PYTHONPATH 로 자동 주입. 매 python sysmod 가 import 시점에 그 경로 lookup.
        let python_modules = self.workspace_root.join("python_modules");
        if python_modules.is_dir() {
            let existing = std::env::var("PYTHONPATH").unwrap_or_default();
            let new_path = if existing.is_empty() {
                python_modules.to_string_lossy().to_string()
            } else {
                let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
                format!("{}{}{}", python_modules.to_string_lossy(), sep, existing)
            };
            cmd.env("PYTHONPATH", new_path);
        }

        // Heavy 패키지 의 binary cache workspace 격리 — playwright 가 `python -m playwright install
        // chromium` 시 다운로드하는 browser binary (~300MB) 의 cache 경로 통일. 시스템 전역
        // (~/.cache/ms-playwright) 잔존 0 — workspace 폴더 삭제 = 모든 binary 삭제.
        // 매 heavy 패키지 추가 시 동일 패턴 (예: HuggingFace HF_HOME / TRANSFORMERS_CACHE) 박음.
        let pw_browsers = self.workspace_root.join("playwright_browsers");
        let _ = std::fs::create_dir_all(&pw_browsers);
        cmd.env("PLAYWRIGHT_BROWSERS_PATH", pw_browsers.to_string_lossy().to_string());

        // Vault secrets 자동 주입 (옛 TS loadSecretsEnv 1:1)
        for (k, v) in self.load_secrets_env(module_dir) {
            cmd.env(k, v);
        }
        // 명시 env 가 secrets 위에 (사용자 명시 우선)
        for (k, v) in opts.env.iter() {
            cmd.env(k, v);
        }

        // Pre-exec hook (Linux 한정) — fork() 직후 exec() 직전 자식 프로세스 안에서 실행.
        // LinuxCgroupsSandboxAdapter 가 저장 — cgroup attach + seccomp install + unshare.
        // hook 안에서 panic 또는 Err 반환 시 자식 프로세스 즉시 종료 (안전).
        #[cfg(target_os = "linux")]
        if let Some(hook) = &self.pre_exec_hook {
            use std::os::unix::process::CommandExt;
            let hook_clone = hook.clone();
            // SAFETY: pre_exec 가 fork() 와 exec() 사이에서 호출 — async-signal-safe operations 만 허용.
            // hook 안에서 std::fs::write / sys-call wrapper (nix / seccompiler) 사용 — 모두 OK.
            unsafe {
                cmd.as_std_mut().pre_exec(move || hook_clone());
            }
        }

        // 진단 — sysmod 호출 시작. input 의 action / 주요 key 만 박음 (sensitive value 안 노출).
        // 사용자가 journalctl 박은 영역 안 어떤 sysmod 어떤 action 호출했는지 즉시 명시.
        let module_name = module_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?");
        let input_action = input_data
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let input_keys: Vec<&str> = input_data
            .as_object()
            .map(|o| o.keys().map(|k| k.as_str()).collect())
            .unwrap_or_default();
        tracing::info!(
            target: "sandbox",
            module = module_name,
            action = input_action,
            input_keys = ?input_keys,
            "[sandbox] sysmod 호출 시작"
        );

        let mut child = cmd.spawn().map_err(|e| format!("spawn 실패: {e}"))?;

        if let Some(mut stdin) = child.stdin.take() {
            // 모듈 stdin protocol — `{correlationId, data}` wrap. main.py / index.mjs 가
            // `payload.get('data')` / `const { data } = JSON.parse(raw)` 로 data field
            // 안에서 입력 읽음 (옛 TS sandbox 1:1). wrap 없으면 빈 dict → action='' silent fail.
            let payload = serde_json::json!({
                "correlationId": uuid::Uuid::new_v4().to_string(),
                "data": input_data,
            });
            let json = serde_json::to_string(&payload)
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
        // 진단 — sysmod 응답 결과. exit_code / stdout / stderr size + preview 명시.
        // 정상 종료 (exit 0) 박혀있어도 stderr 박혀있으면 진단 가치 큼 (Python warning / yfinance 라이브러리
        // 안 HTTP 차단 메시지 / pandas FutureWarning / fail 가능성 명시). 옛 흐름 = exit != 0 시점만
        // stderr_preview 박은 영역 → 정상 종료 + 비즈니스 fail 영역 진단 불가.
        // stdout preview 도 박음 — out_err / 빈 records 박혀있으면 짧은 응답 직접 확인 가능.
        let stdout_preview: String = stdout_buf.chars().take(300).collect();
        let stderr_preview: String = stderr_buf.chars().take(300).collect();
        tracing::info!(
            target: "sandbox",
            module = module_name,
            action = input_action,
            exit_code = ?exit_code,
            stdout_size = stdout_buf.len(),
            stderr_size = stderr_buf.len(),
            stdout_preview = %stdout_preview,
            stderr_preview = %stderr_preview,
            "[sandbox] sysmod 호출 종료"
        );
        if !exit_status.success() {
            tracing::warn!(
                target: "sandbox",
                module = module_name,
                action = input_action,
                exit_code = ?exit_code,
                stderr_preview = %stderr_buf.chars().take(300).collect::<String>(),
                "[sandbox] sysmod 비정상 종료"
            );
            // stderr 에 패키지 누락 관련 정보가 있으니 error 에 포함 (try_auto_install 매칭용)
            let combined_err = if !stderr_buf.is_empty() {
                stderr_buf.clone()
            } else {
                format!("exit code: {:?}", exit_code)
            };
            return Ok(ModuleOutput {
                protocol_version: firebat_core::ports::MODULE_PROTOCOL_VERSION.to_string(),
                success: false,
                data: serde_json::Value::Null,
                error: Some(combined_err),
                error_key: None,
                error_params: None,
                stderr: if stderr_buf.is_empty() { None } else { Some(stderr_buf) },
                exit_code,
            });
        }

        let trimmed = stdout_buf.trim();
        let parsed: serde_json::Value = if trimmed.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(trimmed).unwrap_or_else(|_| serde_json::json!({"stdout": trimmed}))
        };

        // sysmod stdout envelope 인식 — `{success, data, error, errorKey?, errorParams?, __updateSecrets?}` 형태면 그대로 unwrap.
        // exit 0 자체는 process 정상 종료만 의미 — sysmod 의 비즈니스 success 와 별개.
        // errorKey / errorParams = i18n 영역 (SysmodToolHandler 의 lookup 변환 입력).
        // __updateSecrets = OAuth token cache save — sysmod 안 새 token 발급 박은 영역 안 vault
        // 업데이트. 한투 / 키움 같은 OAuth sysmod 안 매 호출 마다 발급 호출 박지 X (rate limit 차단).
        let (success, data, error, error_key, error_params) = if let Some(obj) = parsed.as_object() {
            let has_success = obj.contains_key("success");
            let has_envelope_field = has_success
                || obj.contains_key("data")
                || obj.contains_key("error")
                || obj.contains_key("errorKey");
            // __updateSecrets 파싱 + vault 업데이트 (cache save).
            if let Some(updates) = obj.get("__updateSecrets").and_then(|v| v.as_object()) {
                if let Some(vault) = &self.vault {
                    for (key, val) in updates {
                        if let Some(s) = val.as_str() {
                            if !s.is_empty() {
                                vault.set_secret(&format!("user:{key}"), s);
                            }
                        }
                    }
                }
            }
            if has_envelope_field {
                let s = obj.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
                let d = obj.get("data").cloned().unwrap_or(serde_json::Value::Null);
                let e = obj.get("error").and_then(|v| v.as_str()).map(String::from);
                let ek = obj.get("errorKey").and_then(|v| v.as_str()).map(String::from);
                let ep = obj.get("errorParams").cloned();
                (s, d, e, ek, ep)
            } else {
                (true, parsed, None, None, None)
            }
        } else {
            (true, parsed, None, None, None)
        };

        // `_cache` envelope 인식 — sysmod 가 큰 응답 (50행+) 시 data.{_cache: {records, sysmod, action,
        // params, ttlSec}} 박은 영역 자동 SysmodCacheAdapter 저장. AI 가 records 통째 받지 않고 _cacheKey
        // 만 받아 cache_read / cache_grep / cache_aggregate gRPC 도구 호출. 토큰 절약.
        // 미설정 (cache None) 또는 cache.data() fail 시 `_cache` 영역 그대로 통과 (옛 호환).
        let data = if let Some(cache) = &self.cache {
            if let Some(obj) = data.as_object().cloned() {
                let mut obj = obj;
                if let Some(cache_envelope) = obj.remove("_cache") {
                    if let Some(c_obj) = cache_envelope.as_object() {
                        let records_opt = c_obj
                            .get("records")
                            .and_then(|v| v.as_array())
                            .cloned();
                        let sysmod_name = c_obj
                            .get("sysmod")
                            .and_then(|v| v.as_str())
                            .unwrap_or(module_name);
                        let action_name = c_obj
                            .get("action")
                            .and_then(|v| v.as_str())
                            .unwrap_or(input_action);
                        let params = c_obj
                            .get("params")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null);
                        let ttl_sec = c_obj.get("ttlSec").and_then(|v| v.as_i64());
                        if let Some(records) = records_opt {
                            let record_count = records.len();
                            match cache.data(sysmod_name, action_name, params, records, ttl_sec) {
                                Ok(key) => {
                                    obj.insert(
                                        "_cacheKey".to_string(),
                                        serde_json::Value::String(key.clone()),
                                    );
                                    obj.insert(
                                        "_cacheMeta".to_string(),
                                        serde_json::json!({
                                            "sysmod": sysmod_name,
                                            "action": action_name,
                                            "recordCount": record_count,
                                            "ttlSec": ttl_sec,
                                        }),
                                    );
                                    tracing::info!(
                                        target: "sandbox",
                                        module = module_name,
                                        action = input_action,
                                        cache_key = %key,
                                        record_count,
                                        "[sandbox] _cache envelope → SysmodCacheAdapter 저장"
                                    );
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        target: "sandbox",
                                        module = module_name,
                                        action = input_action,
                                        error = %e,
                                        "[sandbox] _cache 저장 실패 — envelope 폐기"
                                    );
                                }
                            }
                        }
                    }
                }
                serde_json::Value::Object(obj)
            } else {
                data
            }
        } else {
            data
        };

        Ok(ModuleOutput {
            protocol_version: firebat_core::ports::MODULE_PROTOCOL_VERSION.to_string(),
            success,
            data,
            error,
            error_key,
            error_params,
            stderr: if stderr_buf.is_empty() { None } else { Some(stderr_buf) },
            exit_code,
        })
    }
}

/// Stub adapter — 실 spawn 안 하고 미리 설정한 응답 반환. 단위 테스트 용.
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

    fn capabilities(&self) -> firebat_core::ports::SandboxCapabilities {
        firebat_core::ports::SandboxCapabilities {
            kind: "stub".to_string(),
            ..Default::default()
        }
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
        // 빈 파일 생성 (path 존재 검사 통과 위해)
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
        // Vault 에 시크릿 미리 저장
        vault.set_secret("user:KIWOOM_APP_KEY", "test-app-key");
        vault.set_secret("user:KIWOOM_APP_SECRET", "test-app-secret");
        vault.set_secret("user:UNRELATED_KEY", "skip-me");

        // 모듈 디렉토리 + config.json 저장
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
        // secrets 배열에 설정된 키만 주입
        assert_eq!(env.get("KIWOOM_APP_KEY").map(|s| s.as_str()), Some("test-app-key"));
        assert_eq!(
            env.get("KIWOOM_APP_SECRET").map(|s| s.as_str()),
            Some("test-app-secret")
        );
        // secrets 배열에 미설정한 키는 주입 안 됨
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

        // Vault 미설정 → empty env (회귀 안전)
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
        // 모듈 settings 주입 (옛 TS MODULE_<KEY> env 패턴 1:1)
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

    #[test]
    fn package_spec_parses_string_entry() {
        let v = serde_json::json!("yfinance==0.2.51");
        let spec = PackageSpec::from_json(&v).unwrap();
        assert_eq!(spec.name, "yfinance==0.2.51");
        assert!(spec.post_install.is_none());
        assert_eq!(spec.display_name(), "yfinance");
    }

    #[test]
    fn package_spec_parses_object_entry() {
        let v = serde_json::json!({
            "name": "playwright==1.59.1",
            "postInstall": "python -m playwright install chromium"
        });
        let spec = PackageSpec::from_json(&v).unwrap();
        assert_eq!(spec.name, "playwright==1.59.1");
        assert_eq!(
            spec.post_install.as_deref(),
            Some("python -m playwright install chromium")
        );
        assert_eq!(spec.display_name(), "playwright");
    }

    #[test]
    fn package_spec_legacy_heavy_field_ignored() {
        // 옛 config.json `heavy: true` + `estimatedSec` 필드 호환 — read 시 무시.
        let v = serde_json::json!({
            "name": "playwright==1.59.1",
            "heavy": true,
            "estimatedSec": 600,
            "postInstall": "python -m playwright install chromium"
        });
        let spec = PackageSpec::from_json(&v).unwrap();
        assert_eq!(spec.name, "playwright==1.59.1");
        assert_eq!(
            spec.post_install.as_deref(),
            Some("python -m playwright install chromium")
        );
    }

    #[test]
    fn package_spec_object_missing_name_returns_none() {
        let v = serde_json::json!({"postInstall": "echo hi"});
        assert!(PackageSpec::from_json(&v).is_none());
    }

    #[test]
    fn detect_missing_package_python_no_module_with_quote() {
        let pkg = ProcessSandboxAdapter::detect_missing_package(
            "ModuleNotFoundError: No module named 'yfinance'",
        );
        assert_eq!(pkg.as_deref(), Some("yfinance"));
    }

    #[test]
    fn detect_missing_package_python_with_dot_subpath() {
        // `No module named 'google.cloud'` → top-level google → pip pkg = google-generativeai
        let pkg = ProcessSandboxAdapter::detect_missing_package(
            "ModuleNotFoundError: No module named 'google.cloud'",
        );
        assert_eq!(pkg.as_deref(), Some("google-generativeai"));
    }

    #[test]
    fn detect_missing_package_python_pil_reverse_mapping() {
        let pkg =
            ProcessSandboxAdapter::detect_missing_package("No module named 'PIL'");
        assert_eq!(pkg.as_deref(), Some("Pillow"));
    }

    #[test]
    fn detect_missing_package_node_cannot_find_module() {
        let pkg = ProcessSandboxAdapter::detect_missing_package(
            "Error: Cannot find module 'playwright'",
        );
        assert_eq!(pkg.as_deref(), Some("playwright"));
    }

    #[test]
    fn detect_missing_package_node_relative_path_ignored() {
        // 상대 경로 import 는 패키지 누락 X — None
        let pkg = ProcessSandboxAdapter::detect_missing_package(
            "Error: Cannot find module './local-file'",
        );
        assert_eq!(pkg, None);
    }

    #[test]
    fn detect_missing_package_unrelated_message_returns_none() {
        let pkg = ProcessSandboxAdapter::detect_missing_package("ValueError: bad input");
        assert_eq!(pkg, None);
    }

    #[test]
    fn is_package_installed_detects_dist_info() {
        let dir = tempdir().unwrap();
        let python_modules = dir.path();
        // pip 의 dist-info 디렉토리 — playwright-1.59.1.dist-info
        let dist = python_modules.join("playwright-1.59.1.dist-info");
        std::fs::create_dir_all(&dist).unwrap();
        let spec = PackageSpec {
            name: "playwright==1.59.1".to_string(),
            post_install: None,
        };
        assert!(ProcessSandboxAdapter::is_package_installed(python_modules, &spec));
    }

    #[test]
    fn is_package_installed_returns_false_for_missing() {
        let dir = tempdir().unwrap();
        let spec = PackageSpec {
            name: "nonexistent".to_string(),
            post_install: None,
        };
        assert!(!ProcessSandboxAdapter::is_package_installed(dir.path(), &spec));
    }
}

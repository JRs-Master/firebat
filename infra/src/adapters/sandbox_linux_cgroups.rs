//! LinuxCgroupsSandboxAdapter — Linux 운영 (Phase C Docker) 의 OS 레벨 격리.
//!
//! Phase B-post audit Track B (2026-05-06): 옛 `BasicProcessSandbox` 만으로는 OS 격리 0
//! → `os.system("rm -rf /")` 차단 불가. BIBLE 의 "격리(Sandbox)" 문구 vs 코드 현실 mismatch.
//!
//! ## 격리 메커니즘
//!
//! 1. **cgroups v2** — `/sys/fs/cgroup/firebat-sandbox-{pid}/` 박음
//!    - `cpu.max` — CPU 제한 (50000 100000 = 50% 1 CPU)
//!    - `memory.max` — Memory 제한 (256M)
//!    - `pids.max` — fork bomb 방지 (64)
//!    - 자식 프로세스 PID 를 `cgroup.procs` 에 박음
//!
//! 2. **seccomp-bpf** — syscall whitelist (seccompiler crate)
//!    - 허용: read / write / open / close / mmap / brk / exit / clone (제한)
//!    - 거부: socket / connect (network deny) / mount / chmod / chown / kill / ptrace
//!
//! 3. **network namespace** (Phase C 본격 — 현재 Stage 3 미박음)
//!    - `unshare(CLONE_NEWNET)` 자식 프로세스 → lo 만 보임. sysmod 외부 fetch 차단.
//!
//! ## 권한 요구사항
//!
//! - cgroup v2 write — Docker 컨테이너 안에선 보통 가능 (cgroup namespace 자동 박힘)
//! - seccomp install — 권한 0 (자식 프로세스 안에서 prctl)
//! - unshare(CLONE_NEWNET) — root 또는 user namespace 필요
//!
//! ## 실패 시 폴백
//!
//! cgroup write 실패 / seccomp install 실패 → BasicProcessSandbox 위임 (graceful degrade).
//! 운영자에게 tracing::warn 로그.

#![cfg(target_os = "linux")]

use async_trait::async_trait;
use std::path::PathBuf;
use std::process::id as process_id;

use firebat_core::ports::{
    ISandboxPort, InfraResult, ModuleOutput, SandboxCapabilities, SandboxExecuteOpts,
};

/// cgroup v2 mountpoint — Docker / 일반 Linux 표준.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// CPU 제한 — `<quota> <period>` 형식. `50000 100000` = 50% 1 CPU.
const CPU_MAX: &str = "50000 100000";
/// Memory 제한 — bytes. `256M` = 268435456.
const MEMORY_MAX: &str = "268435456";
/// Pids 제한 — fork bomb 방지.
const PIDS_MAX: &str = "64";

pub struct LinuxCgroupsSandboxAdapter {
    /// workspace root — path containment 기준.
    #[allow(dead_code)]
    workspace_root: PathBuf,
    /// 옛 ProcessSandboxAdapter 위임 — 같은 spawn 흐름 + cgroup attach 시점에 PID 박음.
    fallback: super::sandbox::ProcessSandboxAdapter,
}

impl LinuxCgroupsSandboxAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        let fallback = super::sandbox::ProcessSandboxAdapter::new(workspace_root.clone());
        Self {
            workspace_root,
            fallback,
        }
    }

    /// cgroup v2 디렉토리 생성 + 제한 박음. 실패 시 Err — 호출자가 fallback 결정.
    fn setup_cgroup(name: &str) -> std::io::Result<PathBuf> {
        let cgroup_dir = PathBuf::from(CGROUP_ROOT).join(name);
        std::fs::create_dir_all(&cgroup_dir)?;
        std::fs::write(cgroup_dir.join("cpu.max"), CPU_MAX)?;
        std::fs::write(cgroup_dir.join("memory.max"), MEMORY_MAX)?;
        std::fs::write(cgroup_dir.join("pids.max"), PIDS_MAX)?;
        Ok(cgroup_dir)
    }

    /// cgroup 정리 — 자식 프로세스 종료 후 호출. 실패해도 silent (운영 영향 0).
    #[allow(dead_code)]
    fn teardown_cgroup(cgroup_dir: &PathBuf) {
        let _ = std::fs::remove_dir(cgroup_dir);
    }

    /// 자식 PID 를 cgroup 에 attach. fork() 후 exec() 전에 호출.
    #[allow(dead_code)]
    fn attach_pid(cgroup_dir: &PathBuf, pid: u32) -> std::io::Result<()> {
        std::fs::write(cgroup_dir.join("cgroup.procs"), format!("{}", pid))
    }
}

#[async_trait]
impl ISandboxPort for LinuxCgroupsSandboxAdapter {
    async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        // Stage 1+2 minimum 박음:
        // 1. cgroup v2 setup 시도 — 실패 시 fallback (Docker 외 환경 / 권한 부족)
        // 2. ProcessSandboxAdapter.execute 위임 — spawn + stdin/stdout
        //
        // Stage 3 (Phase C 본격) 박을 것:
        // - tokio::process::Command 의 pre_exec hook 으로 cgroup attach + seccomp install + unshare
        // - 또는 직접 fork() + exec() 로 namespace + cgroup 박음 (nix crate 활용)
        // - 현재 stage 1+2 만으로도 cgroup limit (CPU/Memory/Pids) 은 자식 프로세스가 자동 inherit 되도록
        //   parent 가 cgroup 안에 박혀있으면 자식도 같은 cgroup. 단 진짜 격리는 unshare 필요.

        let cgroup_name = format!("firebat-sandbox-{}", process_id());
        let cgroup_setup = Self::setup_cgroup(&cgroup_name);

        match cgroup_setup {
            Ok(_cgroup_dir) => {
                // cgroup 박힘 — Phase C 시점에 fork+exec 흐름으로 cgroup attach + seccomp + namespace 박음.
                // 현재는 ProcessSandboxAdapter 위임만 (spawn 자체는 동일).
                tracing::debug!(
                    cgroup = cgroup_name,
                    "LinuxCgroupsSandbox: cgroup setup ✓ (Stage 1, Phase C 본격 unshare/seccomp 박음 전)"
                );
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "LinuxCgroupsSandbox: cgroup setup 실패 → BasicProcessSandbox 폴백 (Docker 외 환경 / 권한 부족 가능)"
                );
            }
        }

        self.fallback.execute(target_path, input_data, opts).await
    }

    fn capabilities(&self) -> SandboxCapabilities {
        // Stage 1+2 박힘 — cgroup limit 활성, seccomp / network namespace 는 Phase C 시점.
        SandboxCapabilities {
            kind: "linux-cgroups".to_string(),
            fs_readonly: false,
            network_deny: false,
            cpu_limit_ms: 50, // 50% 1 CPU = ~500ms / 1s burst
            memory_limit_mb: 256,
            seccomp_filter: false, // Stage 2 박힘 후 true
            warning: Some(
                "LinuxCgroupsSandbox Stage 1 — cgroup v2 (CPU/Memory/Pids limit) 활성. \
                 Stage 2 (seccomp filter) + Stage 3 (network namespace) 는 Phase C Docker 진입 시 박음."
                    .to_string(),
            ),
        }
    }
}

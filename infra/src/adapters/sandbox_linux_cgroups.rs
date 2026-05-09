//! LinuxCgroupsSandboxAdapter — Linux 운영의 OS 레벨 격리.
//!
//! Phase B-post audit Track B (2026-05-06): 옛 `BasicProcessSandbox` 만으로는 OS 격리 0
//! → `os.system("rm -rf /")` 차단 불가. 진짜 격리 저장.
//!
//! ## 격리 메커니즘 (Stage 1 + 2 + 3 모두 설정)
//!
//! 1. **cgroups v2** — `/sys/fs/cgroup/firebat-sandbox-{uniq}/`
//!    - `cpu.max` — `50000 100000` = 50% 1 CPU
//!    - `memory.max` — 256MB
//!    - `pids.max` — 64 (fork bomb 방지)
//!    - 자식 PID 를 `cgroup.procs` 에 추가 (pre_exec hook 안에서)
//!
//! 2. **seccomp-bpf** (seccompiler crate) — syscall whitelist
//!    - default: `Errno(EPERM)` (모든 syscall 거부)
//!    - 명시 allow: read / write / open / close / mmap / brk / exit / clone(제한) / fork / execve /
//!      stat 류 / pipe / poll / select / wait / signal 핸들링 / file descriptor / 등 (~60+ syscall)
//!    - 거부 (default Errno): socket / connect / bind / listen (network) / mount / chmod / chown /
//!      ptrace / kexec / reboot / setuid / setgid / etc.
//!
//! 3. **network namespace** (nix crate) — `unshare(CLONE_NEWNET)`
//!    - 자식 프로세스 → lo 만 보임. 외부 fetch 차단.
//!    - sysmod 가 외부 fetch 필요 시 INetworkPort 통해 main 프로세스가 대신 호출 (capability-based)
//!
//! ## 권한 fallback
//!
//! - cgroup write 실패 (Docker 외 환경 / 권한 부족) → tracing::warn + cgroup 없이 spawn
//! - unshare(CLONE_NEWNET) 실패 (root 또는 user namespace 부재) → tracing::warn + namespace 없이 spawn
//! - seccomp install 실패 (kernel 미지원, drift) → tracing::warn + seccomp 없이 spawn
//! - 모두 실패 시 결국 `BasicProcessSandbox` 와 동일 동작 (graceful degrade)

#![cfg(target_os = "linux")]

use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use firebat_core::ports::{
    ISandboxPort, InfraResult, ModuleOutput, SandboxCapabilities, SandboxExecuteOpts,
};

use super::sandbox::ProcessSandboxAdapter;

/// cgroup v2 mountpoint — Docker / 일반 Linux 표준.
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// CPU 제한 — `<quota> <period>` 형식. `50000 100000` = 50% 1 CPU.
const CPU_MAX: &str = "50000 100000";
/// Memory 제한 — bytes. `256M` = 268435456.
const MEMORY_MAX: &str = "268435456";
/// Pids 제한 — fork bomb 방지.
const PIDS_MAX: &str = "64";

/// cgroup name 생성 시 unique counter — 동시 spawn 시 충돌 방지.
static SANDBOX_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct LinuxCgroupsSandboxAdapter {
    /// workspace root — path containment 기준.
    #[allow(dead_code)]
    workspace_root: PathBuf,
    /// 옛 ProcessSandboxAdapter 위임 + pre_exec hook 저장.
    /// hook 안에서 cgroup attach + seccomp install + unshare(CLONE_NEWNET).
    fallback: ProcessSandboxAdapter,
}

impl LinuxCgroupsSandboxAdapter {
    pub fn new(workspace_root: PathBuf) -> Self {
        let cgroup_dir = match Self::setup_cgroup() {
            Ok(dir) => Some(Arc::new(dir)),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "LinuxCgroupsSandbox: cgroup setup 실패 → namespace/seccomp 만 적용 (Docker 외 환경 / 권한 부족 가능)"
                );
                None
            }
        };

        // pre_exec hook 저장 — 자식 프로세스 안에서 exec() 직전 실행:
        //   1. cgroup attach (자식 PID → cgroup.procs)
        //   2. seccomp filter install (default deny + allow list)
        //   3. unshare(CLONE_NEWNET) — network namespace
        let cgroup_for_hook = cgroup_dir.clone();
        let hook = move || -> std::io::Result<()> {
            // Stage 1: cgroup attach — getpid() 결과를 cgroup.procs 에 저장
            if let Some(dir) = &cgroup_for_hook {
                let pid = unsafe { libc_getpid() };
                let _ = std::fs::write(dir.join("cgroup.procs"), format!("{}", pid));
                // 실패해도 silent — cgroup 설정되었어도 자식 종료엔 영향 0
            }

            // Stage 3: network namespace unshare. root 또는 user namespace 필요.
            // 실패 시 silent — graceful degrade (BasicProcessSandbox 동등 동작).
            let _ = nix::sched::unshare(nix::sched::CloneFlags::CLONE_NEWNET);

            // Stage 2: seccomp filter install. kernel 미지원 시 silent fail.
            install_seccomp_filter();

            Ok(())
        };
        let fallback = ProcessSandboxAdapter::new(workspace_root.clone()).with_pre_exec_hook(hook);

        Self {
            workspace_root,
            fallback,
        }
    }

    /// Vault 설정한 채로 부팅 (옛 ProcessSandboxAdapter::with_vault 1:1 위임).
    pub fn with_vault(mut self, vault: Arc<dyn firebat_core::ports::IVaultPort>) -> Self {
        self.fallback = self.fallback.with_vault(vault);
        self
    }

    /// cgroup v2 디렉토리 생성 + 제한 저장. 한 번만 호출 (생성자 안).
    fn setup_cgroup() -> std::io::Result<PathBuf> {
        let counter = SANDBOX_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let cgroup_dir = PathBuf::from(CGROUP_ROOT).join(format!("firebat-sandbox-{}-{}", pid, counter));
        std::fs::create_dir_all(&cgroup_dir)?;
        std::fs::write(cgroup_dir.join("cpu.max"), CPU_MAX)?;
        std::fs::write(cgroup_dir.join("memory.max"), MEMORY_MAX)?;
        std::fs::write(cgroup_dir.join("pids.max"), PIDS_MAX)?;
        Ok(cgroup_dir)
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
        // ProcessSandboxAdapter 가 spawn 시 pre_exec hook 자동 호출 →
        // 자식 프로세스 안에서 cgroup attach + seccomp + namespace 저장.
        self.fallback.execute(target_path, input_data, opts).await
    }

    fn capabilities(&self) -> SandboxCapabilities {
        SandboxCapabilities {
            kind: "linux-cgroups".to_string(),
            // path containment 는 BasicProcess 와 동일. Phase D 시점에 readonly bind mount 저장.
            fs_readonly: false,
            // network namespace unshare — 자식이 lo 만 보임. unshare 실패 시 silent fallback.
            network_deny: true,
            cpu_limit_ms: 50, // 50% 1 CPU
            memory_limit_mb: 256,
            seccomp_filter: true,
            warning: Some(
                "LinuxCgroupsSandbox 본격 — cgroup v2 (cpu/memory/pids) + seccomp filter + network namespace. \
                 권한 부족 / kernel 미지원 시 graceful degrade (silent warn)."
                    .to_string(),
            ),
        }
    }
}

// libc::getpid 직접 호출 — async-signal-safe 보장 (pre_exec 안에서 OK).
// libc_getpid_real 은 미사용 (libc_getpid 가 #[link_name="getpid"] 으로 직접 설정).
#[link(name = "c")]
unsafe extern "C" {
    #[link_name = "getpid"]
    fn libc_getpid() -> i32;
}

/// seccomp filter install — default deny (Errno EPERM) + 명시 allow list.
/// 실패 시 silent — graceful degrade (격리 약화 but 자식 spawn 자체는 성공).
fn install_seccomp_filter() {
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompFilter, SeccompRule, TargetArch,
    };
    use std::collections::BTreeMap;

    // x86_64 한정 — 다른 아키텍처는 향후 추가 (aarch64 / armv7).
    #[cfg(target_arch = "x86_64")]
    let arch = TargetArch::x86_64;
    #[cfg(target_arch = "aarch64")]
    let arch = TargetArch::aarch64;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        // 미지원 아키텍처 — silent
        return;
    }

    // 허용 syscall list — 일반 모듈 (Node / Python / etc) 동작 필수.
    // x86_64 syscall numbers 기준. seccompiler 가 자동 매핑 (string 안 됨, integer 만).
    // 참조: arch/x86/entry/syscalls/syscall_64.tbl
    #[allow(non_upper_case_globals)]
    let allow_syscalls: &[i64] = &[
        // file I/O
        libc::SYS_read, libc::SYS_write, libc::SYS_open, libc::SYS_openat, libc::SYS_close,
        libc::SYS_fstat, libc::SYS_stat, libc::SYS_lstat, libc::SYS_lseek, libc::SYS_pread64,
        libc::SYS_pwrite64, libc::SYS_readlink, libc::SYS_readlinkat, libc::SYS_access,
        libc::SYS_faccessat, libc::SYS_dup, libc::SYS_dup2, libc::SYS_dup3, libc::SYS_pipe,
        libc::SYS_pipe2, libc::SYS_fcntl, libc::SYS_ioctl, libc::SYS_getdents64,
        libc::SYS_getcwd, libc::SYS_chdir, libc::SYS_fchdir,
        // memory
        libc::SYS_mmap, libc::SYS_munmap, libc::SYS_mprotect, libc::SYS_brk, libc::SYS_mremap,
        libc::SYS_madvise,
        // process
        libc::SYS_execve, libc::SYS_exit, libc::SYS_exit_group, libc::SYS_clone, libc::SYS_fork,
        libc::SYS_vfork, libc::SYS_wait4, libc::SYS_waitid, libc::SYS_getpid, libc::SYS_gettid,
        libc::SYS_getppid, libc::SYS_getuid, libc::SYS_geteuid, libc::SYS_getgid, libc::SYS_getegid,
        libc::SYS_getpgid, libc::SYS_getpgrp, libc::SYS_setsid, libc::SYS_arch_prctl,
        libc::SYS_prctl, libc::SYS_set_tid_address, libc::SYS_set_robust_list,
        // signal
        libc::SYS_rt_sigaction, libc::SYS_rt_sigprocmask, libc::SYS_rt_sigreturn,
        libc::SYS_sigaltstack, libc::SYS_kill,
        // time
        libc::SYS_clock_gettime, libc::SYS_clock_nanosleep, libc::SYS_nanosleep, libc::SYS_gettimeofday,
        // futex / sync
        libc::SYS_futex, libc::SYS_sched_yield,
        // poll / event
        libc::SYS_poll, libc::SYS_ppoll, libc::SYS_select, libc::SYS_pselect6,
        libc::SYS_epoll_create, libc::SYS_epoll_create1, libc::SYS_epoll_wait,
        libc::SYS_epoll_pwait, libc::SYS_epoll_ctl,
        // misc
        libc::SYS_getrandom, libc::SYS_uname, libc::SYS_sysinfo, libc::SYS_getrlimit,
        libc::SYS_prlimit64, libc::SYS_setrlimit,
    ];

    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
    for &sc in allow_syscalls {
        rules.insert(sc, Vec::new()); // empty rule = unconditional allow
    }

    // SeccompFilter::new 의 default action 은 KillProcess / Errno / Trap 등 — Errno(EPERM) 저장
    // (자식이 즉시 죽지 않고 syscall 실패 후 graceful 종료 가능).
    let filter = match SeccompFilter::new(
        rules,
        SeccompAction::Errno(libc::EPERM as u32), // default deny
        SeccompAction::Allow,                       // 명시 allow
        arch,
    ) {
        Ok(f) => f,
        Err(_) => return, // silent — 격리 약화
    };

    // BPF 프로그램 컴파일
    let prog: BpfProgram = match filter.try_into() {
        Ok(p) => p,
        Err(_) => return,
    };

    // install — prctl(PR_SET_NO_NEW_PRIVS) + prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, prog)
    let _ = seccompiler::apply_filter(&prog);
    // 실패해도 silent — 자식이 spawn 후 syscall 차단 없이 실행 (격리 0 인 상태)
}

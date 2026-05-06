//! LinuxCgroupsSandboxAdapter — Linux 운영 (Phase C Docker) 의 OS 레벨 격리.
//!
//! Phase B-post audit Track B (2026-05-06 박힘): 옛 `BasicProcessSandbox` 만으로는 OS 격리 0
//! → `os.system("rm -rf /")` 차단 불가. BIBLE 의 "격리(Sandbox)" 문구 vs 코드 현실 mismatch.
//!
//! ⚠️ **현재 상태: skeleton 만**. 본격 구현은 Phase C Docker 진입 시점에 박음.
//!
//! 박을 격리 메커니즘 (Phase C):
//! - **cgroups v2** — `/sys/fs/cgroup/firebat-sandbox-{uid}/` 박음 + `cgroup.procs` 에 PID 추가
//!   - `cpu.max` — CPU 제한 (예: 50000 100000 = 50% 1 CPU)
//!   - `memory.max` — Memory 제한 (예: 256M)
//!   - `pids.max` — fork bomb 방지 (예: 64)
//! - **seccomp** — syscall whitelist (seccompiler 또는 libseccomp-rs crate)
//!   - 허용: read / write / open / close / mmap / brk / exit / clone (제한) / etc.
//!   - 거부: socket / connect (network deny) / mount / chmod / chown / kill / ptrace
//! - **network namespace** — `unshare(CLONE_NEWNET)` 박은 자식 프로세스는 lo 만 보임
//!   - sysmod 가 외부 fetch 필요 시 INetworkPort 통해 main 프로세스가 대신 호출 (capability-based)
//! - **mount namespace** — `unshare(CLONE_NEWNS)` + bind mount readonly (workspace 일부만)
//! - **user namespace** — root 권한 격리 (어드민 권한 없는 환경 호환)
//!
//! 권장 외부 crate (Phase C 박음):
//! - `nix` — namespace / unshare / setns syscall wrapper
//! - `seccompiler` — seccomp-bpf JIT 컴파일러 (libseccomp 의존성 0)
//! - `cgroups-rs` — cgroup v2 wrapper (또는 직접 sysfs write)
//!
//! 미지원 OS (macOS / Windows / non-Linux Linux 환경) → main.rs 에서 BasicProcessSandbox 폴백.

#![cfg(target_os = "linux")]

use async_trait::async_trait;
use std::path::PathBuf;

use firebat_core::ports::{
    ISandboxPort, InfraResult, ModuleOutput, SandboxCapabilities, SandboxExecuteOpts,
};

pub struct LinuxCgroupsSandboxAdapter {
    /// workspace root — path containment 기준.
    workspace_root: PathBuf,
    /// 옛 ProcessSandboxAdapter 위임 — Phase C 본격 구현 전엔 그냥 위임만.
    /// Phase C 시점엔 자식 프로세스 spawn 직전 cgroup 박음 + seccomp filter 박음 + namespace unshare.
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
}

#[async_trait]
impl ISandboxPort for LinuxCgroupsSandboxAdapter {
    async fn execute(
        &self,
        target_path: &str,
        input_data: &serde_json::Value,
        opts: &SandboxExecuteOpts,
    ) -> InfraResult<ModuleOutput> {
        // Phase C 본격 구현 전엔 BasicProcessSandbox 그대로 위임 — capabilities 만 진짜 OS 격리
        // 신호 (warning 제거) 박음으로써 운영자에게 "이 어댑터 박혔다" 명시.
        // Phase C 시점에 이 함수 안에서:
        //   1. cgroup create + cpu.max / memory.max / pids.max 박음
        //   2. seccomp filter 컴파일
        //   3. unshare(CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWPID) 자식 프로세스
        //   4. exec 직전 cgroup attach + seccomp install
        //   5. 자식 종료 후 cgroup cleanup
        let _ = &self.workspace_root; // unused warning 회피
        self.fallback.execute(target_path, input_data, opts).await
    }

    fn capabilities(&self) -> SandboxCapabilities {
        // skeleton — 현재 동작은 BasicProcessSandbox 와 동일하지만 capabilities 로 박힘 신호.
        // Phase C 본격 구현 후 fs_readonly: true / network_deny: true / seccomp_filter: true 등으로 갱신.
        SandboxCapabilities {
            kind: "linux-cgroups".to_string(),
            fs_readonly: false,
            network_deny: false,
            cpu_limit_ms: 0,
            memory_limit_mb: 0,
            seccomp_filter: false,
            warning: Some(
                "LinuxCgroupsSandbox — Phase C 본격 구현 전 skeleton (BasicProcessSandbox 위임). \
                 cgroups v2 + seccomp + network namespace 박음 시점은 firebat.co.kr Docker 마이그레이션."
                    .to_string(),
            ),
        }
    }
}

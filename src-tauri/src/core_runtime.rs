//! CoreRuntime — Rust Core in-process dispatch.
//!
//! Phase D self-installed 에선 gRPC server 띄우지 않고 직접 method dispatch.
//! Frontend `__TAURI__.invoke('core_call', { method, args })` → 본 dispatch → 결과 반환.
//!
//! Self-hosted (Phase C Docker) 와 다른 점:
//!   - Self-hosted: Rust Core 별 process (port 50051) → gRPC client → 매니저 호출
//!   - Tauri (Phase D): Rust Core in-process embed → 직접 method 호출 (gRPC 우회, 5-10x 빠름)
//!
//! 매니저 dispatch 는 옛 TS facade 와 1:1 — `lib/rust-core-proxy.ts` 의 ARGS_TABLE 패턴 사용.
//!
//! Phase D-2 backbone — 28 service 의 모든 RPC 매핑 + 매니저 인스턴스 풀 박힘 시점에 활성.
//! 현재는 `dispatch` 가 method name → method dispatch table 으로 라우팅.

use std::path::{Path, PathBuf};

pub struct CoreRuntime {
    data_dir: PathBuf,
    // 향후: 매니저 Arc 보유 (PageManager / MediaManager / etc.). 현재 backbone 만.
}

impl CoreRuntime {
    pub fn new(data_dir: PathBuf) -> anyhow::Result<Self> {
        // 향후: 매니저 부팅 (옛 firebat_core::main.rs 의 wiring 재사용).
        // 현재는 data_dir 만 보유 — Phase D-2 후속 commit 에서 매니저 주입.
        std::fs::create_dir_all(&data_dir)?;
        Ok(Self { data_dir })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// method name + args → 매니저 method dispatch.
    /// 현재는 health/data_dir/version 등 backbone method 만. Phase D-2 후속에서 매니저 풀 통합.
    pub async fn dispatch(
        &self,
        method: &str,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        match method {
            "health" => Ok(serde_json::json!({
                "ready": true,
                "version": firebat_core::version(),
                "data_dir": self.data_dir.display().to_string(),
                "backend": "tauri-embed",
            })),
            "version" => Ok(serde_json::json!(firebat_core::version())),
            // 향후: 매니저 풀 dispatch — Phase D-2 commit 에서 매니저별 case 추가.
            // 옛 firebat_core::main.rs 의 wiring 을 재사용 (Arc<MediaManager> / Arc<PageManager> 등).
            _ => Err(format!(
                "[Tauri CoreRuntime] method '{method}' not yet wired — Phase D-2 후속 commit 박을 예정. \
                 임시: 옛 self-hosted gRPC server (port 50051) spawn 으로 우회 가능."
            )),
        }
    }
}

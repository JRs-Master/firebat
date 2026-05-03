//! Firebat Tauri shell — Phase D self-installed distribution.
//!
//! Architecture:
//!   1. Tauri WebView (메인 윈도우) — Next.js 화면 렌더링 (localhost:3000 sidecar)
//!   2. Rust Core in-process embed — gRPC server (port 50051) 자동 spawn
//!   3. Node sidecar — Next.js standalone server spawn (자체 npm node_modules)
//!   4. LLM CLI — `install-cli.js` 가 첫 실행 시 격리 npm install 후 spawn 가능
//!
//! 격리 데이터 디렉토리:
//!   - `FIREBAT_DATA_DIR` env override 가능 (portable USB 옵션)
//!   - default: `~/.firebat/` (Windows: `%APPDATA%\firebat\`)
//!   - 모든 SQLite / Vault / cron-jobs.json / media / npm install 격리
//!
//! Tauri invoke command (Frontend → Rust):
//!   - `core_call(method, args)` — RustCoreProxy 의 callCore 가 이 invoke 호출
//!     → in-process Rust Core 메서드 dispatch → 결과 반환 (gRPC 우회 — Tauri in-process 효율)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

mod core_runtime;
mod node_sidecar;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CoreCallArgs {
    method: String,
    args: serde_json::Value,
}

/// Tauri invoke 명령 — Frontend `__TAURI__.invoke('core_call', ...)` 가 호출.
/// `lib/core-client.ts` 의 `invokeTauri` path 가 라우팅.
#[tauri::command]
async fn core_call(
    args: CoreCallArgs,
    runtime: State<'_, Arc<core_runtime::CoreRuntime>>,
) -> Result<serde_json::Value, String> {
    runtime.dispatch(&args.method, &args.args).await
}

/// Tauri invoke — 데이터 디렉토리 path 반환 (Frontend 디버깅 / portable USB 분기).
#[tauri::command]
fn data_dir(runtime: State<'_, Arc<core_runtime::CoreRuntime>>) -> String {
    runtime.data_dir().to_string_lossy().into_owned()
}

/// Tauri invoke — Rust Core 의 ready 상태 (헬스체크).
#[tauri::command]
async fn core_health(
    runtime: State<'_, Arc<core_runtime::CoreRuntime>>,
) -> Result<serde_json::Value, String> {
    runtime.dispatch("health", &serde_json::Value::Null).await
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,firebat_core=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

fn resolve_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("FIREBAT_DATA_DIR") {
        return PathBuf::from(custom);
    }
    // OS 별 default
    if let Some(home) = std::env::var_os("APPDATA") {
        return PathBuf::from(home).join("firebat");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".firebat");
    }
    PathBuf::from("./firebat-data")
}

fn main() -> anyhow::Result<()> {
    init_tracing();

    let data_dir = resolve_data_dir();
    std::fs::create_dir_all(&data_dir).with_context(|| {
        format!("데이터 디렉토리 생성 실패: {}", data_dir.display())
    })?;
    tracing::info!(data_dir = %data_dir.display(), "Firebat Tauri 부팅");

    // Rust Core in-process embed — gRPC server 띄우지 않고 직접 dispatch (효율).
    // Phase D 에선 in-process method 호출이 self-hosted 의 gRPC 보다 5-10x 빠름.
    let runtime = core_runtime::CoreRuntime::new(data_dir.clone())
        .context("Rust Core in-process 초기화 실패")?;
    let runtime = Arc::new(runtime);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .manage(runtime.clone())
        .setup(move |app| {
            // Setup hook — Node sidecar spawn (Next.js standalone 서버 띄움).
            // sidecar 가 fail 해도 앱 자체는 계속 동작 (로그만 emit).
            let app_handle: AppHandle = app.handle().clone();
            let data_dir_clone = data_dir.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = node_sidecar::spawn(&app_handle, &data_dir_clone).await {
                    tracing::warn!("Node sidecar spawn 실패 (UI fallback localhost): {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![core_call, data_dir, core_health])
        .run(tauri::generate_context!())
        .context("Tauri runtime 실행 실패")?;
    Ok(())
}

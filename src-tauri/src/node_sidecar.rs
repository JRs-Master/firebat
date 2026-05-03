//! Node sidecar — Next.js standalone server spawn.
//!
//! Tauri 앱 내부에서 `node server.js` (Next.js standalone build) 를 띄움 → port 3000 listen.
//! Tauri WebView 가 `http://localhost:3000` 으로 attach.
//!
//! 격리 패턴:
//!   - resource path: `<bundle>/.next/standalone/server.js` (Next.js standalone)
//!   - data dir: `FIREBAT_DATA_DIR` env override (Tauri main.rs 의 resolve_data_dir 결과)
//!   - npm install: `install-cli.js` 가 첫 실행 시 격리 install (Claude Code / Codex / Gemini CLI)
//!
//! Phase D-2 시점: Next.js standalone 빌드 산출물이 bundle 안에 동봉 — Tauri config 의
//! `frontendDist: ../.next/standalone` 박혀있음. sidecar 가 그 server.js 를 spawn.

use std::path::Path;

use tauri::{AppHandle, Manager};
use tokio::process::Command;

pub async fn spawn(app: &AppHandle, data_dir: &Path) -> anyhow::Result<()> {
    // Resource path 추출 — 빌드 시점에 Tauri 가 `frontendDist` 를 resource 로 동봉.
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| anyhow::anyhow!("resource_dir 조회 실패: {e}"))?;
    let server_js = resource_dir.join("server.js");

    if !server_js.exists() {
        // 개발 모드 — Tauri devUrl 로 Next.js dev server (npm run dev) 가 이미 떠 있을 가능성.
        // server.js 없으면 sidecar skip + Tauri WebView 가 devUrl (localhost:3000) attach.
        tracing::info!(
            "Node sidecar: server.js 없음 ({}). 개발 모드로 가정 — npm run dev 가 이미 떠 있어야 함.",
            server_js.display()
        );
        return Ok(());
    }

    let node_path = which_node()?;
    tracing::info!(node = %node_path.display(), server = %server_js.display(), "Node sidecar spawn");

    let mut cmd = Command::new(&node_path);
    cmd.arg(&server_js)
        .env("FIREBAT_DATA_DIR", data_dir)
        .env("FIREBAT_CORE_BACKEND", "tauri") // Frontend 의 lib/core-client.ts 가 자동 분기
        .env("PORT", "3000")
        .env("HOSTNAME", "127.0.0.1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Spawn — child 가 종료되면 Tauri 앱은 계속 동작 (로그만 emit).
    let mut child = cmd.spawn()?;
    tokio::spawn(async move {
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "node_sidecar", "{line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "node_sidecar", "{line}");
                }
            });
        }
        match child.wait().await {
            Ok(status) => tracing::info!("Node sidecar 종료: {status}"),
            Err(e) => tracing::error!("Node sidecar wait 에러: {e}"),
        }
    });

    Ok(())
}

/// PATH 에서 node 실행파일 찾음. 미설치 시 `install-cli.js` 흐름이 격리 npm 설치.
/// Tauri 빌드 시 외부 node 의존성 — 사용자가 사전 설치 또는 Tauri externalBin 동봉 (Cargo.toml 의
/// bundle.externalBin 에 박을 예정 — 향후 portable bundle 화).
fn which_node() -> anyhow::Result<std::path::PathBuf> {
    if let Ok(path) = std::env::var("FIREBAT_NODE_PATH") {
        return Ok(std::path::PathBuf::from(path));
    }
    // 표준 PATH 검색 — 일반 로직 (Windows / macOS / Linux 모두 동작)
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe_name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(anyhow::anyhow!(
        "node 실행파일을 PATH 에서 찾을 수 없음. FIREBAT_NODE_PATH env 박거나 \
         사전에 Node.js 20+ 설치 필요. 향후 Tauri externalBin 으로 portable bundle 검토."
    ))
}

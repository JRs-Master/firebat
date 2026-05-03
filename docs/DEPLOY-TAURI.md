# Firebat — Phase D Self-Installed (Tauri Desktop)

Firebat 의 두 distribution 중 **self-installed** — Windows / macOS / Linux 데스크톱 앱.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Firebat Tauri 앱 (단일 실행파일 ~50MB)                │
│                                                     │
│  ┌─────────────────────────┐                        │
│  │ Tauri WebView (메인 UI)  │  → http://localhost:3000│
│  │ (WebView2 / WKWebView /  │                        │
│  │  WebKitGTK)              │                        │
│  └─────────────────────────┘                        │
│              ↓ invoke('core_call')                   │
│  ┌─────────────────────────┐                        │
│  │ Rust Core in-process     │ ← 매니저 21 + 어댑터 17 │
│  │ (~5MB embed)             │   직접 method dispatch │
│  └─────────────────────────┘                        │
│              ↓ spawn (process)                       │
│  ┌─────────────────────────┐                        │
│  │ Node sidecar (Next.js    │ ← standalone server.js │
│  │  standalone)             │   port 3000 listen     │
│  └─────────────────────────┘                        │
│              ↓ optional spawn                        │
│  ┌─────────────────────────┐                        │
│  │ LLM CLI (claude/codex/   │ ← 첫 실행 시 격리       │
│  │  gemini)                 │   npm install          │
│  └─────────────────────────┘                        │
└─────────────────────────────────────────────────────┘
```

데이터 디렉토리 — `~/.firebat/` (Windows: `%APPDATA%\firebat\`) 또는 `FIREBAT_DATA_DIR` env 박힌 디렉토리 (portable USB 옵션).

## 시스템 요구사항

| OS | 사전 요구사항 |
|---|---|
| Windows 10/11 | Node.js 20+ (https://nodejs.org/), WebView2 (Win11 기본 포함) |
| macOS 10.15+ | Node.js 20+, Xcode CLI tools (`xcode-select --install`) |
| Linux | Node.js 20+, `webkit2gtk-4.1` / `libsoup-3.0` |

## 사전 준비 (개발자)

### 1. Tauri toolchain 설치

```bash
# Windows
# https://v2.tauri.app/start/prerequisites/ 따라 Microsoft Visual Studio C++ Build Tools 설치
# WebView2 Runtime 설치 확인

# macOS
xcode-select --install

# Linux (Ubuntu/Debian)
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libappindicator3-dev librsvg2-dev patchelf
```

### 2. Tauri CLI 설치

```bash
npm install   # @tauri-apps/cli devDependency 박힘 → npx tauri 사용 가능
```

### 3. Rust toolchain (Rust Core 빌드용)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Windows: rustup-init.exe 다운로드 + 실행
```

## 개발 모드 (Hot reload)

```bash
npm run tauri:dev
```

- Tauri 가 `npm run dev` 자동 spawn (Next.js dev server, port 3000)
- Rust Core in-process embed
- WebView 가 localhost:3000 attach
- 코드 변경 시 자동 reload (Frontend 만 — Rust Core 변경 시 재빌드 필요)

## Production 빌드

```bash
# Frontend standalone build
npm run build

# Tauri bundle (Windows: .msi / .exe, macOS: .app / .dmg, Linux: .deb / .AppImage)
npm run tauri:build
```

빌드 산출물 — `src-tauri/target/release/bundle/`:
- Windows: `firebat-tauri.exe` + `firebat_0.0.1_x64-setup.exe` (NSIS) + `Firebat_0.0.1_x64_en-US.msi` (WiX)
- macOS: `Firebat.app` + `Firebat_0.0.1_aarch64.dmg`
- Linux: `firebat-tauri_0.0.1_amd64.deb` + `firebat-tauri_0.0.1_amd64.AppImage`

## 첫 실행 시 LLM CLI 설치 (사용자)

기본 — 사용자가 LLM CLI 사용 원하면 한 번만:

```bash
npm run tauri:install-cli              # 3개 모두 (claude / codex / gemini)
npm run tauri:install-cli claude       # claude-code 만
npm run tauri:install-cli codex gemini # 2개
```

격리 디렉토리 — `<data_dir>/cli-modules/`:
- 시스템 npm 과 분리
- portable USB 옵션 — `FIREBAT_DATA_DIR=/path/to/usb/firebat` 박으면 그 디렉토리에 install
- Tauri 앱 spawn 시 `FIREBAT_CLI_BIN` env 자동 설정 → CLI 인식

## Self-hosted (Docker) vs Self-installed (Tauri) 비교

| 기능 | Self-hosted (Phase C) | Self-installed (Phase D) |
|---|---|---|
| Rust Core | 별 process (gRPC :50051) | Tauri 앱 in-process embed |
| Frontend | Next.js standalone (별 process :3000) | Tauri 가 Next.js sidecar spawn |
| Bundle | Docker image | ~50MB Tauri (Rust Core + Node sidecar + Next.js + WebView) |
| LLM CLI | 사용자 직접 또는 docker-compose 동봉 | 첫 실행 시 자동 npm install |
| 데이터 | docker volume / 서버 디스크 | OS app data 또는 portable USB |
| 24/7 cron / webhook / SEO | ✓ | △ (PC 켜진 시간만, NAT 한계) |
| 채팅 / 시각화 / 메모리 / 갤러리 / sysmod | ✓ | ✓ (코드 100% 동등) |

## 트러블슈팅

### "node 실행파일을 PATH 에서 찾을 수 없음"
Node.js 20+ 사전 설치 필요. https://nodejs.org/ 에서 LTS 다운로드.

향후 (Phase D-3 후속) — Tauri externalBin 으로 portable Node bundle 검토. 사용자 사전 설치 의존성 제거.

### Linux: "error while loading shared libraries: libwebkit2gtk"
`webkit2gtk-4.1` 설치 — `sudo apt install libwebkit2gtk-4.1-dev` (Ubuntu 22.04+).

### macOS: "Firebat is damaged and can't be opened"
Apple notarization 미완료 — 개발자 사인 필요. 일시 우회: `xattr -cr /Applications/Firebat.app`

## 보안 + AGPL

- Tauri 2.x ACL — `src-tauri/capabilities/main.json` 박힌 권한만 활성 (shell:execute / fs:app-read 등)
- AGPL-3.0 — fork / commercial 사용 시 source 공개 의무 (Anthropic/OpenAI OSS 프로그램 자격)
- 사용자 첫 실행 시 LLM CLI 격리 npm install — 시스템 npm 영향 0

## 향후 개선

- [ ] Tauri externalBin 으로 Node.js portable 동봉 (Node 사전 설치 의존성 제거)
- [ ] Tauri auto-updater (1-click upgrade)
- [ ] OAuth callback 흐름 — Tauri native window 가 LLM CLI OAuth 결과 받음
- [ ] 코드 사인 + Apple notarization

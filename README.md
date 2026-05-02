<p align="center">
  <img src="app/icon.svg" width="80" alt="Firebat Logo" />
</p>

<h1 align="center">Firebat</h1>

<p align="center">
  <em>Just Imagine. Firebat Runs.</em>
</p>

<p align="center">
  <strong>AI-Powered Visual Automation Agent (VAA)</strong> — Self-hosted, single-node, multi-LLM.
  <br />
  <sub>웹 UI에서 한 마디 대화로 웹 앱을 만들고·운영하고·자동화하는 AI 기반 시각적 자동화 에이전트</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs" alt="Next.js" />
  <img src="https://img.shields.io/badge/TypeScript-6-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/LLM-Multi--Provider-4285F4" alt="Multi-Provider LLM" />
  <img src="https://img.shields.io/badge/MCP-1.29-purple" alt="MCP" />
  <img src="https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite" alt="SQLite" />
  <img src="https://img.shields.io/badge/License-AGPL--3.0-blue" alt="License" />
</p>

---

## What is Firebat?

Firebat is an **AI-Powered Visual Automation Agent (VAA)** — a self-hosted platform that designs, ships, schedules, and automates from a single conversation.

```
"Build me a weather app"  →  AI writes the code  →  Page deploys
                          →  Cron updates it hourly  →  Sends KakaoTalk alerts
```

One prompt flows through **design → implementation → deployment → scheduling → notification**.

**Why VAA?** Firebat sits at the intersection of three categories:
- **Visual** — results are pages, charts, tables, cards (20+ render_* components), not chat logs.
- **Automation** — cron + pipelines run while you're away (not one-shot chat).
- **Agent** — native Function Calling multi-turn tool loop (no brittle JSON parsing).

Existing tools pick one: LangGraph/CrewAI are agents but not visual/automation. n8n/Zapier are automation but not agents. v0/Bolt are visual but one-shot. Firebat is all three.

> 🇰🇷 Firebat은 **AI 기반 시각적 자동화 에이전트 (VAA)** 입니다. 대화 한 마디로 웹 앱을 만들고, 자동화하고, 운영합니다. 하나의 프롬프트가 **설계 → 구현 → 배포 → 스케줄링 → 알림**까지 관통합니다.
>
> Agent (LangGraph) + Automation (n8n) + Builder (v0/Bolt) 세 카테고리의 교집합. 결과물이 **시각적**(페이지·차트·카드)이고, **자동화 반복 실행**되고, **AI 가 자율 도구 선택**합니다.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│           app/admin/hooks/  (Frontend Managers)            │
│     ChatManager · EventsManager · SettingsManager          │
├────────────────────────────────────────────────────────────┤
│                 app/api/  (Primary Adapter)                │
│                Next.js Route Handlers · Auth               │
├────────────────────────────────────────────────────────────┤
│                                                            │
│   ┌────────────────────────────────────────────────────┐   │
│   │                FirebatCore (Facade)                │   │
│   │                                                    │   │
│   │  AI · Storage · Page · Project · Module · Task     │   │
│   │  Schedule · Secret · MCP · Capability · Auth       │   │
│   │  Conversation · Media · Event · Status · Cost · Tool│  │
│   │                    17 Managers                     │   │
│   └────────────────────┬───────────────────────────────┘   │
│                        │ Ports (Interface)                 │
│   ┌────────────────────┴───────────────────────────────┐   │
│   │                 infra/  (Adapters)                 │   │
│   │                                                    │   │
│   │  Storage · Log · Sandbox · LLM · Network · Cron    │   │
│   │  Database · Vault · MCP Client · Auth · Embedder   │   │
│   │  ToolRouter · Media · ImageProcessor · ImageGen    │   │
│   │                     15 Adapters                    │   │
│   └────────────────────────────────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Hexagonal Architecture** — Core holds pure business logic only; every I/O call lives inside an Infra adapter. Frontend UI state is managed by 3 dedicated managers mirroring the backend pattern.

| Principle | Description |
|---|---|
| **Core purity** | Core never imports `fs`, `fetch`, DB drivers, or any I/O library directly |
| **Ports & Adapters** | Core talks to Infra only through 15 interface (Port) definitions |
| **Error encapsulation** | Infra never throws — it returns `InfraResult<T>` instead |
| **Facade pattern** | Every API route goes through the `getCore()` singleton |
| **Frontend managers** | UI state transitions concentrated in 3 managers (Chat / Events / Settings) — reducer-based invariants prevent whole classes of UI bugs by construction |

> 🇰🇷 **헥사고날 아키텍처** — Core는 순수 비즈니스 로직만 담당하고, 모든 I/O는 Infra 어댑터가 처리합니다. Core는 I/O 라이브러리를 직접 import하지 않고 15개 포트 인터페이스로만 Infra와 통신하며, Infra는 절대 throw하지 않고 `InfraResult<T>`를 반환합니다. 모든 API route는 `getCore()` 싱글톤을 거칩니다. 프론트엔드 UI 상태는 3개 매니저(Chat/Events/Settings)로 분리되어 reducer 기반 인바리언트로 UI 버그를 구조적으로 차단합니다.

---

## Features

### AI Function Calling Pipeline

```
User prompt
    ↓
[Function Calling] Native tool calls per provider (multi-turn loop)
    ↓
[Tool Execution] Core tools + dynamic MCP tools
    ↓
[Streaming] SSE streaming (thinking/text in real time)
    ↓
[Report] Log + typing animation in the frontend
```

- **Multi-provider**: OpenAI GPT-5.4 / Anthropic Claude 4 / Google Gemini 3 / GCP Vertex AI — one `ILlmPort`, add models by dropping a JSON config
- **CLI mode**: Subscription-based (Claude Pro/Max, ChatGPT Plus/Pro, Google AI Pro) — no API key, runs the local CLI as a child process. Session resume + Claude Code persistent daemon for 2nd-turn speedup
- **Streaming**: `onChunk` callback → SSE `chunk` event delivers tokens and thinking in real time
- **Core tools**: File CRUD, page management, module execution, scheduling, secrets, MCP calls, inline component rendering
- **Auto vs. confirm policy**: Irreversible actions prompt for approval; everything else runs automatically
- **Unified thinking/reasoning**: Provider-specific flags mapped from one abstraction (`reasoning.effort` / `thinkingConfig` / `thinking.budget_tokens` / `--effort`)

> 🇰🇷 **AI Function Calling 파이프라인** — 사용자 프롬프트가 공급자 네이티브 도구 호출(멀티턴) → Core/MCP 도구 실행 → SSE 스트리밍 → 프론트엔드 타이핑 효과로 흐릅니다. OpenAI · Anthropic · Google · Vertex를 동일 `ILlmPort`로 추상화하고, 구독 기반 CLI 모드(Claude Code / Codex / Gemini CLI)도 지원합니다. Thinking/Reasoning은 공급자별 플래그를 자동 매핑합니다.

### Scheduling & Automation

- **Three modes**: recurring (`cron`), one-shot (`runAt`), delay (`delaySec`)
- **Pipelines**: Pre-compiled composite workflows — "MCP query → LLM summary → module dispatch"
- **Seven pipeline steps**: `EXECUTE` (sandbox module), `MCP_CALL`, `NETWORK_REQUEST`, `LLM_TRANSFORM`, `CONDITION` (branching/early-stop), `SAVE_PAGE`, `TOOL_CALL` (Function Calling tools like `image_gen` from cron)
- **Persistence**: Jobs restored automatically on PM2 restart
- **Dynamic timezone**: Change per installation via settings

> 🇰🇷 **스케줄링 & 자동화** — 반복(`cron`) / 1회 예약(`runAt`) / 딜레이(`delaySec`) 3가지 모드. 복합 작업은 파이프라인 7단계 (`EXECUTE` / `MCP_CALL` / `NETWORK_REQUEST` / `LLM_TRANSFORM` / `CONDITION` / `SAVE_PAGE` / `TOOL_CALL`) 로 사전 컴파일. PM2 재시작 시 자동 복원, 타임존 동적 변경.

### MCP (Model Context Protocol)

**MCP Server** — external AI tools drive Firebat

| Transport | Use case | Auth |
|---|---|---|
| **stdio** | Local AI tools (Claude Code, Cursor, …) | SSH key |
| **Streamable HTTP** | Remote clients (VS Code, Antigravity, …) | Bearer token |

```json
{
  "mcpServers": {
    "firebat": {
      "url": "https://your-server.com/api/mcp",
      "headers": {
        "Authorization": "Bearer fbt_your_token_here"
      }
    }
  }
}
```

Exposes 20+ tools: page CRUD, file CRUD, module execution + introspection (`list_user_modules` / `get_module_schema`), project management, cron management, nested MCP tool calls, etc.

**MCP Client** — Firebat calls out to external MCP servers (Gmail, Slack, KakaoTalk, …). Tools are auto-registered and the AI invokes them without extra wiring.

> 🇰🇷 **MCP (Model Context Protocol)** — 외부 AI가 Firebat을 조작하는 **서버**(stdio / Streamable HTTP)와, Firebat이 Gmail·Slack·카톡 같은 외부 서비스를 호출하는 **클라이언트**를 모두 제공합니다. 서버는 18개 도구를 노출하고 Bearer 토큰으로 보호됩니다.

### Sandbox Execution

- **Language-neutral**: Python, JavaScript, PHP, Rust, WASM, Shell
- **Auto package install**: Declare dependencies in `config.json.packages` — installed on first run
- **Secret injection**: Vault values passed as env vars — the AI never sees the raw secret
- **Timeout**: 30 seconds per execution

> 🇰🇷 **샌드박스 실행** — 언어 중립(Python/JS/PHP/Rust/WASM/Shell), `config.json` `packages` 기반 자동 설치, Vault 시크릿을 환경변수로만 주입(AI는 키 값을 모름), 30초 타임아웃.

### Built-in Components

Define UI via PageSpec JSON and Firebat renders it automatically. The AI can also call these directly in chat through `render_*` tools:

`Header` · `Text` · `Card` · `Grid` · `Form` · `Image` · `Button` · `Table` · `Html` · `Divider` · `List` · `Slider` · `Tabs` · `Accordion` · `Progress` · `Badge` · `Alert` · `Callout` · `Carousel` · `Countdown` · `Chart` · `Metric` · `Timeline` · `Compare` · `KeyValue` · `StatusBadge` · `StockChart`

> 🇰🇷 **빌트인 컴포넌트** — PageSpec JSON으로 선언하면 자동 렌더링. 채팅에서는 AI가 `render_*` 도구로 직접 호출합니다. 총 27종 (Header/Text/Card/Grid/Form/… + 신규 Metric/Timeline/Compare/KeyValue/StatusBadge + 전용 StockChart).

### Capability-Provider System

Group multiple modules that perform the same capability, manage priority and fallback:

| Capability | Providers |
|---|---|
| `web-scrape` | browser-scrape (local), firecrawl (api) |
| `web-search` | naver-search (api) |
| `keyword-analytics` | naver-ads (api) |
| `stock-trading` | korea-invest (api), kiwoom (api), upbit (api, crypto) |
| `notification` | kakao-talk (api), telegram (api, bidirectional bot) |
| `legal-search` | law-search (api) |

Admins set the provider order in settings; failures cascade to the next provider automatically.

> 🇰🇷 **Capability-Provider 시스템** — 같은 기능을 수행하는 여러 모듈을 `capability`로 묶고, 관리자가 UI에서 provider 실행 순서를 지정합니다. 실패 시 다음 provider로 자동 폴백.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router, Turbopack) |
| **Language** | TypeScript 6 |
| **Styling** | Tailwind CSS 4 |
| **AI** | OpenAI · Anthropic · Google Gemini/Vertex (config-driven multi-provider) + CLI subscription mode |
| **Database** | SQLite (better-sqlite3) |
| **Editor** | Monaco Editor |
| **MCP** | @modelcontextprotocol/sdk 1.29 |
| **Scheduling** | node-cron |
| **Validation** | Zod |
| **Deploy** | PM2 + Nginx |

---

## Quick Start

### Prerequisites

- Node.js 20+
- Python 3.10+ (for module sandbox)

> 🇰🇷 Node.js 20 이상 / Python 3.10 이상 (모듈 샌드박스용).

### Installation

```bash
git clone https://github.com/JRs-Master/firebat.git
cd firebat
npm install
```

### Development

```bash
npm run dev
```

Open `http://localhost:3000/admin` for the admin console.

> 🇰🇷 `http://localhost:3000/admin`에서 어드민 콘솔에 접속합니다.

### Configuration

1. **AI model**: Settings → AI tab → execution mode (API/CLI) → provider (OpenAI/Google/Anthropic) → model
   - **API mode**: Enter the provider API key (`sk-proj-…`, `AIza…`, `sk-ant-…`) or a Vertex Service Account JSON
   - **CLI mode**: Run `claude auth login` / `codex login` / `gemini auth login` on the server and click **"Check status"**
2. **Timezone**: Settings → General tab (default `Asia/Seoul`)
3. **MCP token**: Sidebar → SYSTEM → Firebat MCP Server → generate a bearer token for external AI clients

> 🇰🇷 **설정** — AI 탭에서 API/CLI 모드, 공급자, 모델을 고르고 각 공급자의 키 또는 CLI 로그인 상태를 입력합니다. 타임존은 일반 탭에서, MCP 토큰은 사이드바의 SYSTEM > Firebat MCP 서버에서 생성합니다.

### Production

```bash
npm run build
pm2 start npm --name firebat -- start
```

### MCP Server

```bash
# stdio mode (local)
npm run mcp

# HTTP mode — generate a token in settings, then use /api/mcp
```

---

## Project Structure

```
firebat/
├── core/                    # Pure business logic (no I/O)
│   ├── index.ts             #   FirebatCore Facade
│   ├── ports/               #   15 Port interfaces
│   ├── managers/            #   17 domain managers (+ ai/ collaborator subfolder)
│   ├── types/               #   CoreResult, AiRequestOpts
│   ├── utils/               #   sanitize, json-normalize
│   └── capabilities.ts      #   Capability-Provider registry
│
├── infra/                   # I/O execution layer (adapters)
│   ├── boot.ts              #   Infra singleton assembly
│   ├── config.ts            #   Central config constants
│   ├── storage/             #   Filesystem + Vault
│   ├── llm/                 #   ConfigDrivenAdapter + 8 format handlers (5 API + 3 CLI)
│   ├── sandbox/             #   Process sandbox (Python/Node/PHP/Shell)
│   ├── cron/                #   node-cron scheduler (file-fallback for resilience)
│   ├── database/            #   SQLite adapter + migrations/ (versioned schema)
│   ├── log/                 #   4-level logging + JSONL training data + token-redactor
│   ├── network/             #   HTTP client (SSRF-hardened)
│   ├── mcp-client/          #   External MCP server client
│   ├── auth/                #   Vault-backed session / API tokens
│   ├── media/               #   Local media storage (variants, blurhash)
│   ├── image-processor/     #   sharp adapter (resize, format, blurhash)
│   ├── image/               #   Config-driven image generation (OpenAI gpt-image, Gemini Flash Image)
│   └── security/            #   token-redactor (log masking)
│
├── app/                     # Next.js App Router
│   ├── admin/               #   Admin console (chat, settings, editor)
│   │   └── hooks/           #     Frontend managers: Chat / Events / Settings
│   ├── (user)/              #   User-facing pages (dynamic render)
│   └── api/                 #   API routes (Primary Adapter)
│
├── mcp/                     # MCP server (stdio + Streamable HTTP)
│   ├── server.ts            #   Tool definitions for VSCode/Cursor
│   ├── stdio.ts             #   stdio entry (external AI)
│   ├── internal-server.ts   #   User-AI tool set
│   └── stdio-user-ai.ts     #   stdio entry for CLI-mode User AI
│
├── lib/                     # Utilities
│   ├── singleton.ts         #   Core singleton factory
│   ├── auth-guard.ts        #   API route auth guard
│   └── events.ts            #   SSE event bus
│
├── system/                  # System area
│   ├── services/            #   Config-only services (SEO, MCP server)
│   └── modules/             #   Built-in runnable modules (naver-search, naver-ads, korea-invest, kiwoom, upbit, kakao-talk, telegram, firecrawl, browser-scrape, law-search)
│
├── user/                    # User area (modules, data)
│   └── modules/             #   User-created modules
│
├── docs/                    # Design documents (bibles)
│   ├── FIREBAT_BIBLE.md     #   Top-level constitution (identity, separation of powers)
│   ├── CORE_BIBLE.md        #   Core purity, 12 Ports, 12-Manager backend + 3-Manager frontend architecture
│   ├── INFRA_BIBLE.md       #   12 Adapter specs, bootstrap
│   ├── MODULE_BIBLE.md      #   Module system, Capability-Provider pattern
│   ├── PAGESPEC_BIBLE.md    #   PageSpec schema + chat rendering rules
│   └── IO_SCHEMA_BIBLE.md   #   Module I/O schema reference
│
└── data/                    # Runtime data (gitignored)
    ├── app.db               #   Pages DB
    ├── vault.db             #   Secret store
    ├── cron-jobs.json       #   Persisted cron jobs
    └── logs/                #   App logs + JSONL training data
```

---

## Roadmap

| Phase | Description | Status |
|---|---|---|
| **v0.1** | Core + Infra + 17 Managers + MCP (server + client) + Scheduling + Pipeline (7 steps) + Vault + Multi-LLM (API + CLI) + Telegram bidirectional bot + StatusManager + DB migration runner | Done |
| **v1.0** | 3-Tier Docker (EasyPanel) + Core / Next.js IPC split + initial setup wizard | Planned |
| **v2.0** | Rust Core + gRPC + dynamic loading of system modules | Planned |

> 🇰🇷 **로드맵** — v0.1(완료): Core + Infra + 17 매니저 + MCP(서버·클라이언트) + 스케줄링 + 파이프라인(7단계) + Vault + 멀티 LLM(API·CLI) + 텔레그램 양방향 봇 + StatusManager + DB 마이그레이션 runner. v1.0(예정): 3-Tier Docker(EasyPanel) + Core/Next.js IPC 분리 + 초기 위자드. v2.0(예정): Rust Core + gRPC + 시스템 모듈 동적 로드.

---

## License

[GNU AGPL-3.0-or-later](LICENSE). Free for personal use, study, modification, and self-hosted non-commercial deployment. **Network use (SaaS hosting) requires source disclosure** — if you modify Firebat and offer it as a service, you must release your modifications under AGPL. Commercial entities wanting to host Firebat-derived services without source disclosure should contact the author for a commercial license (dual-licensing).

> 🇰🇷 **라이선스** — GNU AGPL-3.0. 본인 사용·학습·수정·자체 호스팅 (비영리) 자유. SaaS 호스팅 시 수정 코드 공개 의무 — 비공개로 상용 서비스 운영하려면 별도 commercial license 협상 필요 (dual-licensing).

---

## Acknowledgements — Built by 3 LLMs + Human

Firebat is a **3-LLM collaborative project** — designed and written together by humans and three frontier AI models:

- **Claude (Anthropic)** — bulk of the recent codebase, architectural decisions, code review · via [Claude Code](https://claude.com/claude-code) + Anthropic API
- **GPT (OpenAI)** — co-author of FIREBAT_BIBLE, coding via [Codex CLI](https://github.com/openai/codex)
- **Gemini (Google)** — initial Firebat prototype + co-author of FIREBAT_BIBLE, coding via [Gemini CLI](https://github.com/google-gemini/gemini-cli)

Firebat itself is an AI-powered VAA — fitting that the platform was built by the same AI ↔ human collaboration it now enables. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for details.

---

## Design Documents

- **[FIREBAT_BIBLE.md](docs/FIREBAT_BIBLE.md)** — Top-level constitution (identity, separation of powers, JSON dogma) · 최고 등급 헌법
- **[CORE_BIBLE.md](docs/CORE_BIBLE.md)** — Core purity, 15 Ports, 17-Manager backend + 3-Manager frontend, Function Calling pipeline · Core 설계 규격
- **[INFRA_BIBLE.md](docs/INFRA_BIBLE.md)** — 15 Adapter specs, bootstrap, config constants · Infra 구현 규격
- **[MODULE_BIBLE.md](docs/MODULE_BIBLE.md)** — Module system, Capability-Provider pattern · 모듈 시스템 규격
- **[PAGESPEC_BIBLE.md](docs/PAGESPEC_BIBLE.md)** — PageSpec schema, built-in components, chat rendering · 페이지·렌더링 규약
- **[IO_SCHEMA_BIBLE.md](docs/IO_SCHEMA_BIBLE.md)** — Module I/O schema reference · 모듈 I/O 스키마 레퍼런스

---

<p align="center">
  <sub>Built with obsession by <a href="https://firebat.co.kr">Firebat</a></sub>
</p>

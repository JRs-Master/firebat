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
│   │  Entity · Episodic · Consolidation (Memory)        │   │
│   │                    21 Managers                     │   │
│   └────────────────────┬───────────────────────────────┘   │
│                        │ Ports (Interface)                 │
│   ┌────────────────────┴───────────────────────────────┐   │
│   │                 infra/  (Adapters)                 │   │
│   │                                                    │   │
│   │  Storage · Log · Sandbox · LLM · Network · Cron    │   │
│   │  Database · Vault · MCP Client · Auth · Embedder   │   │
│   │  ToolRouter · Media · ImageProcessor · ImageGen    │   │
│   │  Entity · Episodic (Memory)                        │   │
│   │                     17 Adapters                    │   │
│   └────────────────────────────────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**Hexagonal Architecture** — Core holds pure business logic only; every I/O call lives inside an Infra adapter. Frontend UI state is managed by 3 dedicated managers mirroring the backend pattern.

| Principle | Description |
|---|---|
| **Core purity** | Core never imports `fs`, `fetch`, DB drivers, or any I/O library directly |
| **Ports & Adapters** | Core talks to Infra only through 17 interface (Port) definitions |
| **Error encapsulation** | Infra never throws — it returns `InfraResult<T>` instead |
| **Facade pattern** | Every API route goes through the `getCore()` singleton |
| **Frontend managers** | UI state transitions concentrated in 3 managers (Chat / Events / Settings) — reducer-based invariants prevent whole classes of UI bugs by construction |

> 🇰🇷 **헥사고날 아키텍처** — Core는 순수 비즈니스 로직만 담당하고, 모든 I/O는 Infra 어댑터가 처리합니다. Core는 I/O 라이브러리를 직접 import하지 않고 17개 포트 인터페이스로만 Infra와 통신하며, Infra는 절대 throw하지 않고 `InfraResult<T>`를 반환합니다. 모든 API route는 `getCore()` 싱글톤을 거칩니다. 프론트엔드 UI 상태는 3개 매니저(Chat/Events/Settings)로 분리되어 reducer 기반 인바리언트로 UI 버그를 구조적으로 차단합니다.

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
- **Persistence**: Jobs restored automatically on container/process restart (`data/cron-jobs.json`)
- **Dynamic timezone**: Change per installation via settings

> 🇰🇷 **스케줄링 & 자동화** — 반복(`cron`) / 1회 예약(`runAt`) / 딜레이(`delaySec`) 3가지 모드. 복합 작업은 파이프라인 7단계 (`EXECUTE` / `MCP_CALL` / `NETWORK_REQUEST` / `LLM_TRANSFORM` / `CONDITION` / `SAVE_PAGE` / `TOOL_CALL`) 로 사전 컴파일. 컨테이너 재시작 시 `data/cron-jobs.json` 으로 자동 복원, 타임존 동적 변경.

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
- **Auto-cache for large responses**: the sandbox detects a sysmod response's largest top-level array (≥30 items) and stores it in the `SysmodCacheAdapter`, returning a small 5-item preview plus a `_cacheKey` to the model. The AI drills in with `cache_read` / `cache_grep` / `cache_aggregate` instead of paying full-array tokens. Modules need no code change — yfinance's existing explicit `_cache` envelope still takes priority for rich previews.

> 🇰🇷 **샌드박스 실행** — 언어 중립(Python/JS/PHP/Rust/WASM/Shell), `config.json` `packages` 기반 자동 설치, Vault 시크릿을 환경변수로만 주입(AI는 키 값을 모름), 30초 타임아웃. **응답 자동 캐싱**: 큰 배열 필드(≥30)는 sandbox가 자동으로 SysmodCacheAdapter에 저장하고 5개 미리보기 + `_cacheKey`만 AI에 전달 → LLM 토큰 절약, 모듈 코드 수정 0.

### Built-in Components

Define UI via PageSpec JSON and Firebat renders it automatically. In chat, the AI emits them through a single unified `render({blocks: [{type, props}, ...]})` tool:

`Header` · `Text` · `Card` · `Grid` · `Form` · `Image` · `Button` · `Table` · `Html` · `Divider` · `List` · `Slider` · `Tabs` · `Accordion` · `Progress` · `Badge` · `Alert` · `Callout` · `Carousel` · `Countdown` · `Chart` · `Metric` · `Timeline` · `Compare` · `KeyValue` · `StatusBadge` · `StockChart`

Each block's `props` is validated against the component's JSON Schema. A recursive **`sanitize_to_schema`** runs first so the AI's natural output (synonym keys dropped by `additionalProperties:false`, optional enum/type mismatches, nullable required props missing) passes without losing the block: extras are dropped, missing required props are filled from `default` or `null` where allowed, and optional props that still fail validation get pruned so the renderer's default kicks in — recursing into nested objects and arrays. Truly-missing essential props still surface as a `failed[]` entry with `gotKeys` (the original keys the AI sent) so the model can retry with the right shape.

> 🇰🇷 **빌트인 컴포넌트** — PageSpec JSON으로 선언하면 자동 렌더링. 채팅에서는 AI가 단일 `render({blocks:[...]})` 도구로 호출. 각 block의 `props`는 컴포넌트 JSON Schema로 검증되며, 검증 전에 **재귀 `sanitize_to_schema`**가 돌아 AI 출력을 자동 정리합니다 — `additionalProperties:false`의 미지 키 drop, 누락 required는 `default`/null 채움, optional 위반(잘못된 enum/타입)은 drop(렌더러 기본값 적용), 중첩 객체·배열까지 재귀. 진짜 필수가 빠진 경우만 `failed[]`로 `gotKeys`(AI가 보낸 원본 키)와 함께 노출해 재시도 신호.

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

### Memory System (4-tier)

CrewAI / Mem0 식 4-tier memory — **dialogue ends, facts persist**. Continuous operation (auto-trading / blog publishing) accumulates entity timelines without manual save.

| Tier | Role | Implementation |
|---|---|---|
| **Short-term** | Active conversation turns | ConversationManager (existing) — embeddings search |
| **Episodic** | Time-stamped events (auto-trading executions, page publishes, cron triggers, tool calls) | `events` + `event_entities` m2m. Auto-hooks via Core facade (BIBLE-compliant) |
| **Entity** | Tracked subjects (stocks, people, projects, concepts) + linked timeline facts | `entities` + `entity_facts`. Semantic search + alias matching |
| **Contextual** | 5-source merged retrieval (4 memory tiers + Library RAG) | `RetrievalEngine` — every user prompt → parallel search → `<MEMORY_CONTEXT>` auto-prepended (when the AI Assistant toggle is on) |

**Auto-accumulation, zero manual work**:
- Core hooks fire `saveEvent` on every `savePage` / `handleCronTrigger` / `generateImage`.
- `ConsolidationManager` cron — every 6 hours, inactive conversations auto-extract entity/fact/event JSON via cheap LLM (~$0.001/dialogue).
- `dedupThreshold=0.92` cosine similarity check — re-running consolidation is naturally idempotent.
- 5 AI tools (`save_entity` / `save_entity_fact` / `search_entities` / `get_entity_timeline` / `search_entity_facts`) + 3 episodic tools + `consolidate_conversation` — both Function Calling and CLI MCP exposed.

After 1 week of auto-trading, "How did Samsung do?" returns full timeline (recommendations → buys → results) without asking for context. The memory layer fills itself.

> 🇰🇷 **메모리 시스템 4-tier** — 대화는 휘발해도 사실은 영속. 자동매매·블로그 운영 깊어질수록 가치 폭발. Core hook 자동 saveEvent / 6시간 cron 자동 LLM 후처리 / cosine 중복 검출 / RetrievalEngine 자동 prepend — 사용자 명시 호출 0회로도 "삼성전자 1주 전 추천 결과는?" 즉시 답변. (Phase 1-6 완료, Phase 3 Vector store 는 entity 1000+ 시점 deferred)

> 🇰🇷 **Library RAG** (2026-05-17, 2026-06-01 하이브리드) — 사용자 업로드 자료(PDF/TXT/MD/URL) NotebookLM 식 RAG. **dense(E5) + sparse(BM25/SQLite FTS5) 하이브리드 + RRF** 검색 — 의미 + 정확 토큰(고유명사·법조문 코드)까지. parent-doc 맥락 확장 + 경계 인식 청킹. RetrievalEngine 5번째 source 로 자동 주입(AI Assistant 토글 ON 시) + `search_library` 도구로 AI 능동 검색. 쿼리당 LLM 비용 0 — ANN/벡터DB 없이 SQLite 만으로.

### Observability — Runtime Logs

`tracing`-based logging with a single layer fan-out: one `reload::Layer<EnvFilter>` (global filter) → `fmt` (journalctl) + a sqlite ring buffer (`data/logs.db`, last 5000 rows, WAL, isolated from app/vault DBs).

- **Runtime level changes, zero rebuild** — SIGHUP reloads the filter from `data/log-filter.txt` (e.g. `info,firebat_infra::adapters::sandbox=debug,ai=debug`). Diagnostic logs stay off (`info`) day-to-day and flip on per category only when investigating.
- **Admin log tab** — Settings → Logs: level / prefix / time filters over the ring buffer + a runtime filter-reload toggle (UI button instead of ssh SIGHUP), served by `LogService` gRPC.
- **Manager categories** — `ILogPort.log_with(category, level, msg)` passes the category as a tracing *field* (target is compile-time static), promoted to the sqlite `target` column so manager logs (conversation / media / ai / task / cron) filter by category. Managers keep calling `self.log.*`; a `CategoryLogger` wrapper injects the category at construction.
- **Frontend collection** — the browser logger POSTs error/warn to `/api/log`, surfaced in the `firebat-frontend` journal as `[client:<category>]` (hub-visitor browser errors made visible).

Scope is intentionally narrow (observability-paradox rule): query / filter / toggle only — no dashboards, graphs, or alerts.

> 🇰🇷 **런타임 로그** — `tracing` 단일 layer fan-out (reload EnvFilter → journalctl + sqlite ring 5000건). SIGHUP 으로 런타임 레벨/카테고리 동적 변경 (재빌드 0), admin 설정 로그 탭에서 필터·reload 토글. 매니저 로그는 `CategoryLogger` 로 category 자동 주입 → 탭에서 매니저 단위 필터. 브라우저 error/warn 도 `/api/log` 로 수집. 범위는 조회/필터/토글만 (대시보드·알림 미도입).

### i18n — Self-built (ko / en, no dependency)

Custom i18n system in `lib/i18n.tsx` (~100 LOC, no `next-intl` / `react-intl` dep). Two domains separated:

- **Admin UI** (dynamic ko/en toggle) — `useTranslations()` hook + `LangProvider` Context. Active lang resolved from `localStorage('firebat_ui_lang')` → `/api/settings interfaceLang` (vault) → fallback. Toggle in Settings → General → live screen switch (no reload).
- **Public site** (static per cms.siteLang) — `getServerTranslations(siteLang)` (RSC) + `usePublicTranslations()` (client). siteLang = free-form text in CMS (`ko` / `en` / `ja` / `zh-CN` etc — multi-lang ready, only ko/en messages bundled now).

Messages JSON (`language/ko.json` + `language/en.json`) — categories: common / login / setup / admin_chat / settings / page / sidebar. v2.0 Tauri SPA / Vercel frontend hybrid migration unaffected (no Next.js deep-coupling).

> 🇰🇷 **자체 i18n** — `lib/i18n.tsx` 100줄 자체 구현. 어드민 ko/en 동적 토글 (즉시 화면 전환) + 공개 사이트 정적 (cms.siteLang). 의존성 0 — Tauri / SPA 마이그레이션 자유.

### CMS V2 — Widget Builder

Site builder reaches Astra/GP-class depth — header / sidebar / footer all share a unified widget catalog (13 widget types with scope guards: `header-only`, `sidebar-only`, `footer-only`, `header-footer`, `universal`).

- **Header** — left/center/right 3-col widget array (Astra-style slot system, simplified)
- **Sidebar** — 1D widget array, 4 layout modes (full / right / left / both / boxed)
- **Footer** — 4-column grid with widget array per column
- **Live preview** — `/admin/cms` iframe with viewport toggle (1280px / 768px / 375px) + ResizeObserver auto-scale
- **Page-level overrides** — `head.layoutMode` / `head.contentMaxWidth` per page (proxy header propagation)
- **Design tokens** — color presets (10) + custom hex / typography (base + scale ratio derives h1-h6) / external font URL / button + link + selection token cascade

> 🇰🇷 **CMS V2 위젯 빌더** — 헤더·사이드바·푸터 통합 widget 카탈로그 (13 종, scope 자동 가드). 새 widget 1개 추가 = 모든 영역 자동 활용. Live preview viewport 토글로 PC/태블릿/모바일 즉시 검증.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Rust (tonic 0.12 + tokio + rusqlite + reqwest + cron crate) — `core/` + `infra/` Cargo workspace |
| **Frontend** | Next.js 16 (App Router, Turbopack) + TypeScript 6 + Tailwind CSS 4 + React Query (TanStack Query 5) |
| **IPC** | gRPC (proto/firebat.proto, 28 services / 208 RPCs) — @connectrpc/connect-node typed client |
| **AI** | OpenAI · Anthropic · Google Gemini/Vertex (config-driven multi-provider, JSON registry `system/llm/models.json`) + CLI subscription mode |
| **Database** | SQLite (rusqlite bundled, 정적 링크) |
| **Editor** | Monaco Editor |
| **MCP** | Rust 자체 구현 (axum + JSON-RPC 2.0, HTTP :50052 + stdio) — Phase E (2026-05-12) 단일 binary 안 통합 |
| **Validation** | Zod (TS) + serde (Rust) — `lib/form-validation.ts` 통합 framework |
| **Codegen** | `npm run gen:proto` — protoc-gen-es (typed gRPC client) + adapter tables (`proto/adapter-overrides.json`) + vault keys (`proto/vault-keys.json`). 새 RPC / vault key 추가 시 JSON 만 수정 |
| **Deploy** | Vultr systemd 2 unit (`firebat` Rust core + `firebat-frontend` Next.js standalone) + Caddy 자동 TLS reverse proxy |

---

## Quick Start

### Prerequisites

- **Rust** stable (1.79+) — backend core/infra 빌드
- **Node.js** 20+ — Next.js frontend
- **Python** 3.10+ — module sandbox
- **protoc** 자동 동봉 (protoc-bin-vendored crate, 별도 설치 불필요)

> 🇰🇷 Rust stable / Node.js 20 이상 / Python 3.10 이상 / protoc 는 빌드 시 자동 동봉.

### Installation

```bash
git clone https://github.com/JRs-Master/firebat.git
cd firebat
npm install
cargo build --release -p firebat-infra --bin firebat-core   # Rust Core 빌드
```

### Development

```bash
# Terminal 1: Rust Core gRPC server (port 50051)
cargo run --bin firebat-core

# Terminal 2: Next.js frontend
npm run dev
```

Open `http://localhost:3000/admin` for the admin console. Frontend 가 `RustCoreProxy` → gRPC :50051 로 자동 라우팅.

> 🇰🇷 Rust Core 와 Next.js 를 두 터미널에서 동시 실행. 어드민 콘솔: `http://localhost:3000/admin`. Frontend 가 `RustCoreProxy` 를 통해 자동으로 gRPC 50051 로 호출.

### Configuration

**First boot — SetupWizard** (vault 에 admin 자격증명 미설정 시 자동 표시):
1. Open `http://SERVER/login` → SetupWizard 화면
2. Interface language (ko/en) — navigator 자동 감지, 토글로 즉시 화면 전환
3. Admin ID + password (8 chars + 3 of upper/lower/digit/special, strength meter + match indicator)
4. Timezone (browser auto-detect, fallback UTC)
5. Submit → vault 저장 + 자동 로그인 → `/admin` 진입

**Subsequent settings** (어드민 진입 후):
1. **AI model**: Settings → AI tab → execution mode (API/CLI) → provider (OpenAI/Google/Anthropic) → model
   - **API mode**: Enter the provider API key (`sk-proj-…`, `AIza…`, `sk-ant-…`) or a Vertex Service Account JSON
   - **CLI mode**: Run `claude auth login` / `codex login` / `gemini auth login` on the server and click **"Check status"**
2. **Interface language**: Settings → General tab (ko/en toggle, also CMS siteLang free-form text for ja/zh-CN etc)
3. **Timezone**: Settings → General tab (35 IANA options, shared with SetupWizard via `lib/timezones.ts`)
4. **Admin credentials change**: Settings → General tab → 현재 비번 검증 (argon2 verify_admin_password RPC) + 새 비번 동일 정책
5. **MCP token**: Sidebar → SYSTEM → Firebat MCP Server → generate a bearer token for external AI clients

> 🇰🇷 **첫 부팅** — SetupWizard 가 자동 표시 (admin / 언어 / 시간대 입력 → 자동 로그인). **이후 설정** — AI 탭에서 모드·공급자·모델, 일반 탭에서 인터페이스 언어·타임존·관리자 계정 변경, 사이드바 SYSTEM 에서 MCP 토큰 생성.

### Production — Vultr systemd 2 unit + Caddy

Rust core (gRPC :50051 + MCP HTTP :50052) + Next.js standalone (:3000) — systemd 별도 unit 운영. Caddy 가 reverse proxy + Let's Encrypt 자동 TLS.

```bash
# 1. 디렉 구조 + source 영역 symlink (system + language 두 영역)
mkdir -p /opt/firebat/{data,user/media,frontend}
ln -sfn /opt/firebat-src/system /opt/firebat/system
ln -sfn /opt/firebat-src/language /opt/firebat/language

# 2. Python venv 의존 (E5 임베딩 모델 prefetch 용 — npm install postinstall 이 자동 사용)
sudo apt install python3-venv

# 3. Rust binary 배치 (GHA artifact 또는 `cargo build --release` 결과)
cp target/release/firebat-core /opt/firebat/firebat-core
chmod +x /opt/firebat/firebat-core

# 4. Next.js standalone build + 배치
cd /opt/firebat-src
npm install --legacy-peer-deps && npm run build
# ↑ postinstall 이 자동 실행 — E5 임베딩 모델 (~470MB) prefetch.
#   venv (<source root>/.venv) 자동 생성 + huggingface_hub 설치 + 모델 다운로드.
#   cache 가 생성된 이후 매 npm install 시점 즉시 skip.
#   skip: FIREBAT_SKIP_EMBEDDER_PREFETCH=1 또는 FIREBAT_EMBEDDER=stub
rsync -a .next/standalone/ /opt/firebat/frontend/
rsync -a .next/static/ /opt/firebat/frontend/.next/static/
rsync -a language/ /opt/firebat/frontend/language/

# 5. systemd unit 등록 (`/etc/systemd/system/firebat.service` + `firebat-frontend.service`)
systemctl daemon-reload
systemctl enable --now firebat firebat-frontend

# 6. Caddy reverse proxy (자동 HTTPS)
cp caddy/Caddyfile.example /etc/caddy/Caddyfile
# /etc/caddy/Caddyfile 안 your-domain.com / 이메일 실 값 치환 후
systemctl reload caddy
```

**Update flow** — `git pull && npm run build && rsync` (frontend) + binary FTP / `cargo build` (Rust 변경 시) + `systemctl restart firebat firebat-frontend`.

**System dependencies** (Vultr Debian 표준):
- `python3-venv` — E5 임베딩 모델 prefetch venv (PEP 668 정공)
- `python3` — sysmod (yfinance / playwright / etc) runtime + venv host
- Optional: `pipx install huggingface_hub` 설치한 경우 setup-embedder.mjs 가 시스템 PATH 의 `huggingface-cli` 자동 사용 (venv 생성 skip)

**Self-contained 패턴** — 매 의존성 (venv / sysmod python_modules / playwright_browsers / node_modules) 모두 Firebat workspace 안 격리. 사용자 home 영역 잔존 0 (예외: HuggingFace 모델 cache `~/.cache/huggingface/hub/`).

### MCP Server (Rust 단일 binary 안 통합)

```bash
# stdio mode — Claude Desktop / Cursor / 외부 AI client 진입
firebat-core --mcp-stdio

# HTTP mode (자동) — firebat-core 기동 시 :50052 자동 listen.
# /api/mcp (외부 AI) / /api/mcp-internal (CLI User AI) 모두 frontend 가 reverse proxy 처리.
```

---

## Project Structure

Phase B-4 cutover (2026-05-06) 후 — multi-crate Rust workspace (core / infra) + Next.js frontend.

```
firebat/                      # Cargo workspace root (Cargo.toml — members: core / infra)
├── core/                     # Rust crate — managers + services + ports (infra 의존 0건)
│   ├── Cargo.toml
│   ├── build.rs              #   tonic-build (proto/ → generated stubs)
│   └── src/
│       ├── lib.rs            #   crate root + proto module include
│       ├── ports.rs          #   16 Port traits
│       ├── capabilities.rs   #   Capability-Provider registry
│       ├── vault_keys.rs     #   Vault key constants
│       ├── tool_registry.rs  #   AiManager 의 정적 도구 등록
│       ├── task_executor_impl.rs
│       ├── managers/         #   21 domain managers (+ ai/ collaborator subfolder)
│       ├── services/         #   28 gRPC service impl
│       ├── utils/            #   path_resolve / sanitize / http_client / sysmod_cache 등
│       └── llm/config.rs     #   LlmModelConfig + builtin_models (UI 노출용 메타)
│
├── infra/                    # Rust crate — adapters + main binary (firebat → core 단방향 의존)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── main.rs           #   firebat-core binary (gRPC server :50051)
│       ├── adapters/         #   16 어댑터 (storage / vault / auth / log / database / sandbox / mcp_client / memory / cron / media / llm / embedder / image_gen / image_processor / tracing_log)
│       ├── llm/              #   ConfigDrivenAdapter + 8 format 핸들러 (5 API + 3 CLI)
│       └── image_gen/        #   ConfigDrivenImageGenAdapter + 3 format (openai-image / gemini-native-image / cli-codex-image)
│
├── proto/                    # gRPC schema (single source)
│   └── firebat.proto         #   28 services / 208 RPCs
│
├── app/                      # Next.js App Router (TS frontend)
│   ├── admin/                #   Admin console (chat, settings, editor)
│   │   └── hooks/            #     Frontend managers: Chat / Events / Settings
│   ├── (user)/               #   User-facing pages (dynamic render)
│   └── api/                  #   API routes (Primary Adapter — RustCoreProxy 경유)
│
├── lib/                      # TS frontend utilities
│   ├── singleton.ts          #   getCore() — RustCoreProxy thin wrapper (transparent cutover layer)
│   ├── rust-core-proxy.ts    #   ARGS_TABLE → callTypedClient() → @connectrpc typed client (Phase B-typed)
│   ├── grpc-typed-client.ts  #   28 service typed clients + METHOD_TABLE (protoc-gen-es 자동 생성 기반)
│   ├── proto-gen/            #   protoc-gen-es 산출 (firebat_pb.ts ~7268 LOC, gen:proto 으로 재생성)
│   ├── types/firebat-types.ts #  type-only 정의 (PageListItem / AuthSession / FirebatCore)
│   ├── auth-guard.ts         #   API route 인증 가드
│   ├── base-url.ts           #   BASE_URL + getBaseUrl(req)
│   ├── config.ts             #   SESSION_MAX_AGE_SECONDS / OAuth token expiry
│   └── events.ts             #   SSE 이벤트 버스
│
│   # Phase E (2026-05-12) — 옛 Node `mcp/` 디렉토리 전체 폐기. Rust 단일 binary 안 MCP server (axum) 가 대체.
│   # Frontend 의 `/api/mcp` / `/api/mcp-internal` route 는 127.0.0.1:50052 reverse proxy.
│
├── system/                   # System area (sandbox 모듈)
│   ├── services/             #   Config-only services (CMS, MCP server)
│   └── modules/              #   Built-in runnable modules (naver-search, naver-ads, korea-invest, kiwoom, upbit, kakao-talk, telegram, firecrawl, browser-scrape, law-search, ...)
│
├── user/                     # User area (modules, data)
│   └── modules/              #   User-created modules
│
├── docs/                     # Design documents (bibles)
│
└── data/                     # Runtime data (gitignored)
    ├── app.db                #   Pages / conversations DB
    ├── vault.db              #   Secret store
    ├── logs.db               #   sqlite ring buffer (admin log tab, last 5000)
    ├── log-filter.txt        #   Runtime tracing filter (SIGHUP reload)
    ├── cron-jobs.json        #   Persisted cron jobs
    └── logs/                 #   App logs + JSONL training data
```

---

## Roadmap — v1.0 Final

Single v1.0 Final milestone — **Rust Core + Next.js Frontend, Vultr systemd + Caddy 운영**. 본인 사용 안정성이 release gate.

**Target architecture**:

```
Frontend  Next.js + React + 27 render_* components
                          ↓
                RustCoreProxy → @connectrpc typed client → gRPC (Phase B-typed)
                          ↓
              Vultr VPS (systemd)
              ────────────────────
              Rust Core binary (gRPC :50051 + MCP HTTP :50052) — systemd unit `firebat`
              + Next.js standalone (:3000) — systemd unit `firebat-frontend`
              + Caddy (자동 TLS, :80/:443) — reverse proxy
```

**Phases**:

| Phase | Scope | 상태 |
|---|---|---|
| **A. Design** | gRPC schema (28 services / 208 RPCs) + Cargo workspace + tonic-build 통합 | ✅ 완료 |
| **B. Rust Core** | 16 adapters + 21 managers + 28 service impl + frontend RustCoreProxy + multi-crate workspace 분리 (core / infra). **Hardcoding audit 7-pattern** — no 1:1 mapping, every special-case fix promoted to general logic | ✅ 완료 (2026-05-06) |
| **B-LLM** | 5 LLM handler 본격 이식 (CLI 3종 + API 2종 + Vertex Service Account JWT) | ✅ 완료 (2026-05-10) |
| **B-typed** | 93 untyped RPC → typed Request message + protoc-gen-es 자동 생성 + 옛 proto-loader / @grpc/grpc-js 의존성 폐기 | ✅ 완료 (2026-05-12) |
| **E. MCP Rust cutover** | axum HTTP :50052 + stdio (`firebat-core --mcp-stdio`) + Node `mcp/` 디렉토리 / `@modelcontextprotocol/sdk` 의존성 완전 폐기 | ✅ 완료 (2026-05-12) |

**v1.0 Final release gate**:
- ✅ Rust Core cutover 완료
- ✅ 회귀 검증 그물 복원 (integration tests 331 pass)
- ✅ 5 LLM handler 본격 구현
- ✅ 93 RPC typed 정공 + 옛 proto-loader 폐기
- ✅ MCP Rust 단일 binary 통합
- 🟡 1+ week of personal use on Rust without incidents
- 🟡 자동매매 실측 시작

> 🇰🇷 **v1.0 Final 로드맵** — Rust Core + Next.js Frontend, Vultr systemd 2 unit + Caddy 자동 TLS. 본인 사용 안정성이 release gate. 자동매매 / 블로그 / 일상 사용 실측 1주+ 무사고 도달 시 v1.0 Final 출시. 외부 사용자 진입 / 멀티 distribution / 데스크톱 앱 같은 안건은 v2.0+ 영역.

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

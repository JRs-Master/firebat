# FIREBAT BIBLE — 헌법

> 최종 개정: 2026-05-06 (Phase B-4 cutover — 옛 TS 폐기, Rust 단일 backend 전환)

## 전문(前文)

본 문서는 Firebat의 **최고 등급 아키텍처 헌법**이다.
Firebat은 **AI-Powered Visual Automation Agent (VAA)** — 단독 서버(VPS)에서 동작하는 AI 기반 시각적 자동화 에이전트로, "만들기 + 운영 + 자동화"를 통합한다.
이 헌법에 명시된 원칙은 모든 코드, 모듈, 컴포넌트, 프롬프트 설계의 기준이 된다.

**🔥 Phase B-4 cutover (2026-05-06) — 정체성·원칙 그대로, 구현 backend 만 전환**: 옛 TS Core/Infra 폐기, Rust multi-crate workspace (`core/` + `infra/`) 로 단번 cutover 완료. Frontend 는 1년+ polished React 그대로. Hexagonal / 단독 점유 / DB-agnostic / 모듈 격리 / AI 자율 등 본 헌법의 모든 원칙은 Rust 위에서도 동일 적용. 코드 위치 매핑은 CORE_BIBLE / INFRA_BIBLE 첫머리 참조.

**운영 환경**: Vultr VPS systemd 2 unit (`firebat` Rust core + `firebat-frontend` Next.js standalone) + Caddy 자동 TLS reverse proxy. 단일 사용자 단일 서버. 외부 사용자 진입 / 멀티 distribution / 데스크톱 앱은 v2.0+ 영역.

---

## 제1장: 정체성 (Identity)

### 제1항. VAA — AI-Powered Visual Automation Agent
Firebat 의 카테고리는 **VAA (Visual Automation Agent)** — AI 를 엔진으로 쓰는 시각적 자동화 에이전트다.
대외 설명 문구: **"AI-Powered Visual Automation Agent"**. 내부 약어: **VAA**.

기존 카테고리 구분:
- **Agent (LangGraph/CrewAI 류)**: 추상 목표 → 자율 해결. 산출물은 주로 대화 로그.
- **Automation (n8n/Zapier)**: 사용자 정의 워크플로우 → 반복 실행. 코드 없이 비주얼 조립.
- **Builder (v0/Bolt/Lovable)**: AI 가 앱 생성. 일회성 산출물.

Firebat 은 이 세 축 교집합:
- **V (Visual)** — 결과물이 시각적. 페이지·차트·테이블·카드·PlanCard 등 약 29 render_* 컴포넌트.
- **A (Automation)** — 크론 스케줄러 + 파이프라인. 사용자 부재 중에도 반복 실행·외부 알림.
- **A (Agent)** — Function Calling 멀티턴 도구 루프. 사용자 한 마디에 AI 가 자율 도구 선택·실행.

"AI" 는 엔진(필수 재료)이고 "Automation Agent" 가 차별축(카테고리 정체성). 마케팅 문구에선 AI 함께 노출, 약어는 VAA 유지.

### 제2항. AI 에이전트의 베이스캠프
Firebat은 **AI가 시스템을 구축·디버깅·배포하기 위해 존재하는 언어 중립적 실행 운영체제(Execution OS)**다.
AI는 이 플랫폼 위에서 활동하는 '전속 개발자'이며, Firebat은 AI가 만들어낸 결과물이 시스템을 파괴하지 않도록 격리(Sandbox)하고 통제하는 '법률과 경찰'의 역할을 한다.

### 제3항. 단독 점유의 원칙 (Self-Hosted & Single-Node)
단일 리눅스 VPS에서 구동되는 것을 기준으로 한다. Vercel, AWS Lambda, Edge 등 서버리스/분산 환경은 배제한다.
영구 저장(Persistence)은 로컬 파일 시스템과 **로컬 SQLite**만을 유일한 진실의 원천으로 삼는다.

### 제4항. 궁극의 언어 중립성 (Universal Execution)
모듈은 JS, Python, PHP, Rust, WASM 등 어떤 언어로 작성되었든 `stdin/stdout` 상에서 JSON만 교환할 수 있다면 모두 적법한 실행 단위로 인정한다.

---

## 제2장: 계층과 권력 분립 (Separation of Powers)

### 제1항. Core (입법/사법 — 판결과 지휘)
순수 판결자이자 오케스트레이터. 사용자 코드를 직접 실행하지 않으며, JSON 스키마 검증과 포트 호출만 수행한다.
`core/` 디렉토리에 위치하며, I/O 라이브러리(`fs`, `child_process`, `fetch` 등)를 직접 import하지 않는다.

### 제2항. Infra (집행 — 격리 환경)
Core 포트(Port) 인터페이스의 구현체(Adapter)를 제공하는 중개자.
`infra/` 디렉토리에 위치하며, 시스템 내에서 유일하게 물리적 I/O를 수행할 수 있다.

### 제3항. App (UI — Primary Adapter)
`app/` 디렉토리의 Next.js App Router. HTTP 요청을 받아 Core에 전달하는 Primary Adapter.
비즈니스 로직을 포함하지 않으며, Core 메서드만 호출한다.

### 제3-2항. Frontend State Management — 3 매니저 통제 (2026-05-06 도입)
프론트엔드 UI 상태 전이는 **반드시 3개 매니저**로만 이루어진다 — 컴포넌트 내부에 복잡 상태 로직 추가 금지.
- **`app/admin/hooks/chat-manager.ts`** — 대화 / 메시지 / 입력 / SSE chunk 상태 (reducer + invariant 정의)
- **`app/admin/hooks/events-manager.ts`** — SSE event subscription / EventSource 단일 인스턴스 + refCount
- **`app/admin/hooks/settings-manager.ts`** — localStorage 영속 + cross-tab sync + typed schema
컴포넌트는 hook (`useChat` / `useEvents` / `useSetting`) 통해서만 상태 접근 — `useState` / `useReducer` 자체 사용 금지 (위 3 매니저 안에서만). 외부 상태 라이브러리 (Redux/Zustand/MobX) 도입 금지.

### 제3-3항. i18n — 자체 구현 (2026-05-10 도입)
다국어는 **자체 구현** (`lib/i18n.tsx` ~100 LOC, 의존성 0). `next-intl` / `react-intl` 같은 Next.js 종속 라이브러리 도입 금지 — v2.0 Tauri SPA / Vercel frontend hybrid 마이그레이션 자유 보장.
- **어드민 UI** = `useTranslations()` hook + `LangProvider` Context (ko/en 동적 토글, localStorage `firebat_ui_lang` + vault `system:ui-lang` sync)
- **공개 사이트** = `getServerTranslations(siteLang)` (RSC) + `usePublicTranslations()` (client). siteLang = CMS 의 free-form text (ko/en/ja/zh-CN 등)
- 메시지 = `language/ko.json` + `language/en.json` (categories: common / login / setup / admin_chat / settings / page / sidebar). nested key (`page.reading_time`) + `{count}` placeholder. 디렉토리명 `messages/` → `language/` rename (2026-05-13, commit `7892133`) — chat/LLM message 단어 충돌 회피.
- ICU MessageFormat / 복수형·성별 필요 시점에 next-intl 도입 검토. 그 전엔 자체 구현.

### 제4항. Module (확장 — 선언체)
AI가 생성하는 결과물. `user/modules/`(사용자 모듈)과 `system/modules/`(시스템 모듈)로 분리된다.
시스템 서비스는 `system/services/`에 위치한다 (SEO, MCP 서버 등 설정 전용).
모든 모듈/서비스는 `config.json`을 필수 포함하며, `type`(service/module)과 `scope`(system/user)로 구분한다.
모듈은 stdin/stdout JSON 프로토콜로 통신한다.

### 제5항. Admin 관제탑
관리자 콘솔(`/admin`)은 AI와 대화하고 시스템을 제어하는 인터페이스.
Next.js 어드민 / API route + Rust core (gRPC IPC) 분리 운영. Vultr systemd 2 unit + Caddy reverse proxy.

**첫 부팅 시 SetupWizard** (vault 미설정 시 자동, 2026-05-10 도입) — `/login` 진입 시 `core.isAdminSetup()` 응답 false 면 SetupWizard 표시 (admin ID + password + interface lang + timezone). 비번 정책: 8자 이상 + 대/소/숫자/특수 중 3종류 (NIST 모던 + 컴플라이언스 절충). argon2id hash 로 vault 저장. 자동 로그인 + `/admin` redirect.

**보안 패턴** (2026-05-10 도입):
- 비번 = argon2id hash (`core.set_admin_credentials` 가 vault 저장 시 자동 처리). 검증 = `verify_admin_password` RPC (login + SettingsModal 비번 변경 둘 다 사용 — login 부작용 없는 단독 검증).
- Cookie secure = `lib/cookie-helpers.ts::isHttpsRequest` 동적 판정 (X-Forwarded-Proto 우선, fallback req.url scheme). 옛 `secure: NODE_ENV==='production'` 정의로 HTTP 접속 시 cookie 미저장 buggy fix.
- proto envelope 자동 unwrap = `lib/rust-core-proxy.ts::autoUnwrapProtoEnvelope` 가 BoolRequest/StringRequest/NumberRequest 의 `{value: T}` → raw T. frontend 측 unwrap 코드 미작성 (단일 지점 처리).

---

## 제3장: 2-AI 구조 (Core AI & User AI)

### 제1항. User AI — 유일한 사용자 요청 처리자
`/admin` 채팅에서 모든 사용자 요청을 처리한다. 모듈·페이지 생성, 디버깅, 크론 설정, 질의응답 등 전담.
허용 구역(`app/(user)/`, `user/modules/`) 안에서만 창작하며, 시스템 파일은 수정할 수 없다.

### 제2항. Core AI — 순수 판단 함수 (v1+ 구현 예정)
시스템 내부 분석용. 눈도 없고 손발도 없다 — 결정론적 Core가 보여주는 정보만 볼 수 있으며, Core가 움직여 주어야만 결과가 실행된다. Firebat 자체를 수정하는 일은 절대 할 수 없다.

### 제3항. 실행 흐름
```
사용자 입력 → User AI (Plan 수립) → 결정론적 Core (검증) → Infra (실행) → 결과 → User AI → 사용자 응답
```

### 제4항. AI 시스템 프롬프트 외부화 + 다국어 통합 (2026-05-13 도입 / 2026-05-16 i18n 통합)
시스템 프롬프트 4개 (`tool_system` / `cron_agent` / `plan_mode_always` / `plan_mode_auto`) 는 `system/prompts/{name}/lang/{lang}.md` 외부 파일. 옛 `include_str!` 컴파일 시점 정적 포함 패턴 + `infra/data/prompts/*.md` 단일 한국어 영역 모두 폐기.

부팅 시점 `firebat_core::i18n::init` 가 `system/prompts/` 자동 scan → `prompt.{name}` namespace 안 cache (lang 별). PromptBuilder 가 매 build 시점 `i18n::prompt(name, None)` 직접 lookup — 사용자 lang task-local 자동 적용 (tonic interceptor 가 set). 매 prompt 가 ko / en 등 lang 별 자체 .md 보유, lookup 실패 시 server-side default lang fallback.

옛 `IPromptLoaderPort` trait + `FilePromptLoader` adapter 폐기 (2026-05-16) — core 가 i18n service 직접 사용, adapter wiring 0. .md 편집 후 systemctl restart 1회 필요 (i18n init 시점 cache). 사용자 프롬프트 (`system:user-prompt` Vault key) 는 runtime read 영역이라 외부화 미필요.

### 제5항. LLM 모델 + thinking JSON registry (2026-05-13 강화, 2026-05-17 위치 이동)
모델 + thinking 모드 단일 source = `system/llm/models.json` (옛 `infra/data/llm-models.json` 에서 이동 — system/ 디렉토리가 prompts / modules / llm 같은 영역의 일관된 부모):
- 26 모델 entry (Anthropic / Google / Vertex / OpenAI / CLI)
- 각 모델별 thinking 필드 — kind (reasoning / thinking / extendedThinking) + levels (i18n labels {ko, en})
- 새 모델 추가 = JSON 1 file 수정 + restart (Rust 재빌드 0). thinking 레벨 변경도 동일.
- frontend `useAiModels` hook 이 JSON entry 직접 read — 옛 `THINKING_LEVELS` / `getThinkingKind` types.ts hardcoded prefix 분기 통째 폐기.

---

## 제4장: JSON 교조주의 (Language Neutrality)

### 제1항. 절대적 통신 규약
모든 컴포넌트 간 통신은 **Firebat Canonical JSON** 형태로만 규정된다.
AI가 가장 잘 파싱하고 생성할 수 있는 형식이기 때문이다.

### 제2항. Plan-Execute 파이프라인
AI는 사용자 요청 수신 시 즉시 실행하지 않고, **실행 계획(Plan)**을 수립하여 사용자에게 보여준다.
사용자가 확인/수정한 후에야 단계별로 실행하며, 각 단계의 시작/완료/실패를 실시간으로 표시한다.

---

## 제5장: 쓰기 권한 격리 (Write Isolation)

### 제1항. 지정 구역 쓰기 원칙
AI가 파일을 생성/수정할 수 있는 구역은 `app/(user)/`, `user/modules/`뿐이다.
`core/`, `infra/`, `system/`, `app/admin/` 등 시스템 영역은 절대 금지.

### 제2항. CSS 격리 원칙
AI는 `app/globals.css`를 직접 수정할 수 없다. 커스텀 CSS가 필요한 경우 해당 앱 폴더 내에 `styles.module.css`를 생성한다.

### 제3항. 런타임 Sandbox 격리 (2026-05-06 도입)
sysmod / user module 의 자식 프로세스 spawn 시 OS 레벨 격리. 어댑터별 보장 수준:

| 어댑터 | 환경 | 격리 메커니즘 |
|---|---|---|
| **`LinuxCgroupsSandbox`** | Linux native (Vultr) — 운영 미사용 (sysmod libuv / encodings / CLONE_NEWNET 차단 이슈) | cgroup v2 (cpu.max 50% / memory.max 256MB / pids.max 64) + seccomp-bpf (~60+ syscall allow + default `Errno(EPERM)`) + network namespace (`unshare(CLONE_NEWNET)`) |
| **`BasicProcessSandbox`** | Windows / macOS / 미지원 OS | `tokio::process::Command` + path containment + timeout 만 (OS 격리 0) |

각 단계 (cgroup write / unshare / seccomp install) 실패 시 **silent graceful degrade** — 자식 spawn 자체는 성공 + tracing::warn. 셋 다 실패 시 `BasicProcessSandbox` 동등 동작.

### 제4항. Storage path traversal 방어 (2026-05-10 도입)
`infra/src/adapters/storage.rs::resolve_safe_path` — `is_absolute()` 거부 + `..` segment 거부 + `workspace_root.join(rel_path)` lexical normalize. **canonicalize() 미사용** — symlink 자동 풀어 self-hosted deploy 의 표준 패턴 (system/modules → src symlink) 이 workspace zone 밖 판정해 reject buggy. 옛 TS LocalStorageAdapter 의 path.resolve + isInsideZone 1:1 매칭. path traversal 방어 유지 + symlink 호환.

권한 부족 (non-root) 또는 kernel 미지원 (옛 커널) 시 격리 약화. 운영 환경 = `FIREBAT_SANDBOX=basic` 으로 BasicProcessSandbox 사용 (cgroups adapter 가 sysmod 호출 차단하는 이슈 우회). 운영자가 어드민 UI 의 `ISandboxPort.capabilities()` 검사 결과 (kind / fs_readonly / network_deny / cpu_limit_ms / memory_limit_mb / seccomp_filter / warning) 로 현재 격리 수준 확인 가능.

`os.system("rm -rf /")` 같은 destructive syscall 은 seccomp 가 EPERM 으로 차단. 단 path containment + workspace_root 안의 파일은 모듈이 정당하게 쓰기 가능.

향후 Wasmtime 도입 (~v1.x+, 모듈 재작성 필요) 또는 user namespace 본격 활성화 (multi-tenant SaaS 검토 시점) 시 격리 수준 ↑.

---

## 제6장: PageSpec과 Component 렌더링

### 제1항. 선언적 렌더링 원칙
AI는 React/TSX 코드를 직접 작성하지 않는다. PageSpec JSON 또는 채팅 블록으로 UI를 선언한다. 런타임에 `app/(user)/[slug]/page.tsx` 또는 채팅 렌더러가 해석하여 렌더링한다.

### 제2항. 상세 규약
PageSpec 스키마, 29개 빌트인 Component, 채팅 블록 시스템, StockChart 등 채팅 전용 컴포넌트, AI 도구 매핑 등 모든 렌더링 규약은 **`docs/PAGESPEC_BIBLE.md`** 참조.

### 제3항. slug 한글 허용
페이지 URL slug는 한글을 허용한다 (예: `/bmi-계산기`). 모듈 폴더/파일명은 영어 kebab-case.

---

## 제7장: 폴더 구조

> ⚠️ 아래는 옛 TS 시절 예시 — 현재 코어는 Rust (core/src, infra/src). 개념 참고용. `core/index.ts` / `boot.ts` / `*.ts` 경로는 historical 이며 실제 위치 매핑은 CORE_BIBLE / INFRA_BIBLE 첫머리 참조.

```
app/                    Next.js App Router
  admin/                관리자 콘솔 (AI 쓰기 금지)
  (user)/               AI 생성 페이지 렌더링
    [slug]/             동적 페이지 (force-dynamic SSR)
    layout.tsx          User 레이아웃 (SEO 스크립트 주입)
    seo-scripts.tsx     head/body 스크립트 DOM 주입
  api/                  API Routes (Primary Adapter)
  sitemap.xml/          Sitemap Index
  sitemap-posts.xml/    DB 포스트 사이트맵
  sitemap-pages.xml/    정적 페이지 사이트맵
  robots.ts             동적 robots.txt
  feed.xml/             RSS 2.0 피드
core/                   엔진 본체 (불가침 구역)
  index.ts              FirebatCore (Core Facade)
  ports/                22개 Port 인터페이스
  types/                FirebatAction, Plan 스키마
  managers/             23개 도메인 매니저 (AI, Storage, Page, Project, Module, Task, Schedule, Secret, MCP, Capability, Auth, Conversation, Media, Event, Status, Cost, Tool, Entity, Episodic, Consolidation, Template, Library, Hub)
    ai/                 AiManager 내부 collaborator (PromptBuilder / HistoryResolver / RetrievalEngine / ToolRouter / ToolDispatcher / ResultProcessor / tool_registry.rs)
infra/                  어댑터 레이어 (불가침 구역)
  boot.ts               어댑터 조립 팩토리 (20 어댑터)
  config.ts             공통 설정 상수
  storage/              IStoragePort + IVaultPort 구현
  llm/                  ILlmPort + IEmbedderPort 구현 (ConfigDrivenAdapter + 8 포맷 핸들러: API 5 + CLI 3)
  sandbox/              ISandboxPort 구현
  log/                  ILogPort 구현
  network/              INetworkPort 구현
  cron/                 ICronPort 구현
  database/             IDatabasePort 구현 (inline CREATE TABLE IF NOT EXISTS + inline ALTER, 별도 migration runner 없음)
  mcp-client/           IMcpClientPort 구현
  auth/                 IAuthPort 구현 (Vault 기반 세션/API 토큰)
  media/                IMediaPort 구현 (LocalMediaAdapter)
  image-processor/      IImageProcessorPort 구현 (image-rs + blurhash)
  entity/               IEntityPort 구현 (Recall — Entity tier)
  episodic/             IEpisodicPort 구현 (Recall — Episodic tier)
lib/                    Frontend 조합 (singleton.ts + grpc-typed-client.ts + proto-gen/)
                        Phase E (2026-05-12) — 옛 mcp/ 디렉토리 폐기. Rust 단일 binary 안 MCP server (infra/src/mcp_server.rs) 가 대체.
system/modules/         시스템 모듈 (읽기 전용)
user/modules/           사용자 모듈 (AI 쓰기 공간)
data/                   영구 저장소 (app.db, vault.db, logs/)
docs/                   바이블 및 기술 문서
```

---

## 제8장: MCP 연동

### 제1항. MCP 서버 (외부 AI → 파이어뱃) — Phase E (2026-05-12) Rust cutover
외부 AI 도구(Claude Code, Cursor 등)가 user 영역의 페이지/모듈을 CRUD할 수 있게 한다.
**Rust 단일 binary 안 통합** — `infra/src/mcp_server.rs` 의 axum HTTP server (:50052) + stdio transport.
- stdio 모드: `firebat-core --mcp-stdio` — Claude Desktop / Cursor 의 stdio 진입.
- HTTP 모드: `/api/mcp` (외부 AI, Bearer token 검증) / `/api/mcp-internal` (CLI User AI). Frontend route 는 `127.0.0.1:50052/mcp` reverse proxy.
MCP 서버는 Primary Adapter와 동급이며, Core 매니저만 호출한다. sysmod / render_* / 49 static + dynamic builtin 도구 자동 등록.
인증: Vault `system:internal-mcp-token` (내부 호출) + AuthManager API token (외부 사용자) 두 source 동시 검증.

### 제2항. MCP 클라이언트 (파이어뱃 → 외부 서비스)
외부 MCP 서버(Gmail, Slack 등)에 접속하여 도구를 호출한다.
AI가 `MCP_CALL` 액션으로 외부 서비스를 활용할 수 있다.
직접 API 연동 코드를 작성하지 않고, 기존 MCP 서버 생태계를 활용한다.

---

## 제9장: SEO 시스템 모듈

Vault `system:module:seo:settings`에 JSON으로 설정을 저장하며, 어드민 UI에서 편집한다.

| 기능 | 경로 | 설명 |
|---|---|---|
| Sitemap Index | `/sitemap.xml` | sitemap-posts.xml + sitemap-pages.xml 인덱스 |
| Posts Sitemap | `/sitemap-posts.xml` | DB 동적 포스트 사이트맵 |
| Pages Sitemap | `/sitemap-pages.xml` | 정적 페이지 사이트맵 |
| robots.txt | `/robots.txt` | SEO 설정에서 내용 편집, sitemap URL 자동 포함 |
| RSS Feed | `/feed.xml` | RSS 2.0 피드 (on/off 설정) |
| head 스크립트 | User 레이아웃 | Google Analytics, 메타 픽셀 등 `<head>` 삽입 |
| body 스크립트 | User 레이아웃 | 채팅 위젯, 트래킹 등 `</body>` 앞 삽입 |

---

## 제10장: 자동화 파이프라인

Firebat의 핵심 차별점: **"만들기 + 운영 + 자동화"**.

사용자가 "매일 아침 특정 데이터를 모아 메신저로 보내줘"라고 말하면:
1. AI가 모듈을 생성 (외부 API 호출 + 메신저 발송)
2. 크론을 등록 (`ICronPort`)
3. 외부 API 키를 Vault에 저장
4. MCP 클라이언트로 메신저 MCP 서버 호출
5. 매일 자동 실행

---

## 제11장: Recall · 회상(Retrieval) 시스템 (2026-05-04 도입)

CrewAI / Mem0 식 Recall · 회상(retrieval) 시스템 — 쓸수록 가치 폭발하는 핵심 인프라. (data/memory 의 Memory 기능과 별개 — 여기 "메모리"는 Recall·회상.)

### 제1항. 4-tier 구조

| Tier | 역할 | 구현 |
|---|---|---|
| **Short-term** | 진행 중 대화 turn | `ConversationManager` (기존) — `conversations` 테이블 + 임베딩 검색 |
| **Episodic** | 시간순 사건 (페이지 발행 / cron / 도구 호출 / 사용자 액션 등) | `EpisodicManager` (Phase 2) — `events` + `event_entities` m2m, occurred_at 정렬 |
| **Entity** | 추적 대상 (인물·프로젝트·이벤트·개념 등) + 그 단위 fact 누적 | `EntityManager` (Phase 1) — `entities` + `entity_facts`, semantic search, alias 통합 |
| **Contextual** | 4-tier 통합 검색 결과 | `RetrievalEngine` (Phase 5) — 매 user 발화 시 자동 `<RETRIEVED_CONTEXT>` 시스템 프롬프트 prepend |

### 제2항. 자동 누적 — 사용자 수동 0

- **자동 훅 (Episodic)**: Core facade 의 `savePage` / `handleCronTrigger` / `generateImage` 가 자동 `saveEvent` (BIBLE 일관성, 매니저 직접 호출 X).
- **Consolidation engine** (Phase 4): 6시간마다 비활성 대화 (1시간+ 미응답) → AI assistant 모델 (gpt-5.4-nano / gemini-3.1-flash-lite) 후처리 → entity / fact / event JSON 추출 → 자동 save. 비용 ~$0.001/대화.
- **중복 검출**: `dedupThreshold=0.92` cosine 유사도 — 같은 대화 여러 번 정리해도 자연 idempotent.

### 제3항. 자동 retrieve

매 user 발화 → `RetrievalEngine.retrieve(query)` → **5 source 병렬 검색** (search_history + searchEntities + searchEntityFacts + searchEvents + **Library RAG** — E5 dense + BM25/FTS5 sparse 하이브리드 + RRF) → 통합 `<RETRIEVED_CONTEXT>` 시스템 프롬프트 prepend. (Vault `system:ai-router:enabled` = AI Assistant 토글 ON 시)

AI 가 명시 도구 호출 안 해도 관련 entity/fact/event/자료 자동 컨텍스트 — "지난번 그건 어떻게 됐지?" 같은 질의에 즉시 답변. AI 능동 검색은 `search_history` / `search_library` 도구.

### 제4항. AI 명시 호출 도구 (자율 / 수동)

- `save_entity` / `save_entity_fact` / `search_entities` / `get_entity_timeline` / `search_entity_facts`
- `save_event` / `search_events` / `list_recent_events`
- `consolidate_conversation` (사용자 명시 / AI 자율)
- API + CLI MCP 양쪽 등록.

### 제5항. 어드민 UI

사이드바 "Recall" 탭 (Sparkles 아이콘) — Recall 어드민 UI:
- Sub-tab 엔티티 / 사건 토글
- Stats card (엔티티 / 사실 / 사건 총수)
- entity 클릭 → expand → timeline (facts) + 관련 사건 통합 표시
- 인라인 fact 추가 / entity 신규 모달 / 삭제 confirm
- 사이드바 대화 옆 "Recall 에 정리" 버튼 (Sparkles 아이콘) — `POST /api/consolidate`

### 제6항. 어댑터 swap (Phase 3 deferred)

현재 SQLite cosine search — 1만 row 까지 충분 (~50-100ms).
entity 1000+ 또는 fact 50000+ 누적 시점에 vector store 도입 검토 — `IEntityPort` / `IEpisodicPort` 인터페이스 그대로, 어댑터만 swap (sqlite-vec / Qdrant / pgvector 등).

### 제7항. 비용 통제 — Consolidation Budget Guard (2026-05-06 도입)

6시간 cron 의 Consolidation engine 이 LLM API 오류 / 환각 무한 재시도 시 토큰 폭주 위험 → 진짜 가드 추가:

- `ConsolidationAiHook.cost: Option<Arc<CostManager>>` 필드 (부팅 시 주입)
- `consolidate_conversation` 시작 시 `cost.check_budget()` 검사 → `within_budget==false` 시 즉시 skip + `tracing::warn`
- 한도 초과 사유 (daily/monthly USD / call count) + 사용자 timezone 기반 dateKey + alert_at_percent 지수 4종 모두 빠짐없이 검증

운영자가 어드민에서 일·월 USD / call 한도 설정 (Vault `system:cost:budget`) → cron 자동 호출 시 한도 초과 시 그 회 즉시 skip → 다음 6시간 사이클에 재시도. **백그라운드 무한 재시도 0**.

### 제8항. 데이터 보존 (Retention) — 자연 마찰 시점에 도입

현재 단일 사용자 단계엔 진짜 마찰 0 (1만 row 까지 충분). 본격 마찰 시점에 도입할 정책:
- **Short-term (대화)**: 30일+ 비활성 대화 자동 archive (cold storage) 또는 vacuum
- **Episodic (이벤트)**: 1년+ 지난 low-importance 이벤트 (`event_type='cron_trigger'` 등) 자동 정리. high-importance (transaction / publish) 영구 보존
- **Entity / Facts**: 보존 정책 X — 단순 누적 (semantic 가치 ↑)

운영 1년+ 시점에 마찰 발견 시 도입. 현재 압력 0.

---

## 제12장: 옵저버빌리티와 장애 복원력 (Observability & Resilience, 2026-05-06 도입)

Rust Core 전환의 핵심 운영 철학. Phase B-4 cutover 후 자연 도입:

### 제1항. 구조화 로깅 — `tracing` JSON

`infra/src/main.rs` 가 부팅 시 `tracing_subscriber` 초기화 — `RUST_LOG` env 로 레벨 + `FIREBAT_LOG_FORMAT=json` 으로 JSON 출력 토글:
- 모든 매니저 / 어댑터 가 `tracing::{info, warn, error, debug}` 매크로 사용
- 구조화 fields — `error = %e` / `cgroup = name` / `daily_used = 0.85` 등 query 가능 형태
- correlation ID — uuid v4 기반 (각 요청 / cron trigger / sandbox spawn 별 추적)
- production: systemd `journald` 가 stdout / stderr 캡처 → `journalctl -u firebat` 조회 + 디스크 회전 자동

옛 `console.log` 패턴 금지 — 모두 `tracing` 통과.

### 제2항. 에러 캡슐화 — `InfraResult<T>` Result 강제

Infra 계층 (어댑터) 의 절대 원칙:
- **throw 금지** — 모든 함수가 `InfraResult<T> = Result<T, String>` 반환
- I/O 실패 / DB 락 / 파싱 에러 / 권한 부족 모두 `Err(reason)` 으로 매니저에 전달
- 매니저가 결정 — 폴백 / retry / propagate
- 옛 TS 의 try/catch 누더기 패턴 → Rust `?` operator + `match` 로 명확 처리

검증: `Err(e) => { tracing::warn!(error = %e, "..."); fallback_path }` 패턴이 매니저 / 어댑터 일관.

### 제3항. 격리 실패 silent graceful degrade

Sandbox / cgroup / seccomp / namespace 적용 단계마다 실패 시 **자식 spawn 자체는 성공**:
- cgroup write 실패 → `tracing::warn` + namespace + seccomp 만 적용
- unshare 실패 → cgroup + seccomp 만
- seccomp install 실패 → cgroup + namespace 만
- 셋 다 실패 → BasicProcessSandbox 동등 동작 (path containment + timeout)

운영자가 어드민 UI 의 `ISandboxPort.capabilities()` 결과 확인 → 현재 격리 수준 가시화. 진짜 격리 약화 위험 시점 (예: kernel drift) 자동 발견.

### 제4항. systemd 무중단 + 메모리 폭주 방지

systemd unit 2개:
- `firebat-frontend.service` — Next.js (port 3000)
- `firebat.service` — Rust Core gRPC (port 50051) + MCP HTTP (port 50052)

운영 옵션:
- `Restart=always` — 크래시 시 자동 재시작
- `MemoryMax` / `MemoryHigh` — 메모리 leak 또는 candle 임베딩 폭주 시 자동 재시작
- `TimeoutStopSec=30` — graceful shutdown 시간 보장 (SQLite WAL flush + cron job 마무리)
- 단일 인스턴스 (BIBLE 단독 점유 원칙)

Rust binary 자체는 SIGTERM 받으면 `tokio::signal` 으로 graceful shutdown — 25초 활성 작업 대기 + Cost flush + DB close + cron task abort. systemd `TimeoutStopSec=30` 안에 자연 종료.

### 제5항. 시스템은 크래시 허용 — 관제는 지속

panic 또는 OOM 발생해도 systemd `Restart=always` 정책으로 자동 재시작 → 다음 cron trigger / 사용자 요청 정상 처리. 단:
- 매니저 코드 안 panic 금지 (어댑터 throw 0 정신과 같음)
- `unwrap_or_else(|p| p.into_inner())` 패턴으로 mutex poison 도 graceful 처리
- 진짜 panic 발생 시 (가설: 외부 lib bug) tracing capture → Telegram 또는 jsonl 기록 → 운영자 알림

크래시는 노이즈 0 가 아니라 **빠른 fail + 빠른 재시작 + 가시화** 가 BIBLE 의 운영 철학.

### 제6항. API 경계 에러 매핑 — gRPC ServiceError → HTTP (2026-05-07 도입)

Frontend ↔ Rust Core 사이는 gRPC. 시니어 audit 결과 도입한 정책:

- `lib/api-error.ts` — gRPC status code → HTTP status 표준 매핑 (UNAUTHENTICATED → 401 / NOT_FOUND → 404 / INVALID_ARGUMENT → 400 / DEADLINE_EXCEEDED → 504 / …)
- `lib/grpc-typed-client.ts:callTypedClient` — @connectrpc/connect-node typed client. ConnectError → `ApiError` 매핑 처리 (Phase B-typed cutover 후 옛 `lib/core-grpc-client.ts:invokeCore` layer 폐기)
- `lib/with-api-error.ts:withApiError(handler)` — Next.js API route wrapper. throw 된 ApiError → `toResponse()` 자동
- 메시지 redaction — `lib/redactor.ts` 통과 (token / API key / IP / email mask) + 240자 이내 (스택 trace / SQL / 긴 path leak 방어)
- 도입 demo: `app/api/capabilities/route.ts` + `app/api/module/run/route.ts` — 점진 sweep 가이드

내부 구조 (Rust panic / 파일 path / SQL) 외부 노출 0. 운영 중 Frontend 디버깅 시 status code + 한국어 친화 메시지 + console.error stack (서버 stderr 만) 분리.

---

## 제13장: 모듈 입출력 컨트랙트 강제 (2026-05-07 도입)

시니어 audit 결과 도입한 모듈 시스템 안전망. "Lego 스타일" 자유 조립이 가능하려면 모듈 I/O 가 극도로 예측 가능해야 함.

### 제1항. JSON Schema runtime validation

`system/modules/*/config.json` + `user/modules/*/config.json` 의 `input` / `output` 필드는 JSON Schema (Draft 7). `core/src/managers/module.rs:validate_value()` + `validate_module_definition()` (jsonschema crate 기반):
- `ModuleManager.run(name, args)` — sandbox spawn **전** input schema validation. 실패 시 `InfraResult::Err("[name] 입력 검증 실패: ...")` — 모듈이 받지 못함 (silent corruption 방어)
- spawn 후 output validation — config.output 정의되어 있으면 stdout JSON 검증. 실패 시 `tracing::warn!` (블로킹 X — 운영 중 발견용)
- schema 자체 형식 오류 (잘못된 `type` 값 등) 도 첫 줄에서 catch

### 제2항. Dry-run 사전 검증

`ModuleManager.dry_run(scope, name, args)` — sandbox spawn 안 함. config 자체 well-formedness + input schema validation 만:
- pipeline 등록 시점 호출 — EXECUTE step 의 모듈 호출이 schema 어긴 인자 받지 않게 가드
- `ScheduleManager.validate_pipeline()` 와 함께 — pipeline 등록 시점에 모든 step 의 정합성 검사

### 제3항. ModuleOutput envelope

`core/src/ports.rs::ModuleOutput.protocol_version` (default `"1.0"`) — 미래 break change 방어. 모듈이 새 envelope 도입 시 protocol_version 올림 → Core 가 명시 호환 검사 가능. 옛 모듈 (필드 미정의) 은 default 1.0 으로 silent passthrough.

### 제4항. 검증 실패 = 모듈 잘못 (운영자 책임)

검증 통과 못한 호출은 사용자에게 명시 에러 — 모듈이 묵묵히 잘못된 입력으로 실행되어 silent corruption 만드는 것보다 안전. 모듈 작성자가 config.json 의 input schema 정확히 정의하는 것이 contract.

---

## 제14장: 로드맵 — v1.0 Final

단일 v1.0 Final milestone — Rust Core + Next.js Frontend + Vultr systemd + Caddy 운영. 본인 사용 안정성이 release gate.

| 항목 | 현재 (v0.1) | v1.0 Final |
|---|---|---|
| **런타임** | Next.js 내 in-process | systemd 2 unit (Rust core + Next.js standalone) + Caddy reverse proxy (자동 TLS) |
| **Frontend** | Next.js + React + 29 render_* | **동일 — 1년+ polished 보존** |
| **Core 언어** | TypeScript | Rust (gRPC :50051 + MCP HTTP :50052, 단일 binary) |
| **JSON 검증** | Zod | Serde |
| **LLM** | Config-driven 멀티 프로바이더. API 5종 (openai-responses / anthropic-messages / gemini-native / vertex-gemini / openai-chat) + CLI 3종 (cli-claude-code / cli-codex / cli-gemini). 새 모델 = JSON config 추가만 | 동일 패턴 Rust 재구현 (reqwest + tokio::process) |
| **모듈 실행** | 자식 프로세스 + `__updateSecrets` 영속 | tokio::process::Command — 모듈 코드 0 변경 (Node / Python sysmod 그대로). BasicProcessSandbox (path containment + timeout) |
| **어댑터** | `infra/` 내 17개 어댑터 | `infra/src/adapters/` 20개 운영 어댑터 (Phase B-4 cutover 후 multi-crate workspace) |
| **변환 룰** | — | **1:1 매핑 X**. 매 매니저 / 어댑터 변환 시 hardcoding audit (defensive regex / 도구명 enum / magic number / 개별 sanitize / 모델별 분기 / timezone hardcode / error message 매칭 7가지 패턴) — 일반 로직으로 정리 |
| **인증** | IAuthPort + AuthManager (세션 토큰 + API 토큰 통합) | 동일 (Rust 재구현) |
| **MCP** | Node mcp/ 디렉토리 (외부 + internal) | Rust 단일 binary 안 axum HTTP :50052 + stdio (`firebat-core --mcp-stdio`) 통합 |
| **자동 update** | — | `git pull && cargo build && npm run build && rsync && systemctl restart` |

### Phase 분해

| Phase | 작업 | 상태 |
|---|---|---|
| A. 설계 | gRPC schema + Cargo workspace + tonic-build 통합 | ✅ 완료 |
| B. Rust Core 구현 | 20 어댑터 + 23 매니저 + 31 gRPC service + frontend RustCoreProxy + multi-crate workspace 분리. **hardcoding audit 7-pattern** | ✅ 완료 (2026-05-06) |
| B-LLM | 5 LLM handler 본격 이식 (CLI 3종 + API 2종 + Vertex JWT) | ✅ 완료 (2026-05-10) |
| B-typed | 93 untyped RPC → typed Request message + protoc-gen-es 자동 생성 + 옛 proto-loader / @grpc/grpc-js 의존성 폐기 | ✅ 완료 (2026-05-12) |
| E. MCP Rust cutover | axum HTTP + stdio + Node mcp/ 디렉토리 / @modelcontextprotocol/sdk 의존성 완전 폐기 | ✅ 완료 (2026-05-12) |

**v1.0 Final 출시 게이트**:
- ✅ Rust Core 단번 cutover 완료 (Phase B-4)
- ✅ 회귀 검증 그물 복원 (integration tests 331 pass)
- ✅ 5 LLM handler 본격 구현 (Phase B-LLM)
- ✅ 93 RPC typed 정공 (Phase B-typed)
- ✅ MCP Rust 단일 binary 통합 (Phase E)
- 🟡 본인 사용 1주+ 무사고 (Rust 위)
- 🟡 실사용 안정화 측정 시작

### Core 어댑터 언어 정책 (영구 룰)

Phase B 변환 시 + v1.0 Final 출시 후에도 영구 적용. BIBLE 제2장 "언어 중립성" 의 Core 어댑터 layer 적용:

| 룰 | 적용 |
|---|---|
| **룰 1. Rust 무조건 장점 → Rust 강제** | Hot path / 보안 / 정밀 timing / 단일 binary 영역 — Database / Vault / Cron / Auth / 매니저 logic / MCP / LLM (API + CLI streaming) / Sandbox / Network / Log |
| **룰 2. Trade-off → 좋은 라이브러리 활용** | 시점별 best 선택. Image (sharp via Node bridge ↔ image-rs) / 로컬 임베딩 (onnxruntime-node ↔ ort) / Playwright (Node spawn 자연) |
| **룰 3. Hexagonal 보장** | 어댑터 안 라이브러리 / 언어 변경이 매니저·Frontend 영향 0. Port interface 안정성 = 영구 진화 가능 |

### v1.0 Final 출시 후 (v2.0+)

운영 데이터 위에서 진짜 한계 마찰 도달 시만 시작:
- **Vercel frontend + Self-hosted backend exe** (hybrid Self-installed 부활, 2026-05-10 도입 검토 v1.x 안건) — Frontend = `firebat.app` (Vercel 자동 배포, 사용자 빌드 0) + Backend = 사용자 머신 exe (Rust 단일 binary ~30-50MB). UPnP 자동 포트 매핑 + 공유기 DDNS + Let's Encrypt + Cloudflare Tunnel fallback 으로 사용자 conscious effort 0. v1.x Vercel frontend 분산 작업과 자연 통합. 옛 Self-installed Tauri 폐기 사유 (Tauri+Node sidecar 무게 + 어르신 UX 폭탄) 와 무관 — frontend 분리라 본질적으로 다른 패턴.
- **Self-installed Tauri 재시작** — Next.js Static Export (SPA 모드) + Tauri IPC (invoke command) 통합한 진짜 가벼운 데스크톱 앱 (~15MB). 옛 Node sidecar 폭탄 패턴 폐기. 위 hybrid 와 별개 — 오프라인 / air-gapped 환경의 일부 사용자 시나리오 대상.
- **Vercel frontend 분산** (지역 분산 도달 시) — 위 hybrid 의 자연 전제
- **Core AI 파인튜닝** (삼위일체 AI 자기진화)
- **모듈 패키징 개편** / 시스템 모듈 동적 로드
- **Sandbox 보안 강화** — Wasmtime / gVisor 같은 진짜 VM-수준 격리 (multi-tenant SaaS 검토 시점)
- **Trade-off 영역의 라이브러리 swap** (Rust ecosystem 성숙 시 자연 진화)

---

본 문서는 Firebat을 설계하는 뼈대이며, 이하의 모든 코딩 과정에 절대적인 기준으로 작용한다.

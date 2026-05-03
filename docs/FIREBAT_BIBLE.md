# FIREBAT BIBLE — 헌법

> 최종 개정: 2026-04-22 (v0.1)

## 전문(前文)

본 문서는 Firebat의 **최고 등급 아키텍처 헌법**이다.
Firebat은 **AI-Powered Visual Automation Agent (VAA)** — 단독 서버(VPS)에서 동작하는 AI 기반 시각적 자동화 에이전트로, "만들기 + 운영 + 자동화"를 통합한다.
이 헌법에 명시된 원칙은 모든 코드, 모듈, 컴포넌트, 프롬프트 설계의 기준이 된다.

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
- **V (Visual)** — 결과물이 시각적. 페이지·차트·테이블·카드·PlanCard 등 20여 render_* 컴포넌트.
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

### 제4항. Module (확장 — 선언체)
AI가 생성하는 결과물. `user/modules/`(사용자 모듈)과 `system/modules/`(시스템 모듈)로 분리된다.
시스템 서비스는 `system/services/`에 위치한다 (SEO, MCP 서버 등 설정 전용).
모든 모듈/서비스는 `config.json`을 필수 포함하며, `type`(service/module)과 `scope`(system/user)로 구분한다.
모듈은 stdin/stdout JSON 프로토콜로 통신한다.

### 제5항. Admin 관제탑
관리자 콘솔(`/admin`)은 AI와 대화하고 시스템을 제어하는 인터페이스.
v0.1 에서는 Next.js 내부에 동거하며, v1.0 Final 에서 분리 — self-hosted 는 Docker compose 의 별 컨테이너 + gRPC IPC, self-installed 는 Tauri 안에 Rust Core in-process embed + Node sidecar 로 Next.js 띄움.

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

---

## 제6장: PageSpec과 Component 렌더링

### 제1항. 선언적 렌더링 원칙
AI는 React/TSX 코드를 직접 작성하지 않는다. PageSpec JSON 또는 채팅 블록으로 UI를 선언한다. 런타임에 `app/(user)/[slug]/page.tsx` 또는 채팅 렌더러가 해석하여 렌더링한다.

### 제2항. 상세 규약
PageSpec 스키마, 27개 빌트인 Component, 채팅 블록 시스템, StockChart 등 채팅 전용 컴포넌트, AI 도구 매핑 등 모든 렌더링 규약은 **`docs/PAGESPEC_BIBLE.md`** 참조.

### 제3항. slug 한글 허용
페이지 URL slug는 한글을 허용한다 (예: `/bmi-계산기`). 모듈 폴더/파일명은 영어 kebab-case.

---

## 제7장: 폴더 구조

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
  ports/                17개 Port 인터페이스 + ToolRouterFactory
  types/                FirebatAction, Plan 스키마
  managers/             21개 도메인 매니저 (AI, Storage, Page, Project, Module, Task, Schedule, Secret, MCP, Capability, Auth, Conversation, Media, Event, Status, Cost, Tool, Entity, Episodic, Consolidation)
    ai/                 AiManager 내부 collaborator (PromptBuilder / HistoryResolver / RetrievalEngine / ToolRouter / ToolDispatcher / ResultProcessor / tool-schemas)
infra/                  어댑터 레이어 (불가침 구역)
  boot.ts               어댑터 조립 팩토리 (17 어댑터)
  config.ts             공통 설정 상수
  storage/              IStoragePort + IVaultPort 구현
  llm/                  ILlmPort + IEmbedderPort + IToolRouterPort 구현 (ConfigDrivenAdapter + 8 포맷 핸들러: API 5 + CLI 3)
  sandbox/              ISandboxPort 구현
  log/                  ILogPort 구현
  network/              INetworkPort 구현
  cron/                 ICronPort 구현
  database/             IDatabasePort + migration runner (v1 baseline + v2 entity-memory + v3 episodic-memory)
  mcp-client/           IMcpClientPort 구현
  auth/                 IAuthPort 구현 (Vault 기반 세션/API 토큰)
  media/                IMediaPort 구현 (LocalMediaAdapter)
  image-processor/      IImageProcessorPort 구현 (sharp + blurhash)
  entity/               IEntityPort 구현 (메모리 시스템 Entity tier)
  episodic/             IEpisodicPort 구현 (메모리 시스템 Episodic tier)
lib/                    Core+Infra 조합 (singleton.ts)
mcp/                    MCP 서버 (외부 AI → 파이어뱃)
system/modules/         시스템 모듈 (읽기 전용)
user/modules/           사용자 모듈 (AI 쓰기 공간)
data/                   영구 저장소 (app.db, vault.db, logs/)
docs/                   바이블 및 기술 문서
```

---

## 제8장: MCP 연동

### 제1항. MCP 서버 (외부 AI → 파이어뱃)
외부 AI 도구(Claude Code, Cursor 등)가 user 영역의 페이지/모듈을 CRUD할 수 있게 한다.
stdio 모드(`npx tsx mcp/stdio.ts`)와 Streamable HTTP 모드(`/api/mcp`)를 지원한다.
MCP 서버는 Primary Adapter와 동급이며, Core 메서드만 호출한다.
CLI 모드 User AI는 별도 전용 stdio 진입점(`mcp/stdio-user-ai.ts` → `internal-server.ts`)을 통해 내부 도구 세트를 노출한다.

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

사용자가 "매일 10시에 관심종목 주가 조회해서 카톡으로 보내줘"라고 말하면:
1. AI가 모듈을 생성 (증권 API 호출 + 카톡 발송)
2. 크론을 등록 (`ICronPort`)
3. 외부 API 키를 Vault에 저장
4. MCP 클라이언트로 카톡 MCP 서버 호출
5. 매일 자동 실행

---

## 제11장: 메모리 시스템 4-tier (2026-05-04 박힘)

CrewAI / Mem0 식 4-tier 메모리 — 자동매매·블로그 운영 깊어질수록 가치 폭발하는 핵심 인프라.

### 제1항. 4-tier 구조

| Tier | 역할 | 구현 |
|---|---|---|
| **Short-term** | 진행 중 대화 turn | `ConversationManager` (기존) — `conversations` 테이블 + 임베딩 검색 |
| **Episodic** | 시간순 사건 (자동매매 실행 / 페이지 발행 / cron / 도구 호출 / 사용자 액션) | `EpisodicManager` (Phase 2) — `events` + `event_entities` m2m, occurred_at 정렬 |
| **Entity** | 추적 대상 (종목·인물·프로젝트·이벤트·개념) + 그 단위 fact 누적 | `EntityManager` (Phase 1) — `entities` + `entity_facts`, semantic search, alias 통합 |
| **Contextual** | 4-tier 통합 검색 결과 | `RetrievalEngine` (Phase 5) — 매 user 발화 시 자동 `<MEMORY_CONTEXT>` 시스템 프롬프트 prepend |

### 제2항. 자동 누적 — 사용자 수동 0

- **자동 훅 (Episodic)**: Core facade 의 `savePage` / `handleCronTrigger` / `generateImage` 가 자동 `saveEvent` (BIBLE 일관성, 매니저 직접 호출 X).
- **Consolidation engine** (Phase 4): 6시간마다 비활성 대화 (1시간+ 미응답) → AI assistant 모델 (gpt-5-nano / gemini-flash-lite) 후처리 → entity / fact / event JSON 추출 → 자동 save. 비용 ~$0.001/대화.
- **중복 검출**: `dedupThreshold=0.92` cosine 유사도 — 같은 대화 여러 번 정리해도 자연 idempotent.

### 제3항. 자동 retrieve

매 user 발화 → `RetrievalEngine.retrieve(query)` → 4 source 병렬 검색 (search_history + searchEntities + searchEntityFacts + searchEvents) → 통합 `<MEMORY_CONTEXT>` 시스템 프롬프트 prepend.

AI 가 명시 도구 호출 안 해도 관련 entity/fact/event 자동 컨텍스트 — "삼성전자 어떻게 됐지?" 같은 질의에 즉시 답변.

### 제4항. AI 명시 호출 도구 (자율 / 수동)

- `save_entity` / `save_entity_fact` / `search_entities` / `get_entity_timeline` / `search_entity_facts`
- `save_event` / `search_events` / `list_recent_events`
- `consolidate_conversation` (사용자 명시 / AI 자율)
- API + CLI MCP 양쪽 등록.

### 제5항. 어드민 UI

사이드바 "Recall" 탭 (Sparkles 아이콘) — 메모리 시스템의 어드민 UI:
- Sub-tab 엔티티 / 사건 토글
- Stats card (엔티티 / 사실 / 사건 총수)
- entity 클릭 → expand → timeline (facts) + 관련 사건 통합 표시
- 인라인 fact 추가 / entity 신규 모달 / 삭제 confirm
- 사이드바 대화 옆 "Recall 에 정리" 버튼 (Sparkles 아이콘) — `POST /api/consolidate`

### 제6항. 어댑터 swap (Phase 3 deferred)

현재 SQLite cosine search — 1만 row 까지 충분 (~50-100ms).
entity 1000+ 또는 fact 50000+ 누적 시점에 vector store 도입 검토 — `IEntityPort` / `IEpisodicPort` 인터페이스 그대로, 어댑터만 swap (sqlite-vec / Qdrant / pgvector 등).

---

## 제12장: 로드맵 — v1.0 Final (2026-05-03 확정)

옛 v0.x → v1.0 RC → v1.x → v2.0 phase 분해 폐기. 단일 v1.0 Final milestone 으로 통합.

**v1.0 Final 비전**: Rust Core + Next.js Frontend + 두 distribution (self-hosted Docker / self-installed Tauri).

| 항목 | 현재 (v0.1) | v1.0 Final |
|---|---|---|
| **런타임 (self-hosted)** | Next.js 내 in-process | Docker compose: Core / Renderer 2 컨테이너 + nginx (gRPC :50051) |
| **런타임 (self-installed)** | 미존재 | Tauri shell + Rust Core in-process embed + Node sidecar (Next.js) + LLM CLI 첫 실행 자동 install (시스템 격리) |
| **Frontend** | Next.js + React + 22 render_* | **동일 — 1년+ polished 보존** |
| **Core 언어** | TypeScript | Rust (gRPC server + Tauri lib 두 build target) |
| **JSON 검증** | Zod | Serde |
| **LLM** | Config-driven 멀티 프로바이더. API 5종 (openai-responses / anthropic-messages / gemini-native / vertex-gemini / openai-chat) + CLI 3종 (cli-claude-code / cli-codex / cli-gemini). 새 모델 = JSON config 추가만 | 동일 패턴 Rust 재구현 (reqwest + tokio::process) |
| **모듈 실행** | 자식 프로세스 + `__updateSecrets` 영속 | tokio::process::Command — 모듈 코드 0 변경 (Node / Python sysmod 그대로) |
| **어댑터** | `infra/` 내 17개 어댑터 | `core/adapters/` 17개 — DB(rusqlite) / Cron(cron crate) / LLM(reqwest) / Image(image-rs) / Sandbox(tokio::process) |
| **변환 룰** | — | **1:1 매핑 X**. 매 매니저 / 어댑터 변환 시 hardcoding audit (defensive regex / 도구명 enum / magic number / 개별 sanitize / 모델별 분기 / timezone hardcode / error message 매칭 7가지 패턴) — 일반 로직으로 정리 |
| **인증** | IAuthPort + AuthManager (세션 토큰 + API 토큰 통합) | 동일 (Rust 재구현) |
| **자동 update** | — | Tauri Updater + GitHub Actions (3 OS build) — git tag push 시 사용자 PC 자동 update |

### Phase 분해

| Phase | 작업 | 기간 |
|---|---|---|
| 0. 현재 | firebat.co.kr 옛 build 안정 운영. 큰 변경 X. 자동매매 / 블로그 등 새 use case 보류 — Rust 위에서 시작 | ongoing |
| A. 설계 | gRPC schema + lib/core-client.ts abstraction + Cargo workspace + Tauri config + dual-run framework | 1~2주 |
| B. Rust Core 구현 | 17 어댑터 + 21 매니저 + gRPC server + Frontend abstraction + dual-run 검증. **hardcoding audit 동시** | 3~4개월 |
| C. self-hosted Docker | Multi-stage Dockerfile + docker-compose + nginx + Vault 마이그레이션 | 1~2주 |
| D. self-installed Tauri | src-tauri shell + 첫 실행 setup (Node/Python/LLM CLI 자동 install, Firebat 폴더 격리) + 자동 update pipeline | 1~2주 |

**v1.0 Final 출시 게이트**:
- Rust Core dual-run 1~2주 무사고 (옛 Node 와 결과 일치)
- self-hosted / self-installed 3 OS 동작 검증
- 본인 사용 1주+ 무사고 (Rust 위)
- → 자동매매 / 블로그 새 use case Rust 위에서 시작 가능

총 4~5개월 (1인 full-time).

### v1.0 Final 출시 후 (v2.0+)

운영 데이터 위에서 진짜 한계 마찰 도달 시만 시작:
- Frontend 정적 마이그레이션 (10MB Tauri)
- Vercel frontend 분산 (지역 분산 도달 시)
- Core AI 파인튜닝 (삼위일체 AI 자기진화)
- 모듈 패키징 개편 / 시스템 모듈 동적 로드

---

본 문서는 Firebat을 설계하는 뼈대이며, 이하의 모든 코딩 과정에 절대적인 기준으로 작용한다.

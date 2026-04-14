<p align="center">
  <img src="app/icon.svg" width="80" alt="Firebat Logo" />
</p>

<h1 align="center">Firebat</h1>

<p align="center">
  <em>Just Imagine. Firebat Runs.</em>
</p>

<p align="center">
  Self-hosted AI workspace with web UI that builds, runs, and automates from a single prompt.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs" alt="Next.js" />
  <img src="https://img.shields.io/badge/TypeScript-6-blue?logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Gemini-Flash-4285F4?logo=google" alt="Gemini" />
  <img src="https://img.shields.io/badge/MCP-1.29-purple" alt="MCP" />
  <img src="https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite" alt="SQLite" />
  <img src="https://img.shields.io/badge/License-Private-red" alt="License" />
</p>

---

## What is Firebat?

Firebat은 **대화 한 마디로 웹 앱을 만들고, 자동화하고, 운영하는** 개인 설치형 AI 플랫폼입니다.

```
"날씨 앱 만들어줘" → AI가 코드 작성 → 페이지 배포 → 크론으로 매시간 업데이트 → 카톡으로 알림
```

하나의 프롬프트가 **설계 → 구현 → 배포 → 스케줄링 → 알림**까지 관통합니다.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    app/api/  (Primary Adapter)        │
│              Next.js Route Handlers · Auth            │
├──────────────────────────────────────────────────────┤
│                                                      │
│   ┌──────────────────────────────────────────────┐   │
│   │              FirebatCore (Facade)             │   │
│   │                                              │   │
│   │  AI · Storage · Page · Project · Module      │   │
│   │  Schedule · Secret · MCP · Capability        │   │
│   │              9 Managers                       │   │
│   └──────────────┬───────────────────────────────┘   │
│                  │ Ports (Interface)                  │
│   ┌──────────────┴───────────────────────────────┐   │
│   │              infra/  (Adapters)               │   │
│   │                                              │   │
│   │  Storage · Log · Sandbox · LLM · Network     │   │
│   │  Cron · Database · Vault · MCP Client        │   │
│   │              9 Adapters                       │   │
│   └──────────────────────────────────────────────┘   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Hexagonal Architecture** — Core는 순수 비즈니스 로직만 담당하고, 모든 I/O는 Infra 어댑터가 처리합니다.

| 원칙 | 설명 |
|---|---|
| **Core 순수성** | `fs`, `fetch`, DB 라이브러리 등 I/O를 Core에서 직접 호출하지 않음 |
| **Port & Adapter** | 9개 인터페이스(Port)를 통해서만 Infra와 통신 |
| **에러 캡슐화** | Infra는 절대 throw하지 않고, `InfraResult<T>`로 반환 |
| **Facade 패턴** | 모든 API route는 `getCore()` 싱글톤을 통해서만 접근 |

---

## Features

### AI Plan-Execute Pipeline

```
사용자 프롬프트
    ↓
[Planning] LLM이 FirebatPlan(JSON) 수립
    ↓
[Validation] Zod 스키마 검증 (실패 시 3회 재시도)
    ↓
[Execution] actions 배열 순회 → 포트 호출
    ↓
[Report] 결과 로깅 + 프론트엔드 SSE 스트리밍
```

- **2단계 앱 생성**: 설계 먼저 보여주고, 확인 후 구현
- **15가지 액션**: 파일 CRUD, 페이지 관리, 모듈 실행, 스케줄링, 시크릿, MCP 호출
- **자동/수동 실행 정책**: 되돌리기 어려운 작업은 확인 요청, 나머지는 자동 실행

### Scheduling & Automation

- **3가지 모드**: 반복(cron), 1회 예약(runAt), 딜레이(delaySec)
- **파이프라인**: MCP 조회 → LLM 요약 → 모듈 발송 같은 복합 작업을 사전 컴파일
- **4가지 파이프라인 단계**: `TEST_RUN`, `MCP_CALL`, `NETWORK_REQUEST`, `LLM_TRANSFORM`
- **영속 저장**: PM2 재시작 시 자동 복원
- **동적 타임존**: 설정에서 변경 가능

### MCP (Model Context Protocol)

**MCP 서버** — 외부 AI 도구가 Firebat을 조작

| 모드 | 용도 | 인증 |
|---|---|---|
| **stdio** | Claude Code, Cursor 등 로컬 AI | SSH 키 |
| **Streamable HTTP** | VS Code, Antigravity 등 원격 연결 | Bearer 토큰 |

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

18개 도구 제공: 페이지 CRUD, 파일 CRUD, 모듈 실행, 프로젝트 관리, 크론 관리, MCP 도구 호출 등

**MCP 클라이언트** — Firebat이 외부 MCP 서버를 호출
- Gmail, Slack, 카카오톡 등 외부 서비스 연동
- AI가 자동으로 도구를 인식하고 호출

### Sandbox Execution

- **언어 중립**: Python, JavaScript, PHP, Rust, WASM, Shell
- **자동 패키지 설치**: `config.json`의 `packages` 필드에서 의존성 자동 설치
- **시크릿 주입**: Vault에서 API 키 조회 → 환경변수로 격리 전달 (AI는 키 값을 모름)
- **타임아웃**: 30초

### 22 Built-in Components

PageSpec JSON으로 정의하면 자동 렌더링:

`Hero` · `Text` · `Card` · `Grid` · `Form` · `Image` · `Button` · `Table` · `Html` · `Divider` · `Header` · `Footer` · `Slider` · `Tabs` · `Accordion` · `Progress` · `Badge` · `Alert` · `List` · `Carousel` · `Countdown` · `Chart`

### Capability-Provider System

같은 기능을 수행하는 여러 모듈을 묶고 우선순위/폴백 관리:

| Capability | Providers |
|---|---|
| `web-scrape` | browser-scrape (local), jina-reader (api) |
| `notification` | kakao-talk (api) |
| `email-send` | (등록 대기) |
| `image-gen` | (등록 대기) |

실행 모드: `api-first` · `local-first` · `api-only` · `local-only` · `manual`

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 16 (App Router, Turbopack) |
| **Language** | TypeScript 6 |
| **Styling** | Tailwind CSS 4 |
| **AI** | Google Gemini (Vertex AI Express) |
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
- Python 3.10+ (모듈 샌드박스용)

### Installation

```bash
git clone https://github.com/your-org/firebat.git
cd firebat
npm install
```

### Development

```bash
npm run dev
```

`http://localhost:3000/admin`에서 어드민 페이지에 접속합니다.

### Configuration

1. **AI 모델**: 설정 > API 키 탭에서 Vertex AI API Key 등록
2. **타임존**: 설정 > 일반 탭에서 변경 (기본: Asia/Seoul)
3. **MCP 토큰**: 설정 > MCP 탭에서 토큰 생성 (API 연결용)

### Production

```bash
npm run build
pm2 start npm --name firebat -- start
```

### MCP Server

```bash
# stdio 모드 (로컬)
npm run mcp

# API 모드 — 설정에서 토큰 생성 후 /api/mcp 엔드포인트 사용
```

---

## Project Structure

```
firebat/
├── core/                    # 순수 비즈니스 로직 (I/O 없음)
│   ├── index.ts             #   FirebatCore Facade
│   ├── ports/               #   9개 Port 인터페이스
│   ├── managers/            #   9개 도메인 매니저
│   ├── types/               #   FirebatPlan, FirebatAction
│   └── capabilities.ts      #   Capability-Provider Registry
│
├── infra/                   # I/O 실행 계층 (어댑터)
│   ├── boot.ts              #   인프라 싱글톤 조립
│   ├── config.ts            #   설정 상수 중앙 관리
│   ├── storage/             #   파일 시스템 + Vault
│   ├── llm/                 #   Vertex AI 어댑터
│   ├── sandbox/             #   프로세스 샌드박스
│   ├── cron/                #   node-cron 스케줄러
│   ├── database/            #   SQLite 어댑터
│   ├── log/                 #   4레벨 로깅 + JSONL
│   ├── network/             #   HTTP 통신 (SSRF 방어)
│   └── mcp-client/          #   외부 MCP 서버 접속
│
├── app/                     # Next.js App Router
│   ├── admin/               #   어드민 페이지 (채팅, 설정, 에디터)
│   ├── (user)/              #   사용자 페이지 (동적 렌더링)
│   └── api/                 #   API 라우트 (Primary Adapter)
│
├── mcp/                     # MCP 서버 (stdio + Streamable HTTP)
│   ├── server.ts            #   도구 정의
│   └── stdio.ts             #   stdio 진입점
│
├── lib/                     # 유틸리티
│   ├── singleton.ts          #   Core 싱글톤 팩토리
│   └── events.ts            #   SSE EventBus
│
├── system/                  # 시스템 모듈
│   ├── guidelines/          #   AI 가이드라인
│   └── modules/             #   빌트인 모듈 (SEO, kakao-talk, jina-reader...)
│
├── user/                    # 사용자 영역 (모듈, 데이터)
│   └── modules/             #   사용자 생성 모듈
│
├── docs/                    # 설계 문서
│   ├── CORE_BIBLE.md        #   Core 아키텍처 규격
│   ├── INFRA_BIBLE.md       #   Infra 아키텍처 규격
│   └── MODULE_BIBLE.md      #   모듈 시스템 규격
│
└── data/                    # 런타임 데이터 (gitignore)
    ├── app.db               #   페이지 DB
    ├── vault.db             #   시크릿 저장소
    ├── cron-jobs.json       #   크론 잡 영속 저장
    └── logs/                #   앱 로그 + 학습 데이터 JSONL
```

---

## Roadmap

| Phase | Description | Status |
|---|---|---|
| **v0.1** | Core + Infra + 9 Managers + MCP + Scheduling + Vault | Done |
| **v1.0** | 3-Tier Docker (EasyPanel) + Core/Next.js IPC 분리 | Planned |
| **v2.0** | Rust Core + gRPC + 시스템 모듈 동적 로드 | Planned |

---

## Design Documents

- **[CORE_BIBLE.md](docs/CORE_BIBLE.md)** — Core 순수성, 9대 Port, Manager 아키텍처, Plan-Execute 파이프라인
- **[INFRA_BIBLE.md](docs/INFRA_BIBLE.md)** — 9개 Adapter 구현 규격, 부트스트랩, 설정 상수
- **[MODULE_BIBLE.md](docs/MODULE_BIBLE.md)** — 모듈 시스템, Capability-Provider 패턴

---

<p align="center">
  <sub>Built with obsession by <a href="https://firebat.co.kr">Firebat</a></sub>
</p>

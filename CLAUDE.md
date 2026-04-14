# Firebat — Claude Code 작업 기록

## 프로젝트 개요
- **Firebat**: "만들기 + 운영 + 자동화" AI 플랫폼
- **스택**: Next.js 15 + Tailwind CSS + Gemini (VertexAI)
- **아키텍처**: Hexagonal (core/infra/app/user), ports & adapters, Core Facade 패턴
- **배포**: Vultr 141.164.41.166, firebat.co.kr, Nginx + PM2
- **목표**: v2.0에서 Rust Core + 3-Tier Docker (EasyPanel) 전환

## 코드 컨벤션
- 한국어 UI, 한국어 주석
- 에러 수정 시 버전 변경 금지
- Tailwind 반응형: `sm:` 브레이크포인트 기준 모바일-퍼스트
- API route는 얇은 Primary Adapter — 비즈니스 로직은 반드시 Core에

## 아키텍처 결정사항

### Core Facade + Manager 패턴 (v0.1, 2026-04-14 대규모 리팩토링)
- `FirebatCore` = 얇은 파사드 (라우팅 + SSE 발행만 담당)
- 9개 도메인 매니저가 실제 비즈니스 로직 수행
- **Core 싱글톤**: 전체 프로세스에서 `getCore()` 하나만 존재. LLM 모델 변경은 요청별 `opts.model`로 처리하며, Core를 재생성하지 않음
- **인프라 싱글톤**: `getInfra()`가 9개 어댑터를 1회 생성, `globalThis`에 캐시. LLM 어댑터는 lazy API 키 로드 (부팅 시 키 불필요)
- 모든 API route는 `getCore()` → Core 메서드 호출
- Auth는 부트스트랩 예외 (Core 경유 제외)
- **매니저 구조**:
  - 자체 도메인 매니저: 자기 인프라 포트를 직접 주입받음 (StorageManager ← IStoragePort)
  - 크로스 도메인 매니저: Core 참조를 추가로 받음 (AiManager, ScheduleManager)
  - 매니저 간 직접 호출 금지 — 반드시 Core 파사드 경유
  - 횡단 관심사(ILogPort, INetworkPort)는 매니저 불필요 — 포트 직접 주입 또는 Core 패스스루
- **SSE 이벤트**: Core 파사드 메서드에서 일괄 발행 (매니저는 발행하지 않음, 단 ScheduleManager.handleTrigger는 비동기 콜백이므로 예외)
- **요청별 모델 오버라이드**: `AiRequestOpts { model?, isDemo? }`를 AI 메서드에 전달 → `LlmCallOpts`로 ILlmPort에 전파
- **10개 매니저**: AiManager, StorageManager, PageManager, ProjectManager, ModuleManager, TaskManager, ScheduleManager, SecretManager, McpManager, CapabilityManager

### Component 시스템 (v0.1, 2026-04-12)
- 파일: `app/(user)/[slug]/components.tsx`
- 22개 빌트인 컴포넌트 (PageSpec JSON → 렌더링)
- Html 컴포넌트는 iframe sandbox로 전환 완료
- **중요**: 22개 제한은 자체 제약이었음. PageSpec 자체는 JSON→렌더 파이프라인이므로 확장 가능

### 로깅 시스템 (v0.1, 2026-04-12)
- ILogPort: info/warn/error/debug 4레벨
- ILlmPort: getModelId()로 모델명 노출
- 모든 AI 요청: `[corrId] [modelId]` + 소요시간(ms) + 성공/실패 분리
- Boot 로그: debug 레벨 (스팸 방지)
- Training JSONL: corrId, model, durationMs 포함

### 사이드바 구조 (v0.1, 2026-04-12)
- SYSTEM + PROJECTS 구조 (FileTree 제거)
- 프로젝트에 페이지 + 모듈(.py 등) 통합 표시
- 모듈 클릭 → FileEditor(모나코 + AI 코드 어시스턴트) 열림
- 모바일: 탭→선택→아이콘 표시, PC: 호버 방식

### AI 실행 (v0.1, 2026-04-12)
- OPEN_URL 자동 팝업 제거 → 미리보기 버튼으로 변경
- Plan-Execute 파이프라인 도입 완료 (Bolt 방식)
- Form bindModule: LLM 우회 직접 실행 (`/api/module/run`)
- 3단계 앱 공동설계: 기능 선택(toggle) → 디자인 선택(버튼) → 구현 (프롬프트 규칙 4)
- **Suggestions 시스템 (v0.1, 2026-04-14)**:
  - 3가지 타입: `string`(버튼), `{type:"input"}`(텍스트 입력), `{type:"toggle"}`(다중 선택)
  - Claude 스타일 박스 레이아웃: `border rounded-2xl`, 세로 정렬, 부드러운 블루 선택 상태
  - 실행 완료/예약 완료 후에는 suggestions 미표시 (프롬프트 규칙)
  - AI 프롬프트에 전체 18개 액션 JSON 샘플 포함
- **자동실행 정책 (v0.1, 2026-04-13)**:
  - 확인 필요: SAVE_PAGE, DELETE_PAGE, DELETE_FILE, SCHEDULE_TASK (되돌리기 어려운 작업)
  - 자동 실행: TEST_RUN, WRITE_FILE, APPEND_FILE, CANCEL_TASK, MCP_CALL, 조회류 전부
  - 샌드박스: 디렉토리 경로 전달 시 config.json entry / index.* 자동 탐색
- **API 키 자동감지 (v0.1, 2026-04-13)**:
  - 유저 모듈 config.json `secrets` 배열 → 설정 API 키 탭에 자동 목록화
  - AI가 모듈 생성 시 secrets 배열 필수 기재 → 키 미등록 시 설정 안내
  - 시스템 모듈 키는 모듈 설정 페이지 secret 필드로 관리 (별도)

### 크론/스케줄링 시스템 (v0.1, 2026-04-12)
- ICronPort 실구현 (node-cron), 사용자 설정 타임존 (기본 Asia/Seoul), 영속 저장 (data/cron-jobs.json)
- 타임존: Vault `system:timezone` 키로 저장, 부팅 시 크론 어댑터에 자동 주입
- 설정 모달 → 일반 탭에서 타임존 변경 가능 (UTC-11 ~ UTC+13, IANA 형식)
- 3가지 모드: cronTime(반복), runAt(1회 예약), delaySec(N초 후 1회)
- startAt/endAt: 기간 한정 반복, 만료 시 자동 해제
- 페이지 URL 스케줄링: `targetPath.startsWith('/')` → notify file → 클라이언트 폴링 → window.open
- ScheduleModal: 빈도 선택 UI (분/시간/매일/매주) + 고급 모드 (raw cron)
- AI 프롬프트: SCHEDULE_TASK/CANCEL_TASK/LIST_TASKS 지원
- CANCEL_TASK는 LIST_TASKS 없이 바로 실행 (1단계)
- 잡 해제 시 `clearNotificationsFor(jobId)` — 대기 중 알림 정리
- PM2 재시작 시 cron/once 잡 자동 복원, delay 잡은 복원 불가
- **Core 오케스트레이션 리팩토링 (v0.1, 2026-04-13)**:
  - 크론 어댑터에서 `ISandboxPort` 의존성 제거 — 크론은 스케줄링만 담당
  - `onJobComplete` → `onTrigger` 변경: 타이머 발화 시 Core에 위임
  - Core가 sandbox.execute() 호출 → 결과 수신 → SSE로 클라이언트 알림
  - SSE 이벤트 버스 (`lib/events.ts`) + `/api/events` 엔드포인트 추가
  - CronPanel/Sidebar: SSE 실시간 수신으로 폴링 대체
- **파이프라인 스케줄링 (v0.1, 2026-04-14)**:
  - SCHEDULE_TASK에 `pipeline` 배열 추가 (복합 작업: MCP 조회 → LLM 요약 → 모듈 발송)
  - 4가지 파이프라인 단계: TEST_RUN, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM
  - `$prev` 치환: 재귀적 `resolveValue()`로 inputData/inputMap 모든 위치에서 자동 전달
  - LLM_TRANSFORM만 `llm.askText()` 호출 — 나머지는 기계적 실행 (비용 최소화)
  - prompt 기반 → pipeline 기반으로 전환 (AI 전체 재실행 대신 사전 컴파일된 파이프라인)
- **TaskManager 분리 (v0.1, 2026-04-14)**:
  - 파이프라인 실행 엔진을 ScheduleManager에서 TaskManager로 분리
  - RUN_TASK 액션: 즉시 파이프라인 실행 ("지금 바로 해줘")
  - SCHEDULE_TASK: 예약/반복만 담당, 트리거 시 Core.runTask()로 TaskManager에 위임
  - ScheduleManager에서 ILlmPort 의존성 제거 (LLM_TRANSFORM은 TaskManager가 담당)
- **타임존 파싱 (v0.1, 2026-04-14)**:
  - `parseInTimezone()`: Naive datetime 문자열을 설정된 타임존 기준으로 UTC 변환 (`Intl.DateTimeFormat` 사용)
  - `runAt`, `startAt`, `endAt` 모든 위치에 적용 (schedule, registerOnce, registerCron, restore)
- **파이프라인 등록 시 검증 (v0.1, 2026-04-14)**:
  - `validatePipeline()`: TEST_RUN(path), MCP_CALL(server,tool), NETWORK_REQUEST(url), LLM_TRANSFORM(instruction) 필수 필드 검증
  - 잘못된 파이프라인은 등록 단계에서 즉시 거부
- **크론 로그 title 영속 (v0.1, 2026-04-14)**:
  - `CronLogEntry`에 `title` 필드 추가, `fireTrigger()`에서 기록
  - 1회 잡 삭제 후에도 로그에 title 표시 가능

### SSE 이벤트 시스템 (v0.1, 2026-04-13)
- `lib/events.ts`: 싱글톤 EventBus (subscribe/emit)
- `/api/events`: SSE 스트림 엔드포인트 (30초 keepalive)
- 이벤트 타입: `cron:complete` (크론 잡 완료), `sidebar:refresh` (사이드바 갱신)
- Core가 이벤트 발행 → 연결된 모든 클라이언트에 즉시 전달
- CronPanel: SSE로 크론 완료 감지 → 즉시 목록/로그 갱신
- Sidebar: SSE로 sidebar:refresh → 즉시 프로젝트/모듈 목록 갱신

### 설정 모달 (v0.1, 2026-04-12)
- 탭 구조: 일반 | API 키
- 일반 탭: 모델 선택, 타임존 선택, 관리자 계정 변경
- API 키 탭: Vertex AI 설정 (API Key, Project ID, Location) + 사용자 시크릿 CRUD (저장된 키 목록 + 추가/삭제)
- `/api/settings` — 시스템 설정 CRUD (GET: 조회, PATCH: 변경)

### Vault ↔ AI 연동 (v0.1, 2026-04-12)
- IVaultPort 추가 (8번째 포트), FirebatInfraContainer에 vault 포함
- **핵심 원칙: AI는 키 값을 절대 모른다** — AI는 입력창만 띄우고, 키는 브라우저→Vault→Sandbox로 AI 우회
- REQUEST_SECRET 액션: AI가 "이 키 필요해" → 프론트엔드에 SecretInput 표시
- SET_SECRET 액션: 시스템 내부용 (AI가 직접 값을 저장할 때, 비밀번호류 아닌 경우)
- Sandbox 환경변수 주입: config.json `secrets` 배열 → Vault에서 값 조회 → env로 전달
- 모듈 코드에서 접근: `os.environ["key-name"]` (Python), `process.env["key-name"]` (Node)
- SecretInput 인라인 컴포넌트 — 채팅 내 시크릿 입력 UI (password 타입, 저장 후 체크 표시)
- 사용자 시크릿 키 접두사: `user:` (Vertex 시스템 키와 분리)
- `/api/vault/secrets` — 범용 시크릿 CRUD API (GET: 마스킹 목록, POST: 저장, DELETE: 삭제)

### MCP 서버 (v0.1, 2026-04-13)
- 외부 AI(Claude Code, Cursor 등)가 파이어뱃 user 영역을 조작하는 MCP 서버
- Primary Adapter: MCP 프로토콜 → Core 메서드 호출 (바이블 준수)
- **stdio 모드**: `npm run mcp` 또는 `npx tsx mcp/stdio.ts` — Claude Code, Cursor 등 로컬 도구용 (SSH 키 필수)
- **SSE 모드**: `GET /api/mcp` → SSE 스트림, `POST /api/mcp?sessionId=xxx` → JSON-RPC — 웹 기반 도구용 (Bearer 토큰 인증 필수)
- 15개 도구: list_pages, get_page, save_page, delete_page, read_file, write_file, delete_file, list_dir, run_module, list_projects, delete_project, list_cron_jobs, cancel_cron_job, list_system_modules, get_timezone
- `getCore()` 싱글톤 사용 (LLM은 lazy 초기화 — API 키 미설정이어도 도구 실행 정상 작동)
- Claude Code 설정 예시: `claude_desktop_config.json`에 `"command": "npx", "args": ["tsx", "mcp/stdio.ts"], "cwd": "/var/www/firebat"`
- **MCP 토큰 인증 (v0.1, 2026-04-14)**:
  - SSE(API) 모드 접속 시 `Authorization: Bearer <token>` 필수
  - 토큰 생성: 설정 > MCP 탭 > "Firebat MCP 서버" 섹션에서 생성
  - 토큰 형식: `fbt_` + 32자 랜덤 hex (예: `fbt_a1b2c3d4...`)
  - **1회 표시 정책**: 생성 시 1번만 원본 노출, 이후 마스킹 (`fbt_a1b2****k9m3`)
  - 재생성 시 기존 토큰 즉시 무효화 (OpenAI/GitHub 토큰 패턴)
  - Vault 저장: `system:mcp-token` (토큰), `system:mcp-token-created` (생성일)
  - Core 메서드: `generateMcpToken`, `validateMcpToken`, `revokeMcpToken`, `getMcpTokenInfo`
  - API: `/api/mcp/tokens` (GET: 토큰 정보, POST: 생성, DELETE: 폐기)
  - 설정 UI: MCP 탭에 API/stdio JSON 설정 보기 + 복사, stdio SSH 키 필수 안내

### MCP 클라이언트 (v0.1, 2026-04-13)
- 파이어뱃 → 외부 MCP 서버 (Gmail, Slack, 카톡 등) 접속
- IMcpClientPort (9번째 포트): addServer, removeServer, listTools, callTool
- 설정 영속 저장: `data/mcp-servers.json`
- 전송 방식: stdio (로컬 프로세스) + SSE (원격 서버)
- AI 연동: 시스템 프롬프트에 [MCP 외부 도구] 목록 노출, MCP_CALL 액션으로 호출
- API: `/api/mcp/servers` (서버 CRUD), `/api/mcp/tools` (도구 목록/실행)
- 사용 예시: 서버 등록 → AI가 "이메일 보내줘" 요청 시 gmail MCP 서버의 send_email 도구 호출

## 뼈대 완성 계획 (4/23 전)
| Phase | 작업 | 상태 |
|---|---|---|
| 1-1 | Plan-Execute 파이프라인 | ✅ 완료 |
| 1-2 | Html iframe sandbox | ✅ 완료 |
| 2-1 | 크론 어댑터 실구현 | ✅ 완료 |
| 2-2 | Vault ↔ AI 연동 플로우 | ✅ 완료 |
| 3-1 | MCP 서버 내장 | ✅ 완료 |
| 3-2 | MCP 클라이언트 기반 | ✅ 완료 |
| 4-1 | 3-Tier Docker 구성 | 미착수 |
| 4-2 | Core ↔ Next.js IPC 분리 | 미착수 |

## 구상 / 향후 계획

### 로그 분석 기반 개선사항 (2026-04-12 분석)
- [x] **Pro 모델 타임아웃 대응** — ~~gemini-3.1-pro가 30초 초과 빈번~~ → 타임아웃 60초로 확대 완료
- [x] **Python true/True 혼동 방지** — 프롬프트 규칙 6에 "Python은 True/False/None" 규칙 추가 완료
- [x] **WRITE_FILE content undefined 방어** — executeAction 두 곳에 content null 체크 추가 완료
- [x] **description 필드 누락 방어** — z.string().default('') + 파싱 후 빈 description은 action.type으로 자동 채움

### 코드 감사 결과 (2026-04-12)

#### 보안 (Critical)
- [x] **경로 탐색 공격 차단** — `infra/storage/index.ts` isInsideZone + path.resolve containment 체크 완료
- [x] **Sandbox 경로 검증 추가** — `infra/sandbox/index.ts` canExecute 메서드로 user/modules/, system/modules/ 외 실행 차단 완료
- [ ] **admin 기본 자격증명** — `app/api/auth/route.ts`: Vault/env 미설정 시 `'admin'/'admin'` 폴백. 프로덕션에서 경고 또는 차단 필요
- [ ] **demo 계정 제거 (v1.0 전 필수)** — `FIREBAT_DEMO=true` 환경변수로 게이팅. `user/user` 하드코딩.
  - 하드코딩 위치: `app/api/auth/route.ts` (id=`user`, password=`user` 비교, 토큰=`demo`, 역할=`demo`)
  - 데모 모드 제한사항: Vault 쓰기 차단, MCP 전체 차단 (API + AI 프롬프트 + UI 탭 숨김), 설정 변경 차단
  - 차단 체크 위치: `app/api/mcp/tools/route.ts`, `app/api/mcp/servers/route.ts`, `app/api/vault/`, `core/managers/ai-manager.ts` (isDemo), `core/index.ts` (isDemo 옵션), `app/admin/page.tsx` (MCP 탭 조건부 렌더)
  - v1.0 출시 시: `FIREBAT_DEMO` 관련 코드 전부 제거, `isDemo` 플래그 제거, auth에서 `user/user` 분기 제거
- [x] **iframe allow-same-origin 제거** — `app/(user)/[slug]/components.tsx` HtmlComp: `sandbox="allow-scripts"` 으로 변경 완료

#### 바이블 위반
- [x] **Core → Infra import** — `core/singleton.ts` → `lib/singleton.ts`로 이동 완료 (Core 순수성 유지)
- [x] **Infra 싱글톤** — `infra/boot.ts` `getInfra()` 전체 싱글톤으로 변경 완료
- [x] **Vault API Core 우회** — vault/route.ts, vault/secrets/route.ts가 Core 메서드(getVertexKey, setVertexKey, listUserSecrets 등) 경유로 변경 완료
- [x] **ICronPort 불완전** — setTimezone/getTimezone 인터페이스에 추가, Core에서 `as any` 캐스팅 제거 완료

#### 구조 개선
- [x] **시스템 프롬프트 중복 제거** — `ai-manager.ts`의 `process()`가 `buildSystemPrompt()` 호출로 통합 완료
- [x] **CoreAiManager 정리** — TODO 표시 완료. v1+ 삼위일체 AI 구현 시 활성화 예정
- [x] **admin/page.tsx 분리** — SettingsModal, ChatWidgets, useChat 훅, types 분리 완료 (1427줄 → 270줄)
- [x] **PageEditor → FileEditor 통합** — 파일/PageSpec 에디터 통합. `filePath` 또는 `pageSlug` 프롭으로 모드 결정. PageEditor.tsx 삭제

#### 하드코딩 통합 (infra/config.ts 신설 완료)
- [x] **모델명** — `DEFAULT_MODEL` 상수로 통합 완료 (gemini-3-flash-preview)
- [x] **파일 경로** — `DATA_DIR`, `DB_PATH`, `CRON_JOBS_FILE` 등 상수로 통합 완료
- [x] **타임아웃/숫자** — `LLM_TIMEOUT_MS`, `SANDBOX_TIMEOUT_MS`, `CRON_MAX_LOGS` 등 통합 완료
- [x] **Vertex 리전** — `DEFAULT_VERTEX_LOCATION` 상수로 통합 완료

### Phase 3: MCP 연동
- **3-1 MCP 서버 내장**: 외부 AI(Claude Code, Cursor 등) → 파이어뱃 user 영역 조작. Primary Adapter로 구현
- **3-2 MCP 클라이언트 기반**: 파이어뱃 → 외부 MCP 서버 (Gmail, Slack, 카톡 등) 접속. 기존 MCP 생태계 활용

### SEO 시스템 모듈 (v0.1, 2026-04-13)
- **sitemap.xml**: `app/sitemap.ts` — Next.js Metadata API, DB 페이지 목록에서 동적 생성, sitemapEnabled 설정으로 on/off
- **robots.txt**: `app/robots.ts` — Next.js Metadata API, SEO 설정에서 내용 편집, sitemap URL 자동 포함
- **RSS feed.xml**: `app/feed.xml/route.ts` — RSS 2.0 XML, rssEnabled 설정으로 on/off, Atom self-link 포함
- **head/body 스크립트 주입**: `app/(user)/layout.tsx` + `app/(user)/seo-scripts.tsx` — 클라이언트 DOM 주입, 페이지 이동 시 자동 클린업
- **글로벌 SEO 설정**: Vault `system:module:seo:settings`에 JSON 저장, `getSeoSettings()` 편의 메서드
- **설정 UI**: SystemModuleSettings에서 4개 탭으로 관리
  - 일반 탭: siteTitle, siteDescription, siteUrl, JSON-LD on/off, 조직명, 로고 URL
  - SEO 탭: sitemapEnabled, rssEnabled, robotsTxt
  - OG 이미지 탭: 미리보기 + 배경색(ogBgColor), 강조색(ogAccentColor), 도메인(ogDomain)
  - 스크립트 탭: headScripts, bodyScripts
- **OG 이미지**: `/api/og` — SEO 설정에서 배경색/강조색/도메인 커스텀, 유령 로고 아이콘
- **JSON-LD**: User 레이아웃에 WebSite+Organization 글로벌, 페이지별 WebPage 자동 삽입
- `BASE_URL`: `infra/config.ts`에서 통합 관리 (환경변수 `NEXT_PUBLIC_BASE_URL` 우선)
- **v1.0+ SEO 추가 예정**: favicon 커스텀(IMediaPort 필요), 기본 lang 설정, Twitter Card, canonical 자동 생성
- **v1.0 초기 설정 위자드**: 첫 실행 시 사이트 이름/URL/설명 입력 (현재 기본값 Firebat 하드코딩)

### config.json 체계 (v0.1, 2026-04-14)
- **통합 설정 파일**: `module.json` → `config.json`으로 변경
- **type 필드**: `service`(설정 전용) | `module`(실행 가능) | `reusable`(향후 유저 리유저블)
- **scope 필드**: `system` | `user`
- **디렉토리 구조**:
  - `system/services/` — 시스템 서비스 (SEO, MCP 서버)
  - `system/modules/` — 시스템 모듈 (kakao-talk, browser-scrape, jina-reader)
  - `user/modules/` — 유저 모듈
- **사이드바 SYSTEM 섹션**: 서비스/모듈 두 그룹으로 분리 표시
- **설정 모달 MCP 탭**: "외부 MCP"로 변경 (클라이언트만), Firebat MCP 서버는 사이드바 서비스로 이동

### 시스템 모듈/서비스 설정 UI (v0.1, 2026-04-13)
- **사이드바 연동**: 시스템 모듈/서비스 클릭 → SystemModuleSettings 모달 (FileEditor 대신 설정 패널)
- **동적 스키마 렌더링**: `MODULE_SETTINGS_SCHEMA`에 모듈별 필드 정의, text/number/toggle/textarea/oauth/secret 지원
- **secret 필드 타입**: Vault(`user:` 접두사)에 직접 저장, 모듈 설정 페이지에서 API 키 입력 가능 (별도 API 키 탭 불필요)
- **현재 등록**: SEO(서비스, 7개 필드), MCP 서버(서비스), browser-scrape(모듈, 3개 필드), kakao-talk(모듈, 4개 필드), jina-reader(모듈, 1개 필드)
- **외부 MCP 서버 수정**: 설정 모달 외부 MCP 탭에서 서버 클릭 → 등록 정보 수정 가능
- **PC/모바일 패턴**: PC=호버 시 기어 아이콘, 모바일=탭 선택 후 기어 아이콘 (프로젝트 항목과 동일)

### Capability-Provider 패턴 (v0.1, 2026-04-13)
- **목적**: 같은 기능(capability)을 수행하는 여러 모듈(provider)을 묶고 우선순위/폴백 관리
- **Capability Registry**: `core/capabilities.ts`에 빌트인 6개 (web-scrape, email-send, image-gen, translate, notification, pdf-gen)
- **config.json 확장**: `type`, `capability`, `providerType` 필드 추가
- **미등록 capability**: 모듈 스캔 시 자동 등록 + 경고 로그
- **Provider 선택 모드**: `api-first`(기본) | `local-first` | `api-only` | `local-only` | `manual`
- **설정 저장**: Vault `system:capability:<id>:settings`
- **Core 메서드**: `listCapabilities`, `getCapabilityProviders`, `listCapabilitiesWithProviders`, `resolveCapability`, `registerCapability`, `getCapabilitySettings`, `setCapabilitySettings`
- **API**: `/api/capabilities` (GET 목록, POST 상세, PATCH 설정 변경)
- **어드민 UI**: 설정 모달 → 기능 탭 (capability 목록, provider 조회, 실행 모드 변경)
- **현재 등록 provider**: `web-scrape` → browser-scrape(local) + jina-reader(api), `notification` → kakao-talk(api)
- 상세 규격: `docs/MODULE_BIBLE.md` 제8장 참조

### 카카오톡 메시지 모듈 (v0.1, 2026-04-13)
- **모듈**: `system/modules/kakao-talk/` — Node.js, 카카오 나에게 보내기 API
- **capability**: `notification`, **providerType**: `api`
- **메시지 타입**: text(기본), feed(카드형), list(목록형)
- **시크릿**: `KAKAO_ACCESS_TOKEN`, `KAKAO_REFRESH_TOKEN`, `KAKAO_REST_API_KEY`
- **토큰 자동 갱신**: 401 에러 시 refresh_token으로 자동 재발급 후 재시도
- **OAuth 연동**: `/api/auth/kakao` → 카카오 로그인 → `/api/auth/kakao/callback` → 토큰 자동 Vault 저장
- **UI**: SystemModuleSettings에 oauth 필드 타입 추가, 연동 상태 표시 + 연동/재연동 버튼
- **준비**: 카카오 디벨로퍼스 → 앱 생성 → talk_message 권한 활성화 → Redirect URI에 `{도메인}/api/auth/kakao/callback` 등록 → REST API 키를 Vault에 저장 → 연동 버튼 클릭

### Phase 4: 배포 분리 (4/23 Ubuntu 26.04)
- **4-1 3-Tier Docker 구성**: EasyPanel에 core/renderer/admin 3 컨테이너
- **4-2 Core ↔ Next.js IPC 분리**: gRPC 또는 HTTP 내부 통신

### 미디어/이미지 인프라 (구상)
- **IMediaPort 신설** 또는 **IStoragePort 확장**: 이미지 업로드, 저장, 조회, 삭제
- 용도: 사용자 이미지 업로드, AI 이미지 생성, OG 썸네일 캐싱, 페이지 첨부 이미지
- 1차: 로컬 파일 저장 (`data/media/`), 2차: S3/R2 등 오브젝트 스토리지
- SEO 모듈의 OG 이미지 캐싱도 이 인프라 위에서 구현

### Phase 5 이후 (장기)
- **Rust Core 전환**: Phase 4에서 gRPC 인터페이스 확정 → Core 컨테이너 내부만 Rust로 교체
- **모듈 패키징 개편**: 모노레포 구조 (entries/pipeline), 서브모듈 체이닝
- **Core AI 파인튜닝**: 실행 로그 수집 → Vertex AI 파인튜닝 → 자기진화 루프
- **인프라 스마트화**: 샌드박스 스트리밍, LLM 비용 추적, 크론 자동 재시도
- **새 인프라**: Event Bus, Notification (슬랙/이메일/텔레그램), Webhook, Memory, Metrics
- **시스템 모듈 동적 로드**: system/modules/에 어댑터 모듈 → 부팅 시 동적 import → Core 주입 (DB/LLM/Storage 등 갈아끼기)

## 주요 파일
- `core/index.ts` — FirebatCore (Thin Facade, 9개 매니저 라우팅 + SSE 발행)
- `core/ports/index.ts` — 9개 Port 인터페이스 (IMcpClientPort 추가)
- `core/types/index.ts` — FirebatAction/Plan 스키마 (REQUEST_SECRET, SET_SECRET 포함)
- `core/managers/ai-manager.ts` — AiManager (시스템 프롬프트 + Plan-Execute + 코드 어시스트)
- `core/managers/storage-manager.ts` — StorageManager (파일 CRUD + 트리)
- `core/managers/page-manager.ts` — PageManager (페이지 CRUD)
- `core/managers/project-manager.ts` — ProjectManager (프로젝트 스캔/삭제)
- `core/managers/module-manager.ts` — ModuleManager (모듈 실행 + 시스템 모듈 설정)
- `core/managers/task-manager.ts` — TaskManager (파이프라인 즉시 실행 엔진)
- `core/managers/schedule-manager.ts` — ScheduleManager (크론/예약 CRUD)
- `core/managers/secret-manager.ts` — SecretManager (Vault 시크릿 관리)
- `core/managers/mcp-manager.ts` — McpManager (MCP 클라이언트 조작)
- `core/managers/capability-manager.ts` — CapabilityManager (Provider 해석 + 설정)
- `core/managers/core-ai-manager.ts` — CoreAiManager (v1+ 삼위일체 AI, 현재 미사용)
- `lib/singleton.ts` — Core 싱글톤 팩토리 `getCore()` (Core+Infra 조합, 바이블 준수 위치)
- `infra/boot.ts` — 인프라 싱글톤 `getInfra()` (9개 어댑터 1회 조립, LLM lazy 초기화)
- `infra/storage/vault-adapter.ts` — SQLite Vault (시크릿 저장, user: 접두사)
- `infra/sandbox/index.ts` — 프로세스 샌드박스 (시크릿 env 주입, 자동 패키지 설치)
- `infra/cron/index.ts` — node-cron 어댑터 (영속, 동적 타임존, parseInTimezone, 페이지 알림)
- `infra/log/index.ts` — ConsoleLogAdapter (4레벨 + 파일/JSONL 분리)
- `infra/llm/vertex-adapter.ts` — VertexAI 어댑터 (60초 타임아웃, getModelId)
- `mcp/server.ts` — MCP 서버 도구 정의 (Core 메서드 → MCP 도구 매핑)
- `mcp/stdio.ts` — MCP stdio 진입점 (Claude Code, Cursor 등 로컬 AI 도구용)
- `app/api/mcp/route.ts` — MCP SSE 엔드포인트 (웹 기반 AI 도구용)
- `infra/mcp-client/index.ts` — MCP 클라이언트 어댑터 (외부 MCP 서버 접속 관리)
- `app/api/mcp/servers/route.ts` — MCP 서버 설정 CRUD API
- `app/api/mcp/tools/route.ts` — MCP 도구 목록/실행 API
- `app/api/mcp/tokens/route.ts` — MCP 토큰 생성/조회/폐기 API
- `app/(user)/[slug]/components.tsx` — 22개 빌트인 컴포넌트 렌더러
- `app/(user)/[slug]/page.tsx` — 동적 페이지 렌더링 (Core.getPage, SEO 메타데이터)
- `app/(user)/layout.tsx` — User 페이지 레이아웃 (SEO 스크립트 주입)
- `app/(user)/seo-scripts.tsx` — SEO head/body 스크립트 DOM 주입 (클라이언트)
- `app/sitemap.ts` — 동적 sitemap.xml (Next.js Metadata API)
- `app/robots.ts` — 동적 robots.txt (Next.js Metadata API)
- `app/feed.xml/route.ts` — RSS 2.0 피드 (Route Handler)
- `app/admin/page.tsx` — 어드민 메인 (MessageBubble, 입력창)
- `app/admin/types.ts` — 타입/상수 (Message, Conversation, GEMINI_MODELS)
- `app/admin/hooks/useChat.ts` — 대화 관리 + SSE 처리 커스텀 훅
- `app/admin/components/SettingsModal.tsx` — 설정 모달 (일반/API키/MCP/기능 탭)
- `app/admin/components/ChatWidgets.tsx` — McpResultCollapsible, SecretInput
- `app/admin/components/SystemModuleSettings.tsx` — 시스템 모듈 설정 모달 (동적 스키마 기반)
- `app/admin/components/Sidebar.tsx` — SYSTEM + PROJECTS 사이드바
- `app/admin/components/CronPanel.tsx` — 크론 잡 관리 + ScheduleModal
- `app/admin/components/FileEditor.tsx` — 통합 에디터 (파일 + PageSpec) + AI 어시스트 + 구조 미리보기
- `app/api/vault/route.ts` — Vertex AI 키 관리 API
- `app/api/vault/secrets/route.ts` — 범용 사용자 시크릿 CRUD API
- `app/api/settings/route.ts` — 시스템 설정 API (타임존 등)
- `app/api/cron/route.ts` — 크론 잡 CRUD + 알림 폴링 API
- `app/api/module/run/route.ts` — 모듈 직접 실행 API
- `app/api/settings/modules/route.ts` — 시스템 모듈 설정 CRUD API
- `core/capabilities.ts` — Capability-Provider 타입 + 빌트인 Registry
- `app/api/capabilities/route.ts` — Capability 목록/상세/설정 변경 API
- `system/modules/jina-reader/index.mjs` — Jina Reader 웹 스크래퍼 (API, web-scrape)
- `system/modules/kakao-talk/index.mjs` — 카카오톡 나에게 보내기 (API, notification)

### UI 개선 (v0.1, 2026-04-14)
- **폰트**: Inter → Pretendard Variable (한국어 가독성 향상, CDN 동적 서브셋)
- **모바일**: 봇 아이콘 `hidden sm:flex` (대화창 공간 확보)
- **부트 애니메이션**: 15ms → 5ms per step (0.5초 총 소요)
- **system/guidelines/ 폴더 삭제**: AI가 참조하지 않는 미사용 파일

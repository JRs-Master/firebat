# FIREBAT INFRA BIBLE — 행동 대장 수칙

> 최종 개정: 2026-04-13 (v0.1)

## 전문(前文)

이 문서는 `infra/` 계층의 설계 및 행동 규격을 정의한다.
Infra는 Core의 순수성을 지키기 위해 물리적 세계(파일 시스템, 프로세스, 네트워크)와 직접 맞닿아 궂은일을 수행하는 **유일한 I/O 실행 계층**이다.

---

## 제1장: 절대 원칙

1. **독점적 I/O 권한**: `fs`, `child_process`, `fetch`, DB 라이브러리 등을 호출할 수 있는 유일한 계층.
2. **에러 캡슐화**: 모든 에러를 catch하여 `InfraResult` 객체로 Core에 반환. 절대 throw하지 않는다.
3. **Core 의존성 배제**: `core/ports/`의 인터페이스만 참조. Core 내부 로직을 import하지 않는다.
4. **설정 중앙 관리**: 모든 설정 상수는 `infra/config.ts`에서 관리 (환경변수 우선, 기본값 폴백).

---

## 제2장: 9개 어댑터 구현 규격

### 1. Storage Adapter (`infra/storage/`)
- `IStoragePort` 구현.
- **경로 탐색 공격 차단**: `isInsideZone` + `path.resolve` containment 체크.
- **쓰기 허용 구역**: `app/(user)/`, `user/`
- **읽기 허용 구역**: `app/(user)/`, `user/`, `docs/`, `system/guidelines/`, `system/modules/`
- `listDir(path)`: `{name, isDirectory}[]` 반환.

### 2. Log Adapter (`infra/log/`)
- `ILogPort` 구현 (info/warn/error/debug 4레벨).
- 파일 로깅: `data/logs/app-YYYY-MM-DD.log` (일반) + `data/logs/training-YYYY-MM-DD.jsonl` (학습 데이터).
- `[USER_AI_TRAINING]`, `[CORE_AI_TRAINING]` 프리픽스 감지 시 JSONL 자동 분리 저장.

### 3. Sandbox Adapter (`infra/sandbox/`)
- `ISandboxPort` 구현.
- **경로 검증**: `canExecute` 메서드로 `user/modules/`, `system/modules/` 외 실행 차단.
- **언어 중립**: `.py`, `.js`, `.mjs`, `.php`, `.rs`, `.wasm`, `.sh` 지원.
- **module.json 선제 설치**: `packages` 필드 의존성을 실행 전 자동 설치.
- **시크릿 env 주입**: `secrets` 배열 → Vault에서 값 조회 → 환경변수로 전달.
- **타임아웃**: 30초 (`SANDBOX_TIMEOUT_MS`).
- **stdin/stdout**: `{ correlationId, data }` 주입 → 마지막 줄 단일 JSON 수신.

### 4. LLM Adapter (`infra/llm/vertex-adapter.ts`)
- `ILlmPort` 구현.
- Vertex AI Express 모드 (API 키 인증).
- **Lazy 클라이언트**: 부팅 시 API 키를 직접 읽지 않고, resolver 함수로 첫 호출 시 로드. API 키 변경 시 자동 재연결.
- **요청별 모델 오버라이드**: `LlmCallOpts.model`로 호출마다 다른 모델 지정 가능.
- `ask()`: JSON 응답 강제, temperature 0.2.
- `askText()`: 텍스트 응답, temperature 0.3.
- `getModelId()`: 기본 모델명 반환.
- 타임아웃: 60초 (`LLM_TIMEOUT_MS`).
- API 키 우선순위: Vault → 환경변수.

### 5. Network Adapter (`infra/network/`)
- `INetworkPort` 구현.
- `fetch` 래퍼. `127.0.0.1`, `localhost` 접근 차단 (SSRF 방어).

### 6. Cron Adapter (`infra/cron/`)
- `ICronPort` 구현.
- `node-cron` 기반 백그라운드 스케줄러.
- **싱글톤**: `globalThis` 캐싱 (Next.js 핫리로드 시 중복 방지).
- **영속 저장**: `data/cron-jobs.json`에 잡 설정 저장, PM2 재시작 시 자동 복원.
- **3가지 모드**: `cronTime`(반복), `runAt`(1회 예약), `delaySec`(N초 후 1회).
- **기간 한정**: `startAt`/`endAt`으로 반복 기간 제한, 만료 시 자동 해제.
- **동적 타임존**: Vault `system:timezone` 키로 저장, `setTimezone()`/`getTimezone()` 지원.
- **페이지 URL 스케줄링**: `targetPath.startsWith('/')` → notify 파일 → 클라이언트 폴링 → window.open.

### 7. Database Adapter (`infra/database/`)
- `IDatabasePort` 구현.
- `better-sqlite3` 기반 (`data/app.db`).
- 자동 초기화: `pages` 테이블 `CREATE TABLE IF NOT EXISTS`.
- CRUD: `savePage`, `getPage`, `listPages`, `deletePage`, `listPagesByProject`, `deletePagesByProject`.

### 8. Vault Adapter (`infra/storage/vault-adapter.ts`)
- `IVaultPort` 구현.
- `better-sqlite3` 기반 (`data/vault.db`).
- API 키, 시크릿 등 민감한 값의 CRUD.
- `user:` 접두사로 사용자 시크릿과 시스템 키 분리.
- `listKeysByPrefix(prefix)`: 특정 접두사의 키 목록 반환.
- 시스템 모듈 설정: `system:module:<name>:settings` 키에 JSON 저장.

### 9. MCP Client Adapter (`infra/mcp-client/`)
- `IMcpClientPort` 구현.
- 외부 MCP 서버(Gmail, Slack 등) 접속 및 도구 호출.
- **전송 방식**: stdio (로컬 프로세스) + SSE (원격 서버).
- **영속 저장**: `data/mcp-servers.json`.
- `addServer`/`removeServer`/`listTools`/`callTool`/`listAllTools`/`disconnectAll`.

---

## 제3장: 부트스트랩

### 제1항. 어댑터 조립 (`infra/boot.ts`)
`getInfra()` 함수가 9개 어댑터를 1회 조립하여 `globalThis`에 캐시한다.
LLM 어댑터는 resolver 함수를 받아 lazy 초기화 (API 키 미설정 상태에서도 부팅 가능).

### 제2항. 서버 초기화
- `instrumentation.ts`: `NEXT_RUNTIME === 'nodejs'` 조건 하에 `instrumentation.node.ts` 동적 import.
- `instrumentation.node.ts`: Python/playwright 등 시스템 런타임 의존성 백그라운드 설치.

### 제3항. 설정 상수 (`infra/config.ts`)
| 상수 | 기본값 | 설명 |
|---|---|---|
| `DATA_DIR` | `data` | 데이터 저장 경로 |
| `DB_PATH` | `data/app.db` | SQLite DB 경로 |
| `DEFAULT_MODEL` | `gemini-3-flash-preview` | 기본 LLM 모델 |
| `LLM_TIMEOUT_MS` | `60000` | LLM 타임아웃 |
| `SANDBOX_TIMEOUT_MS` | `30000` | 샌드박스 타임아웃 |
| `CRON_DEFAULT_TIMEZONE` | `Asia/Seoul` | 기본 타임존 |
| `BASE_URL` | `https://firebat.co.kr` | SEO/OG 외부 노출 도메인 |

---

## 제4장: Primary Adapter 규약 (app/api/)

1. **직접 I/O 금지**: `app/api/`에서 `fs`, `child_process`, `fetch`, LLM SDK를 직접 호출하지 않는다.
2. **Core Singleton 경유**: `getCore()`를 통해 싱글톤 Core를 획득하고, Core 메서드를 호출한다.
3. **예외**: 인증(`/api/auth`)은 부트스트랩 영역으로 Core 경유 대상에서 제외.
4. **인증 자격증명**: `FIREBAT_ADMIN_ID` / `FIREBAT_ADMIN_PASSWORD` 환경변수 (미설정 시 `admin`/`admin` 폴백).

---

## 제5장: 마이그레이션 로드맵 (v2.0)

현재 `infra/` 내에 직접 존재하는 어댑터를 `system/modules/`로 이전 예정.

| 현재 위치 | 마이그레이션 대상 |
|---|---|
| `infra/storage/` | `system/modules/local-storage/` |
| `infra/llm/` | `system/modules/vertex-llm/` |
| `infra/sandbox/` | `system/modules/process-sandbox/` |
| `infra/log/` | `system/modules/file-logger/` |
| `infra/network/` | `system/modules/fetch-network/` |
| `infra/cron/` | `system/modules/node-cron/` |
| `infra/database/` | `system/modules/sqlite-db/` |
| `infra/storage/vault-adapter.ts` | `system/modules/sqlite-vault/` |
| `infra/mcp-client/` | `system/modules/mcp-client/` |

마이그레이션 완료 후 `infra/`에는 부트 로더(`boot.ts`)와 설정(`config.ts`)만 남는다.

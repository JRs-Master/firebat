# FIREBAT CORE BIBLE — 순수 판독과 지휘의 성역

> 최종 개정: 2026-04-13 (v0.1)

## 전문(前文)

이 문서는 `core/` 영역의 설계 지침을 규정하는 기술 규격서이다.
Core는 시스템 전체를 지휘하는 **재판장(Judge)**이자 **오케스트레이터(Orchestrator)**이며,
물리적 I/O를 직접 수행하지 않는 **순수 비즈니스 로직 계층**이다.

---

## 제1장: 순수성 보장의 원칙

### 제1항. I/O 라이브러리 직접 참조 금지
`core/` 영역에서는 물리적 I/O를 직접 호출하지 않는다.
- **금지**: `fs`, `path`, `child_process`, `fetch`, DB 라이브러리(`sqlite3`, `pg` 등), `infra/` import
- **허용**: 데이터 검증 라이브러리(`zod` 등), 순수 TypeScript 비즈니스 로직

### 제2항. 의존성 주입 (Port & Adapter)
Core는 추상 인터페이스(Port)만 호출한다. 실제 구현체(Adapter)는 `infra/` 계층이 부팅 시 주입한다.

### 제3항. Singleton 위치 규칙
Core와 Infra를 조합하는 팩토리(`getCore()`)는 `lib/singleton.ts`에 위치한다.
Core는 전체 프로세스에서 **하나만 존재**하며, LLM 모델 변경은 요청별 `opts.model`로 처리한다.
`core/` 디렉토리 안에 Infra를 import하는 코드가 존재하면 바이블 위반이다.

---

## 제2장: 9대 포트(Port) 규격

Core가 Infra에게 요구하는 9개 포트 인터페이스. 모두 `core/ports/index.ts`에 정의된다.

| # | 포트 | 역할 |
|---|---|---|
| 1 | `IStoragePort` | 파일 읽기/쓰기/삭제/목록 조회 |
| 2 | `ILogPort` | 4레벨 로깅 (info/warn/error/debug) |
| 3 | `ISandboxPort` | 모듈 코드를 자식 프로세스로 격리 실행 |
| 4 | `ILlmPort` | AI 질의 (JSON 파싱 `ask` + 텍스트 `askText` + `getModelId`). 요청별 `LlmCallOpts.model`로 모델 오버라이드 |
| 5 | `INetworkPort` | 경량 HTTP 통신 (Sandbox 없이) |
| 6 | `ICronPort` | 스케줄링 등록/해제/목록 + 타임존 관리 |
| 7 | `IDatabasePort` | SQLite CRUD (PageSpec, 범용 쿼리) |
| 8 | `IVaultPort` | 시크릿 CRUD (`user:` 접두사 분리, 모듈 설정 JSON 저장) |
| 9 | `IMcpClientPort` | 외부 MCP 서버 연동 (도구 목록/호출) |

모든 포트 반환값은 `InfraResult<T>` 형태 (throw 금지, `{ success, data?, error? }` 반환).
예외: `ILogPort`는 리턴값 없음, `IVaultPort`와 `ICronPort.list()`는 동기 반환.

### FirebatInfraContainer
```typescript
interface FirebatInfraContainer {
  storage: IStoragePort;
  log: ILogPort;
  sandbox: ISandboxPort;
  llm: ILlmPort;
  network: INetworkPort;
  cron: ICronPort;
  database: IDatabasePort;
  vault: IVaultPort;
  mcpClient: IMcpClientPort;
}
```

---

## 제3장: Core Facade 패턴

`core/index.ts`의 `FirebatCore` 클래스가 **유일한 비즈니스 로직 진입점**이다.

### 제1항. 포트 직접 접근 금지
외부에서 `core.infra.storage` 등 포트를 직접 호출하지 않는다.
모든 API route는 `getCore()` → Core 메서드 호출 패턴을 따른다.

### 제1-1항. 10-Manager 아키텍처 (2026-04-14)
`FirebatCore`는 **얇은 라우팅 파사드**. 비즈니스 로직은 10개 도메인 매니저에 위임한다.

| 매니저 | 인프라 포트 | Core 참조 | 역할 |
|---|---|---|---|
| AiManager | ILlmPort, ILogPort | ✅ | AI 채팅, Plan-Execute |
| StorageManager | IStoragePort | ✗ | 파일 CRUD |
| PageManager | IDatabasePort, IStoragePort | ✗ | 페이지 CRUD |
| ProjectManager | IStoragePort, IDatabasePort | ✗ | 프로젝트 스캔/삭제 |
| ModuleManager | ISandboxPort, IStoragePort, IVaultPort | ✗ | 모듈 실행 |
| TaskManager | ILlmPort, ILogPort | ✅ | 파이프라인 즉시 실행 |
| ScheduleManager | ICronPort, ILogPort | ✅ | 크론/예약 CRUD |
| SecretManager | IVaultPort, IStoragePort | ✗ | 시크릿 관리 |
| McpManager | IMcpClientPort | ✗ | MCP 클라이언트 |
| CapabilityManager | IStoragePort, IVaultPort, ILogPort | ✗ | Provider 해석 |

**규칙**:
- 매니저는 자기 도메인의 인프라 포트를 **생성자에서 직접** 받는다.
- 크로스 도메인 호출이 필요한 매니저(AI, Schedule)는 추가로 `FirebatCore` 참조를 받는다.
- 매니저끼리 직접 호출 **금지** — Core가 유일한 중재자.
- SSE 이벤트는 Core 파사드 메서드에서 발행. 예외: ScheduleManager.handleTrigger (비동기 크론 콜백).
- **TaskManager ↔ ScheduleManager 관계**: TaskManager가 파이프라인 실행 엔진 담당. ScheduleManager는 크론 트리거 시 Core.runTask()로 TaskManager에 위임.
- 로깅(ILogPort), 네트워크(INetworkPort)는 횡단 관심사 — 매니저 불필요, 포트 직접 사용.

### 제2항. Core 주요 메서드 영역
| 영역 | 메서드 |
|---|---|
| AI 채팅 | `requestAction`, `planOnly`, `executePlan` |
| 모듈 실행 | `runModule` |
| 파일 시스템 | `readFile`, `writeFile`, `deleteFile`, `getFileTree` |
| 프로젝트 | `scanProjects`, `deleteProject` |
| 시스템 모듈 | `getSystemModules`, `getModuleSettings`, `setModuleSettings` |
| 페이지 | `listPages`, `getPage`, `savePage`, `deletePage`, `listStaticPages` |
| 태스크 | `runTask`, `validatePipeline` |
| 크론 | `listCronJobs`, `cancelCronJob`, `updateCronJob`, `getCronLogs` |
| 시크릿 | `listUserSecrets`, `setUserSecret`, `getUserSecret`, `deleteUserSecret` |
| 시스템 설정 | `getTimezone`, `setTimezone`, `getSeoSettings` |
| MCP | `listMcpServers`, `addMcpServer`, `removeMcpServer`, `callMcpTool` |
| Capability | `listCapabilities`, `getCapabilityProviders`, `resolveCapability`, `getCapabilitySettings` |
| 코드 어시스트 | `codeAssist` |
| 매니저 전용 파사드 | `log`, `askLlm`, `askLlmText`, `getLlmModelId`, `networkFetch`, `sandboxExecute`, `listDir`, `listFiles`, `queryDatabase`, `scheduleCronJob` |

---

## 제4장: Core 실행 파이프라인

### Step 1. Plan 수립 (Planning)
사용자 명령을 `ILlmPort`에 전달. JSON Schema 형태로만 응답하도록 System 프롬프트를 강제한다.

### Step 2. 심사 (Validation)
`ILlmPort` 응답을 `Zod` 스키마로 파싱. 실패 시 최대 3회 재시도 (Self-Correction).
파싱 후 `description` 필드가 빈 경우 `action.type`으로 자동 폴백.

### Step 3. 집행 (Execution)
확정된 Plan의 `actions` 배열을 순회하며 포트를 호출한다:

| 액션 | 호출 포트 |
|---|---|
| `WRITE_FILE`, `APPEND_FILE`, `DELETE_FILE`, `READ_FILE`, `LIST_DIR` | `IStoragePort` |
| `TEST_RUN` | `ISandboxPort` |
| `NETWORK_REQUEST` | `INetworkPort` |
| `SCHEDULE_TASK`, `CANCEL_TASK`, `LIST_TASKS` | `ICronPort` |
| `SAVE_PAGE`, `DELETE_PAGE`, `LIST_PAGES`, `DATABASE_QUERY` | `IDatabasePort` |
| `REQUEST_SECRET`, `SET_SECRET` | `IVaultPort` |
| `RUN_TASK` | TaskManager (파이프라인 즉시 실행) |
| `MCP_CALL` | `IMcpClientPort` |
| `OPEN_URL` | 프론트엔드 반환 (미리보기 버튼) |

### Step 4. 결과 보고
`ILogPort.info()`로 최종 결과를 기록하고 프론트엔드에 응답 반환.

---

## 제5장: FirebatPlan 데이터 모델

LLM과 통신하는 유일한 제어 프로토콜.

```typescript
type FirebatAction =
  | { type: 'WRITE_FILE', path: string, content: string }
  | { type: 'APPEND_FILE', path: string, content: string }
  | { type: 'DELETE_FILE', path: string }
  | { type: 'READ_FILE', path: string }
  | { type: 'LIST_DIR', path: string }
  | { type: 'TEST_RUN', path: string, mockData?: any }
  | { type: 'NETWORK_REQUEST', url: string, method: string, body?: any, headers?: Record<string, string> }
  | { type: 'RUN_TASK', pipeline: PipelineStep[] }
  | { type: 'SCHEDULE_TASK', jobId: string, targetPath?: string, cronTime?: string, runAt?: string, delaySec?: number, pipeline?: PipelineStep[] }
  | { type: 'CANCEL_TASK', jobId: string }
  | { type: 'LIST_TASKS' }
  | { type: 'DATABASE_QUERY', query: any }
  | { type: 'SAVE_PAGE', slug: string, spec: object }
  | { type: 'DELETE_PAGE', slug: string }
  | { type: 'LIST_PAGES' }
  | { type: 'OPEN_URL', url: string }
  | { type: 'REQUEST_SECRET', key: string, description: string }
  | { type: 'SET_SECRET', key: string, value: string }
  | { type: 'MCP_CALL', server: string, tool: string, arguments: any };

interface FirebatPlan {
  thoughts: string;        // AI의 판단 요약
  actions: FirebatAction[]; // 실행할 물리적 액션 배열
}
```

---

## 제6장: Core Managers

`core/managers/`에 위치하는 관리자 클래스.

### AiManager (구 UserAiManager)
- 모든 사용자 AI 요청을 처리. ILlmPort, ILogPort 직접 주입.
- `process()`: 한방 실행 (Plan 수립 + 실행)
- `planOnly()`: Plan만 수립 (실행 안 함)
- `executePlan()`: 확정된 Plan 단계별 실행 (SSE 콜백)
- `codeAssist()`: 코드 편집 AI 어시스턴트
- 크로스 도메인: `this.core.writeFile()`, `this.core.savePage()` 등 Core 경유
- 학습 데이터를 `[USER_AI_TRAINING]` 프리픽스로 로깅.

### StorageManager
- 파일 CRUD + 디렉토리/트리 조회. IStoragePort 직접 주입.

### PageManager
- 페이지 CRUD + 정적 페이지 목록. IDatabasePort, IStoragePort 직접 주입.

### ProjectManager
- 프로젝트 스캔/삭제. IStoragePort, IDatabasePort 직접 주입.

### ModuleManager
- 모듈 실행 (이름/경로), 시스템 모듈 설정. ISandboxPort, IStoragePort, IVaultPort 직접 주입.

### TaskManager
- 파이프라인 즉시 실행 엔진. ILlmPort, ILogPort 직접 주입 + Core 참조.
- `executePipeline()`: 4가지 단계(TEST_RUN, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM) 순차 실행.
- `validatePipeline()`: 필수 필드 사전 검증 (ScheduleManager에서도 사용).
- `$prev` 치환: 재귀적 `resolveValue()`로 inputData/inputMap 모든 위치에서 자동 전달.

### ScheduleManager
- 크론/예약 CRUD. ICronPort, ILogPort 직접 주입 + Core 참조.
- `onTrigger` 콜백에서 파이프라인은 Core.runTask()로 TaskManager에 위임, 모듈/URL은 직접 처리.
- SSE 직접 발행 (비동기 크론 콜백 예외).

### SecretManager
- Vault 시크릿 관리 (사용자/시스템). IVaultPort, IStoragePort 직접 주입.

### McpManager
- MCP 클라이언트 조작 (서버 CRUD, 도구 호출). IMcpClientPort 직접 주입.

### CapabilityManager
- Capability-Provider 해석 + 설정. IStoragePort, IVaultPort, ILogPort 직접 주입.

### CoreAiManager (v1+ 활성화 예정)
- 시스템 내부 분석용 판단 함수. ILlmPort, ILogPort 직접 주입.
- `[CORE_AI_TRAINING]` 프리픽스로 로깅.

---

## 제7장: Primary Adapter 규약 (app/api/)

### 제1항. 인프라 직접 인스턴스화 금지
`app/api/`에서 어댑터를 직접 생성하지 않는다.

### 제2항. 반드시 Core 경유
모든 비즈니스 로직은 `FirebatCore`를 통해 실행한다.
예외: 인증(`/api/auth`)은 부트스트랩 영역으로 Core 경유 대상에서 제외.

### 제3항. Core Singleton 패턴
```typescript
import { getCore } from '../../lib/singleton';
const core = getCore(); // 싱글톤 Core 획득
```
LLM 모델 오버라이드가 필요한 경우 Core 메서드의 `opts` 파라미터로 전달:
```typescript
const result = await core.requestAction(prompt, history, { model: 'gemini-2.5-pro' });
```

---

## 제8장: 로깅 규격

모든 AI 요청 로그에 다음을 필수 포함:
- `correlationId`: 요청 추적 ID (8자리 랜덤)
- `modelId`: 사용된 LLM 모델명
- `durationMs`: 소요 시간 (밀리초)
- 로그 레벨: `INFO`(정상), `WARN`(스키마 실패), `ERROR`(LLM/액션 실패), `DEBUG`(부팅 등 개발용)

학습 데이터는 `training-YYYY-MM-DD.jsonl`에 자동 분리 저장.

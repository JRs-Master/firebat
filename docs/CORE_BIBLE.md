# FIREBAT CORE BIBLE — 순수 판독과 지휘의 성역

> 최종 개정: 2026-04-16 (v0.1)

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

## 제2장: 15대 포트(Port) 규격

Core가 Infra에게 요구하는 15개 포트 인터페이스. 모두 `core/ports/index.ts`에 정의된다.

| # | 포트 | 역할 |
|---|---|---|
| 1 | `IStoragePort` | 파일 읽기/쓰기/삭제/목록 조회 |
| 2 | `ILogPort` | 4레벨 로깅 (info/warn/error/debug) |
| 3 | `ISandboxPort` | 모듈 코드를 자식 프로세스로 격리 실행 |
| 4 | `ILlmPort` | AI 질의 (`ask` JSON + `askText` 텍스트 + `askWithTools` Function Calling + `getModelId`). 요청별 `LlmCallOpts.model`로 모델 오버라이드, `LlmCallOpts.onChunk`로 스트리밍 |
| 5 | `INetworkPort` | 경량 HTTP 통신 (Sandbox 없이) |
| 6 | `ICronPort` | 스케줄링 등록/해제/목록 + 타임존 관리 |
| 7 | `IDatabasePort` | SQLite CRUD (PageSpec, 범용 쿼리) |
| 8 | `IVaultPort` | 시크릿 CRUD (`user:` 접두사 분리, 모듈 설정 JSON 저장) |
| 9 | `IMcpClientPort` | 외부 MCP 서버 연동 (도구 목록/호출) |
| 10 | `IAuthPort` | 세션 토큰 + API 토큰 관리 (Vault 기반) |
| 11 | `IEmbedderPort` | 텍스트 임베딩 (multilingual-e5-small). embedQuery/embedPassage/cosine/버전 |
| 12 | `IToolRouterPort` | self-learning 도구·컴포넌트 라우팅 (`ToolRouterFactory(modelId)` 로 생성) |
| 13 | `IMediaPort` | 미디어 저장/조회 (save/list/remove/saveVariant/updateMeta/saveErrorRecord) |
| 14 | `IImageProcessorPort` | sharp 이미지 후처리 (resize/format convert/blurhash) |
| 15 | `IImageGenPort` | 이미지 생성 (OpenAI gpt-image / Gemini 3 Image) |

모든 포트 반환값은 `InfraResult<T>` 형태 (throw 금지, `{ success, data?, error? }` 반환).
예외: `ILogPort`는 리턴값 없음, `IVaultPort`와 `ICronPort.list()`는 동기 반환, `IEmbedderPort`는 Float32Array 반환.

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
  auth: IAuthPort;
  embedder: IEmbedderPort;
  toolRouter: ToolRouterFactory;  // (modelId: string) => IToolRouterPort
  media: IMediaPort;
  imageProcessor: IImageProcessorPort;
  imageGen: IImageGenPort;
}
```

---

## 제3장: Core Facade 패턴

`core/index.ts`의 `FirebatCore` 클래스가 **유일한 비즈니스 로직 진입점**이다.

### 제1항. 포트 직접 접근 금지
외부에서 `core.infra.storage` 등 포트를 직접 호출하지 않는다.
모든 API route는 `getCore()` → Core 메서드 호출 패턴을 따른다.

### 제1-1항. 17-Manager 아키텍처 (2026-04-20, 2026-04-26 4 매니저 추가 + ImageManager → MediaManager rename)
`FirebatCore`는 **얇은 라우팅 파사드**. 비즈니스 로직은 17개 도메인 매니저에 위임한다.

| 매니저 | 인프라 포트 | Core 참조 | 역할 |
|---|---|---|---|
| AiManager | ILlmPort, ILogPort, IDatabasePort, ToolRouterFactory | ✅ | AI 채팅 멀티턴 도구 루프, Function Calling 오케스트레이터 |
| StorageManager | IStoragePort | ✗ | 파일 CRUD |
| PageManager | IDatabasePort, IStoragePort | ✗ | 페이지 CRUD + media_usage 인덱스 |
| ProjectManager | IStoragePort, IDatabasePort | ✗ | 프로젝트 스캔/삭제 |
| ModuleManager | ISandboxPort, IStoragePort, IVaultPort | ✗ | 모듈 실행 + SEO 모듈 설정 |
| TaskManager | ILlmPort, ILogPort | ✅ | 파이프라인 즉시 실행 + StatusManager step 통합 |
| ScheduleManager | ICronPort, ILogPort | ✅ | 크론/예약 CRUD |
| SecretManager | IVaultPort, IStoragePort | ✗ | 시크릿 관리 |
| McpManager | IMcpClientPort | ✗ | MCP 클라이언트 (timeout + auto-reconnect) |
| CapabilityManager | IStoragePort, IVaultPort, ILogPort | ✗ | Provider 해석 |
| AuthManager | IAuthPort, IVaultPort | ✗ | 통합 인증 (세션+API 토큰), rate limit, lastUsedAt 추적 |
| ConversationManager | IDatabasePort, IEmbedderPort | ✗ | 대화 DB 저장/검색 (이미지 메타 인덱스 포함) |
| MediaManager | IImageGenPort, IMediaPort, IImageProcessorPort, IVaultPort, ILogPort | ✗ | 미디어 도메인 단일 — 생성/재생성/CRUD/갤러리/OG 안전성/이미지 모델 (이전 ImageManager rename) |
| EventManager | ILogPort | ✗ | SSE 이벤트 발행 + audit log + filtered subscribe |
| StatusManager | ILogPort, EventManager | ✗ | Long-running job 상태 단일 source (UI 진행도 + AI 비동기 도구 backbone). Image/Cron/Task 마이그레이션 완료 |
| CostManager | IVaultPort, ILogPort | ✗ | LLM 호출 token·비용 누적 (60초 dirty flush) |
| ToolManager | ILogPort | ✗ | 도구 등록·dispatch 단일 source (Step 1 backbone 완료 / Step 2-5 AiManager Phase 6c 와 묶음, v1.x) |

**규칙**:
- 매니저는 자기 도메인의 인프라 포트를 **생성자에서 직접** 받는다.
- 크로스 도메인 호출이 필요한 매니저(AI, Schedule)는 추가로 `FirebatCore` 참조를 받는다.
- 매니저끼리 직접 호출 **금지** — Core가 유일한 중재자.
- SSE 이벤트는 **Core 파사드 메서드에서만 발행** — 예외 0건 (v0.1, 2026-04-21).
  - 비동기 트리거 콜백 (cron/webhook/WebSocket/FS watcher 등) 도 Core facade 경유. 인프라 어댑터가 callback 등록 시 `core.handleXxx()` 호출하도록 closure 로 Core 참조 전달.
  - 예: `cron.onTrigger((info) => core.handleCronTrigger(info))` — Manager 직접 호출 X. Core 가 Manager 메서드 호출 후 SSE emit.
- **TaskManager ↔ ScheduleManager 관계**: TaskManager가 파이프라인 실행 엔진 담당. ScheduleManager는 크론 트리거 시 Core.runTask()로 TaskManager에 위임.
- 로깅(ILogPort), 네트워크(INetworkPort)는 횡단 관심사 — 매니저 불필요, 포트 직접 사용.

### 제2항. Core 주요 메서드 영역
| 영역 | 메서드 |
|---|---|
| AI 채팅 | `requestActionWithTools` (Function Calling 유일 경로), `codeAssist`, `resolveCallTarget` |
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

## 제4장: Core 실행 파이프라인 (Function Calling 모드)

> **2026-04-22 갱신** — 레거시 JSON 모드 (planOnly + executePlan + FirebatActionSchema) 전면 삭제.
> Function Calling 멀티턴 도구 루프가 **유일 경로**.

### Step 1. 도구 정의 빌드
`AiManager.buildToolDefinitions()` 가 매 요청마다 도구 목록 생성:
- 정적 27개 Core 도구 (`render_*`, `image_gen`, `search_history`, `save_page`, `schedule_task` 등 — `core/managers/ai/tool-schemas.ts`)
- 동적 sysmod 도구 (`sysmod_kiwoom`, `sysmod_naver-search` 등 — config.json description 자동 주입)
- 외부 MCP 도구 (`mcp_*` 접두사로 서버별 prefix)

### Step 2. 멀티턴 도구 루프
`ILlmPort.askWithTools()` → AI 가 도구 호출 → `executeToolCall(name, args)` → 결과 → 다시 askWithTools (max 10 turns):
- 매 turn 의 thinking·도구 호출 SSE 스트리밍 (`onChunk`, `onToolCall`)
- 멀티턴 종료 = AI 가 도구 호출 없는 텍스트 응답 발행

### Step 3. 도구 dispatch
`AiManager.executeToolCall(name, args)` switch dispatch (Phase 6c 분리 예정):
- `render_*` → `{component, props}` 반환 (UI block)
- `image_gen` → MediaManager.generate (StatusManager wrap, gallery:refresh emit)
- `save_page` → PageManager.save + media_usage 인덱스 갱신
- `schedule_task` / `run_task` → ScheduleManager / TaskManager (PIPELINE_STEP_SCHEMA 7-step 검증)
- `sysmod_*` / `mcp_*` → resolveCallTarget 으로 모듈 경로 / MCP 서버 자동 라우팅

### Step 4. 결과 보고
`AiManager.processWithTools()` 반환 = `{success, reply, blocks, executedActions, suggestions, pendingActions}`.
SSE result 이벤트로 프론트엔드 전달. 학습 데이터 (`data/logs/training-*.jsonl`) 자동 저장.

---

## 제5장: 도구 호출 데이터 모델 (Function Calling)

```typescript
// core/ports/index.ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;       // OpenAI/Anthropic/Gemini 모두 호환
  strict?: boolean;             // OpenAI strict mode (선택)
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  result: unknown;              // dispatch 반환값
}

export interface ToolExchangeEntry {
  type: 'call' | 'result';
  data: ToolCall | ToolResult;
}

// 27 정적 도구 schema → core/managers/ai/tool-schemas.ts
// 모듈 도구 schema → config.json input/output 에서 동적 추출
// 외부 MCP 도구 schema → mcp.listTools() 자동 reflection
```

**Pipeline (cron + run_task 의 multi-step 정의)** — 7가지 step:

```typescript
type PipelineStep =
  | { type: 'EXECUTE', path: string, inputData?, inputMap? }            // 모듈 (sandbox)
  | { type: 'MCP_CALL', server: string, tool: string, arguments? }      // 외부 MCP
  | { type: 'NETWORK_REQUEST', url, method, headers?, body? }            // HTTP fetch
  | { type: 'LLM_TRANSFORM', instruction: string, inputMap? }           // AI 텍스트 변환
  | { type: 'CONDITION', field, op, value }                              // 분기/early-stop
  | { type: 'SAVE_PAGE', slug, spec? | inputMap }                        // 페이지 저장
  | { type: 'TOOL_CALL', tool: string, inputData? }                      // Function Calling 도구 (image_gen 등)
```

레거시 `FirebatPlan` / `FirebatActionSchema` / `WRITE_FILE` / `OPEN_URL` 등 액션 타입 모두 v0.1 2026-04-22 제거됨.

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
- `executePipeline()`: 4가지 단계(EXECUTE, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM) 순차 실행.
- `validatePipeline()`: 필수 필드 사전 검증 (ScheduleManager에서도 사용).
- `$prev` 치환: 재귀적 `resolveValue()`로 inputData/inputMap 모든 위치에서 자동 전달.

### ScheduleManager
- 크론/예약 CRUD. ICronPort, ILogPort 직접 주입 + Core 참조.
- `cron.onTrigger((info) => core.handleCronTrigger(info))` — 비동기 트리거 콜백도 Core facade 경유 (BIBLE 일관, 예외 0건).
- handleTrigger 는 작업만 수행, SSE emit 은 Core.handleCronTrigger 가 담당.

### SecretManager
- Vault 시크릿 관리 (사용자/시스템). IVaultPort, IStoragePort 직접 주입.

### McpManager
- MCP 클라이언트 조작 (서버 CRUD, 도구 호출). IMcpClientPort 직접 주입.

### CapabilityManager
- Capability-Provider 해석 + 설정. IStoragePort, IVaultPort, ILogPort 직접 주입.

### CoreAiManager (v1+ 재설계)
- 시스템 내부 자기진화용 AI. v0.1 스텁은 레거시 `requestAction` 을 참조했으나 2026-04-22 삭제.
- v1.0 재활성화 시 Function Calling (`requestActionWithTools`) 경로 위에서 새로 설계.

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
const result = await core.requestActionWithTools(prompt, history, { model: 'gemini-3.1-pro-preview' });
```

---

## 제8장: 로깅 규격

모든 AI 요청 로그에 다음을 필수 포함:
- `correlationId`: 요청 추적 ID (8자리 랜덤)
- `modelId`: 사용된 LLM 모델명
- `durationMs`: 소요 시간 (밀리초)
- 로그 레벨: `INFO`(정상), `WARN`(스키마 실패), `ERROR`(LLM/액션 실패), `DEBUG`(부팅 등 개발용)

학습 데이터는 `training-YYYY-MM-DD.jsonl`에 자동 분리 저장.

---

## 제9장: AI Assistant + 통합 Resolver (v0.1, 2026-04-21)

### 제1항. 3개 AI 역할 구분

| AI | 역할 | Vault 키 / 위치 |
|---|---|---|
| **User AI** | 어드민 채팅의 메인 모델. 사용자가 설정에서 선택. | `system:ai-model` |
| **AI Assistant** | 백엔드 헬퍼. 도구 라우터 + needs_previous_context 판정 + 자동 search_history 주입. | `system:ai-router:model` |
| **Code Assistant** | 모나코 에디터 (FileEditor) 의 코드 어시스트 — User AI 와 같은 모델, 시스템 프롬프트만 다름. | (User AI 모델 공유) |

User Prompt (사용자 지시사항, `system:user-prompt`) 는 **User AI 만** 주입. AI Assistant·Code Assistant 는 미주입 (라우팅 정확도·코드 품질 보호).

### 제2항. AI Assistant 모델 선택

`lib/vault-keys.ts` 의 `AI_ASSISTANT_MODELS`:
```ts
export const DEFAULT_AI_ASSISTANT_MODEL = 'gemini-3.1-flash-lite-preview';
export const AI_ASSISTANT_MODELS = ['gemini-3.1-flash-lite-preview', 'gpt-5-nano'];
```

Core 파사드: `getAiAssistantModel` / `setAiAssistantModel` / `getAvailableAiAssistantModels`.

### 제3항. 통합 호출 Resolver

**문제:** AI 가 도구 호출 시 일관성 부족 — `kakao_talk` / `kakao-talk` / `sysmod_kakao_talk` / `system/modules/kakao-talk/index.mjs` 등 다양한 형태.

**해법:** `AiManager.resolveCallTarget(identifier)` — 비즈니스 로직.
1. MCP 서버 (외부 등록) 검색 → `{ kind: 'mcp', server }`
2. `system/modules/*` + `user/modules/*` 폴더 검색 → `{ kind: 'execute', path }`
3. 변형 매칭: name / snake / kebab / `sysmod_` 접두사 / full path 모두 인식
4. 60초 캐시

**Core 파사드 (BIBLE 준수, 1줄 wrapper):**
```ts
async resolveCallTarget(identifier: string) {
  return this.ai.resolveCallTarget(identifier);
}
```

**적용 위치:**
- `AiManager.executeToolCall` default case — 일반 대화 도구 호출
- `TaskManager.runPipeline` MCP_CALL step — server 가 module 명이면 EXECUTE 로 자동 변환
- `TaskManager.runPipeline` EXECUTE step — bare name → full path 정규화

매니저 간 직접 호출 금지 원칙 준수: TaskManager → Core.resolveCallTarget → AiManager.resolveCallTarget.

### 제4항. Plan Follow-Through (planExecuteId / planReviseId)

`lib/plan-store.ts` — propose_plan 호출 시 planId 발급 + steps 저장 (in-memory map, 30분 TTL, max 50).

**✓실행 (planExecuteId):**
1. propose_plan 결과 suggestions 에 `{ type: 'plan-confirm', planId, label }` 동봉
2. 사용자 ✓실행 클릭 → frontend 가 planExecuteId 동봉 chat 요청
3. Backend: plan-store 조회 → `planToInstruction(plan, originalRequest)` → 시스템 프롬프트 맨 앞 prepend
4. AI 가 단계별 실행 (시각·예약 표현 인식 시 `schedule_task` wrap)

**⚙수정 제안 (planReviseId):**
1. suggestions 에 `{ type: 'plan-revise', planId, label, placeholder }` 동봉
2. 사용자 입력 시 planReviseId + 피드백 텍스트 전송
3. Backend: `planToReviseInstruction` → "⚙ plan 재작성 모드" 룰 강제 → AI 가 propose_plan 재호출 (새 planId)
4. 새 PlanCard 발급 → 사용자 다시 ✓실행/⚙수정 가능 (반복)

### 제5항. AI Assistant 자동 history 주입

AI Assistant ON 시:
1. `routeTools` LLM 호출에서 `needs_previous_context` 동시 판정 (모든 모델 — Gemini API 만이 아니라 GPT/Claude/CLI 도)
2. 도구 필터링은 Gemini API 만 (CLI 자체 처리, hosted MCP 는 서버측)
3. needs_previous_context=true → backend 가 `search_history` 자동 호출 + 결과 시스템 프롬프트 prepend
4. User AI 도구 목록에서 `search_history` 제외 (중복 방지)

### 제6항. 플랜모드 토글 (입력창)

사용자가 명시적으로 ON/OFF 제어. localStorage `firebat_plan_mode` 영속:
- **ON**: 모든 요청에 `propose_plan` 강제 (예외 0건). `planModePrefix` 가 시스템 프롬프트 맨 앞 prepend.
- **OFF**: AI 자유 판단 (도구 그대로 유지, AI 가 알아서 호출).

---

## 제10장: 프론트엔드 매니저 3종 (v0.1, 2026-04-22)

어드민 UI 의 상태 관리를 3개 매니저로 분리. 이전엔 `useChat` 내부 7군데 흩어진 `setMessages` 호출로 상태 전이가 추적 불가 → 로봇 사라짐·빈 버블 버그 반복. Core 17-Manager 와 같이 **UI 도메인별 담당구역 명시화**.

### 제1항. 위치 규칙

모든 프론트 매니저는 `app/admin/hooks/` 에 위치. React hooks + 순수 함수만 사용. 외부 라이브러리 (Redux / Zustand / XState) 도입 금지.

### 제2항. ChatManager (`chat-manager.ts` + `useChat.ts`)

담당구역: 채팅 메시지 + 대화 + plan + SSE 스트림 + abort + watchdog + DB sync.

**핵심 원리 — 인바리언트 기반 상태 머신**:
- `chatReducer(state, action)` 이 **유일한** 상태 전이 지점 (이전: 7군데 흩어진 setMessages)
- 모든 SSE 이벤트·watchdog·abort·finally 가 `ChatAction` 으로 통일 디스패치
- `enforceInvariant`: 터미널 상태 (`!isThinking && !executing && !streaming`) 인데 visible 콘텐츠 0 이면 자동 fallback. **구조적으로 로봇 사라짐 불가능**.

**판정 함수**:
- `isTerminal(m)`: 진행 중 플래그 전부 false 인지
- `hasVisible(m)`: content / error / blocks / pendingActions / suggestions / user-image / system-init 중 하나라도 있는지

**액션 목록** (20여 종):
- 로드/전환: `LOAD`, `SEND_USER`, `SEND_SUGGESTION`
- SSE: `CHUNK_TEXT`, `CHUNK_THINKING`, `PLAN`, `STEP`, `RESULT`, `RESULT_ANIM_TICK`, `ERROR`
- 종료 안전망: `ABORTED`, `TIMEOUT`, `NETWORK_ERROR`, `FINALIZE`
- Plan: `CONFIRM_PLAN_START`, `REJECT_PLAN`
- Pending: `PENDING_APPROVED / REJECTED / PAST_RUNAT / ERROR`

**Side effect 분리**: reducer 는 순수 함수. 훅이 fetch·타이머·DB·scroll 을 담당하고 action 만 디스패치.

**Fallback 문구 중앙 관리**: `FALLBACK.{EMPTY_REPLY|INVISIBLE|TIMEOUT|NETWORK|ABORTED|REJECTED}` 한 곳에.

### 제3항. EventsManager (`events-manager.ts`)

담당구역: SSE `/api/events` 단일 구독 + fan-out + `firebat-refresh` window 이벤트 통합.

**이전 문제**: Sidebar, CronPanel 이 각자 `new EventSource('/api/events')` → 한 탭에 연결 2개. 모바일 배터리·서버 리소스 낭비.

**해결**: 모듈 싱글톤 `EventBusSingleton`. refCount 로 첫 구독 시 connect / 마지막 해지 시 close.

**훅 API**:
- `useEvents(types, handler)` — 특정 이벤트 타입만 필터
- `useLocalRefresh(handler)` — window `firebat-refresh` 만 구독
- `useSidebarRefresh(handler)` — SSE `sidebar:refresh` / `cron:complete` + `firebat-refresh` 통합 (Sidebar·CronPanel 공통 패턴)
- `emitLocalRefresh()` — `firebat-refresh` 발행 헬퍼

### 제4항. SettingsManager (`settings-manager.ts`)

담당구역: 타입 안전한 localStorage 스키마 + cross-tab 동기화.

**이전 문제**: `firebat_model` / `firebat_plan_mode` / `firebat_active_conv` / `firebat_last_model_by_category` / `firebat_editor_chat_*` 등 키 8개+ 가 여러 파일에 흩어짐. 오타·타입 불일치·탭 간 동기화 없음.

**해결**:
- `SettingsSchema` 타입에 키 등록 → 자동 타입 안전
- `useSetting(key)`: `useState` 와 동일 API + localStorage 영속 + `storage` 이벤트로 다른 탭 동기화
- `readSetting(key)` / `writeSetting(key, v)`: 훅 밖 즉시 접근 (초기 로드·저장 시점)

**직렬화 자동**: boolean → `'true'|'false'`, object → JSON, 나머지 raw.

### 제5항. 역할 경계 (Backend Core 와 명확히 분리)

| 구분 | 담당구역 | 위치 |
|---|---|---|
| Core 17-Manager | 도메인 비즈니스 로직, 포트 라우팅 | `core/managers/` |
| Frontend 3-Manager | UI 상태 전이, 브라우저 영속, 이벤트 구독 | `app/admin/hooks/` |

**금지 사항**:
- Frontend 매니저가 Core 내부 import 금지 — 반드시 `/api/*` HTTP 경유
- Frontend 매니저끼리 직접 호출 가능 (Core BIBLE 의 "매니저 간 직접 호출 금지" 제약은 Backend 에만 해당 — UI 상태는 서로 독립적이라 강제할 이유 없음)
- 외부 상태 라이브러리 (Redux / Zustand / XState / MobX) 도입 금지 — `useReducer` + `useState` + `useEffect` 로 충분

### 제6항. 새 프론트 매니저 추가 기준

아래 중 2개 이상 해당 시 새 매니저 신설 고려:
1. 상태 전이 지점이 3군데 이상 흩어져 있음
2. 여러 컴포넌트가 공유 subscribe 하는 이벤트 스트림
3. localStorage 키 3개+ 가 같은 도메인에 속함
4. 버그 재발이 같은 root cause 에서 3회 이상

1개만 해당하면 기존 매니저에 기능 추가 또는 로컬 훅으로 처리.

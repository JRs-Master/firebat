# FIREBAT I/O SCHEMA BIBLE — 전 계층 타입 계약서

> 최종 개정: 2026-04-15 (v0.1)

## 전문(前文)

본 문서는 Firebat의 **모든 통신 경계**에서 오가는 데이터의 타입을 엄격히 정의한다.

### 3대 철칙
1. **예외 없음** — 모든 경로가 동일한 타입 규약을 따른다. "이 경우는 특별히..."는 없다.
2. **하드코딩 없음** — 모듈 I/O 스키마는 config.json에서 동적으로 파생한다. 코드에 특정 모듈의 파라미터를 직접 기재하지 않는다.
3. **뒷구멍 없음** — `any`, `as any`, `z.any()`, `optional chaining으로 타입 우회` 전부 금지. 모든 데이터는 명시적 타입을 갖는다.

### 통신 7계층
```
[Layer 1] Module config.json    — 모듈 입출력 JSON Schema
[Layer 2] Module I/O Protocol   — stdin/stdout 표준 포맷
[Layer 3] Infra Port Interface  — Port 메서드 시그니처
[Layer 4] InfraResult 응답      — Infra → Core 응답 봉투
[Layer 5] Core Facade Method    — Core 공개 메서드 시그니처
[Layer 6] FirebatAction/Plan    — AI ↔ Core 액션 스키마
[Layer 7] API Response          — Core → Frontend HTTP 응답
```

---

## 제1장: Module config.json I/O (Layer 1)

### 현행 문제
```json
"input": { "url": "string (required) — 스크래핑할 URL" }
```
자연어 기술 → 파싱 불가, 검증 불가, Function Calling 도구 정의 생성 불가.

### 개정: JSON Schema 형식

config.json의 `input`과 `output`은 **JSON Schema Draft 2020-12** 형식으로 정의한다.

```json
{
  "input": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": {
        "type": "string",
        "format": "uri",
        "description": "스크래핑할 URL"
      },
      "keyword": {
        "type": "string",
        "description": "이 키워드가 포함된 섹션만 추출"
      }
    },
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "required": ["url", "title", "text"],
    "properties": {
      "url":   { "type": "string", "description": "최종 URL" },
      "title": { "type": "string", "description": "페이지 제목" },
      "text":  { "type": "string", "description": "마크다운 형식 본문 텍스트" }
    },
    "additionalProperties": false
  }
}
```

### 필수 규칙
1. `input.type`은 반드시 `"object"`
2. `required` 배열은 반드시 명시 (빈 배열이라도)
3. 모든 property에 `type`과 `description` 필수
4. `additionalProperties: false` 필수 — 정의되지 않은 필드 유입 차단
5. enum 값이 있으면 `enum` 배열로 명시
6. 중첩 객체도 동일 규칙 재귀 적용
7. 배열은 `items` 스키마 필수

### 활용
- **AI Function Calling**: config.json `input` → Gemini tool definition의 `parameters`로 직접 전달
- **런타임 검증**: Sandbox가 모듈 실행 전 input을 스키마로 검증
- **AI 프롬프트**: config.json에서 도구 설명 자동 생성 (하드코딩 금지)

---

## 제2장: Module I/O Protocol (Layer 2)

### 입력 (System → Module stdin)
```typescript
interface ModuleInput {
  correlationId: string;     // 추적 ID
  data: Record<string, unknown>;  // config.json input 스키마에 맞는 데이터
}
```

### 출력 (Module → System stdout)
```typescript
interface ModuleOutput {
  success: boolean;
  data?: Record<string, unknown>;  // config.json output 스키마에 맞는 데이터
  error?: string;                  // success=false 시 에러 메시지
  code?: string;                   // 에러 식별 코드
}
```

`data`의 타입은 config.json의 `output` 스키마로 결정된다.
모듈이 반환하는 `data`는 반드시 `output` 스키마를 만족해야 한다.

---

## 제3장: Infra Port Interface (Layer 3)

### 원칙
- 모든 Port 메서드의 파라미터와 반환값은 **구체적 타입**을 사용한다.
- `any` 사용 금지. 범용 데이터는 `unknown` + 타입 가드로 처리한다.
- 비동기 메서드는 `Promise<InfraResult<T>>`를 반환한다.

### 포트별 타입 정의

#### ISandboxPort
```typescript
interface ISandboxPort {
  execute(targetPath: string, inputData: Record<string, unknown>): Promise<InfraResult<ModuleOutput>>;
}
```
- `inputData`: 모듈에 전달할 데이터 (config.json input 스키마 기반)
- 반환: `ModuleOutput` — 모듈의 stdout JSON 파싱 결과

#### ILlmPort
```typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LlmJsonResponse {
  thoughts: string;
  reply: string;
  actions: FirebatAction[];
  suggestions: Suggestion[];
}

interface ILlmPort {
  ask(prompt: string, systemPrompt?: string, history?: ChatMessage[], opts?: LlmCallOpts): Promise<InfraResult<LlmJsonResponse>>;
  askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>>;
  getModelId(): string;
}
```

#### INetworkPort
```typescript
interface NetworkRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeout?: number;
}

interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  data: string | Record<string, unknown>;  // Content-Type에 따라 결정
}

interface INetworkPort {
  fetch(url: string, options?: NetworkRequestOptions): Promise<InfraResult<NetworkResponse>>;
}
```

#### IDatabasePort
```typescript
/** 페이지 목록 항목 */
interface PageListItem {
  slug: string;
  title: string;
  status: string;
  project?: string;
  visibility?: 'public' | 'password' | 'private';
  updatedAt?: string;  // ISO 8601
  createdAt?: string;  // ISO 8601
}

/** PageSpec — 페이지 전체 데이터 */
interface PageSpec {
  slug: string;
  head?: PageHead;
  body?: PageComponent[];
  project?: string;
  _visibility?: 'public' | 'password' | 'private';
}

interface PageHead {
  title?: string;
  description?: string;
  keywords?: string[];
  robots?: string;
  canonical?: string;
  og?: {
    title?: string;
    description?: string;
    image?: string;
    type?: string;
  };
  meta?: Array<{ name?: string; property?: string; content: string }>;
  scripts?: Array<{ src: string; async?: boolean; crossorigin?: string; 'data-ad-client'?: string }>;
  styles?: Array<{ href: string }>;
}

/** 컴포넌트 타입은 discriminated union */
type PageComponent = 
  | { type: 'Hero'; title?: string; subtitle?: string; bgColor?: string; textColor?: string }
  | { type: 'Text'; content: string; align?: 'left' | 'center' | 'right' }
  | { type: 'Html'; html: string }
  | { type: 'Image'; src: string; alt?: string; width?: number; height?: number }
  | { type: 'Button'; label: string; href: string; variant?: 'primary' | 'secondary' | 'outline' }
  | { type: 'Card'; title?: string; description?: string; image?: string; link?: string }
  | { type: 'Grid'; columns?: number; items: PageComponent[] }
  | { type: 'Form'; fields: FormField[]; submitLabel?: string; action?: string; bindModule?: string }
  | { type: 'Table'; headers: string[]; rows: string[][] }
  | { type: 'Accordion'; items: Array<{ title: string; content: string }> }
  | { type: 'Tabs'; tabs: Array<{ label: string; content: string }> }
  | { type: 'Divider' }
  | { type: 'Spacer'; height?: number }
  | { type: 'Header'; level?: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'List'; ordered?: boolean; items: string[] }
  | { type: 'Quote'; text: string; author?: string }
  | { type: 'Code'; language?: string; code: string }
  | { type: 'Video'; src: string; poster?: string }
  | { type: 'Embed'; src: string; width?: number; height?: number }
  | { type: 'Map'; lat: number; lng: number; zoom?: number }
  | { type: 'Chart'; chartType: 'bar' | 'line' | 'pie' | 'doughnut'; data: ChartData }
  | { type: 'Countdown'; targetDate: string; label?: string };

interface FormField {
  name: string;
  label?: string;
  type: 'text' | 'email' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';
  required?: boolean;
  placeholder?: string;
  options?: string[];  // select 타입 시
}

interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
  }>;
}

interface IDatabasePort {
  query(sql: string, params?: unknown[]): Promise<InfraResult<Record<string, unknown>[]>>;
  listPages(): Promise<InfraResult<PageListItem[]>>;
  getPage(slug: string): Promise<InfraResult<PageSpec>>;
  savePage(slug: string, spec: string): Promise<InfraResult<void>>;
  deletePage(slug: string): Promise<InfraResult<void>>;
  listPagesByProject(project: string): Promise<InfraResult<string[]>>;
  deletePagesByProject(project: string): Promise<InfraResult<string[]>>;
  setPageVisibility(slug: string, visibility: 'public' | 'password' | 'private', password?: string): Promise<InfraResult<void>>;
  verifyPagePassword(slug: string, password: string): Promise<InfraResult<boolean>>;
}
```

#### ILogPort
```typescript
interface LogMeta {
  correlationId?: string;
  model?: string;
  durationMs?: number;
  [key: string]: string | number | boolean | undefined;
}

interface ILogPort {
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
}
```

#### IMcpClientPort
```typescript
interface IMcpClientPort {
  listServers(): McpServerConfig[];
  addServer(config: McpServerConfig): Promise<InfraResult<void>>;
  removeServer(name: string): Promise<InfraResult<void>>;
  listTools(serverName: string): Promise<InfraResult<McpToolInfo[]>>;
  listAllTools(): Promise<InfraResult<McpToolInfo[]>>;
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<InfraResult<unknown>>;
  disconnectAll(): Promise<void>;
}
```
- `callTool`의 `args`: MCP 도구 입력은 외부 스키마로 정의되므로 `Record<string, unknown>` 사용
- `callTool`의 반환 `data`: MCP 도구 출력도 외부 정의이므로 `unknown` — 사용처에서 타입 가드 필수

---

## 제4장: InfraResult 응답 봉투 (Layer 4)

```typescript
interface InfraResult<T> {
  success: boolean;
  data?: T;         // success=true 시 결과 데이터
  error?: string;   // success=false 시 에러 메시지
  code?: string;    // 에러 식별 코드 (예: 'TIMEOUT', 'NOT_FOUND', 'AUTH_FAILED')
  meta?: ResultMeta; // 실행 메타데이터
}

interface ResultMeta {
  durationMs?: number;
  cached?: boolean;
  model?: string;
  [key: string]: string | number | boolean | undefined;
}
```

### 규칙
1. `T`는 반드시 구체적 타입으로 지정 — `InfraResult<any>` 금지
2. `success=true`이면 `data`는 반드시 존재 (타입 가드로 좁히기)
3. `success=false`이면 `error`는 반드시 존재
4. `meta`는 `any`가 아닌 `ResultMeta`로 구조화

### 타입 가드 패턴
```typescript
function assertSuccess<T>(result: InfraResult<T>): asserts result is InfraResult<T> & { data: T } {
  if (!result.success) throw new Error(result.error ?? 'Unknown error');
}

// 사용
const result = await port.listPages();
if (result.success && result.data) {
  // result.data: PageListItem[]
}
```

---

## 제5장: PipelineStep Discriminated Union (Layer 3/6)

### 현행 문제
```typescript
interface PipelineStep {
  type: string;  // ← 어떤 문자열이든 가능
  path?: string; // ← 모든 필드가 optional
  ...
}
```
type이 `string`이므로 필수 필드 검증이 런타임에만 가능.

### 개정: Discriminated Union

```typescript
/** 파이프라인 단계 공통 필드 */
interface PipelineStepBase {
  description?: string;
}

/** EXECUTE — 모듈 실행 */
interface ExecuteStep extends PipelineStepBase {
  type: 'EXECUTE';
  path: string;                        // 모듈 경로 (필수)
  inputData?: Record<string, unknown>; // 고정 입력
  inputMap?: Record<string, unknown>;  // $prev 치환 매핑
}

/** MCP_CALL — 외부 MCP 도구 호출 */
interface McpCallStep extends PipelineStepBase {
  type: 'MCP_CALL';
  server: string;                      // MCP 서버 이름 (필수)
  tool: string;                        // 도구 이름 (필수)
  arguments?: Record<string, unknown>; // 도구 인자
  inputMap?: Record<string, unknown>;  // $prev 치환 매핑
}

/** NETWORK_REQUEST — HTTP 요청 */
interface NetworkRequestStep extends PipelineStepBase {
  type: 'NETWORK_REQUEST';
  url: string;                         // 요청 URL (필수)
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  inputData?: Record<string, unknown>;
  inputMap?: Record<string, unknown>;
}

/** LLM_TRANSFORM — LLM 변환 */
interface LlmTransformStep extends PipelineStepBase {
  type: 'LLM_TRANSFORM';
  instruction: string;                 // 변환 지시문 (필수)
  inputData?: Record<string, unknown>;
  inputMap?: Record<string, unknown>;
}

/** 파이프라인 단계 = 4가지 중 하나 */
type PipelineStep = ExecuteStep | McpCallStep | NetworkRequestStep | LlmTransformStep;
```

### Zod 스키마
```typescript
const ExecuteStepSchema = z.object({
  type: z.literal('EXECUTE'),
  description: z.string().optional(),
  path: z.string(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const McpCallStepSchema = z.object({
  type: z.literal('MCP_CALL'),
  description: z.string().optional(),
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const NetworkRequestStepSchema = z.object({
  type: z.literal('NETWORK_REQUEST'),
  description: z.string().optional(),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const LlmTransformStepSchema = z.object({
  type: z.literal('LLM_TRANSFORM'),
  description: z.string().optional(),
  instruction: z.string(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  inputMap: z.record(z.string(), z.unknown()).optional(),
});

const PipelineStepSchema = z.discriminatedUnion('type', [
  ExecuteStepSchema,
  McpCallStepSchema,
  NetworkRequestStepSchema,
  LlmTransformStepSchema,
]);
```

---

## 제6장: FirebatAction Discriminated Union (Layer 6)

### 현행 문제
- `inputData: z.any()` — 모듈에 전달하는 데이터가 무엇이든 허용
- `spec: z.any()` — PageSpec 구조 검증 없음
- `body: z.any()` — HTTP body 타입 불명
- `query: z.any()` — DB 쿼리 타입 불명
- SCHEDULE_TASK/RUN_TASK 내 pipeline step의 `type: z.string()` — 리터럴 유니온이어야 함

### 개정 원칙
1. `z.any()` → 구체적 스키마로 교체
2. `z.string()`으로 된 리터럴 값 → `z.literal()` 또는 `z.enum()`
3. `spec` → PageSpec 스키마 (제3장 IDatabasePort의 PageSpec 참조)
4. SCHEDULE_TASK/RUN_TASK의 pipeline → 제5장 PipelineStepSchema 사용

### 주요 변경점

```typescript
// EXECUTE
z.object({
  type: z.literal('EXECUTE'),
  path: z.string(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  // mockData 삭제 — inputData로 통일 (마이그레이션 기간 후)
})

// NETWORK_REQUEST
z.object({
  type: z.literal('NETWORK_REQUEST'),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

// SAVE_PAGE
z.object({
  type: z.literal('SAVE_PAGE'),
  slug: z.string(),
  spec: PageSpecSchema,  // z.any() → 구체적 PageSpec 스키마
})

// DATABASE_QUERY
z.object({
  type: z.literal('DATABASE_QUERY'),
  query: z.string(),                          // SQL 문자열
  params: z.array(z.unknown()).optional(),     // 바인딩 파라미터
})

// SCHEDULE_TASK — pipeline 필드에 PipelineStepSchema 적용
z.object({
  type: z.literal('SCHEDULE_TASK'),
  title: z.string().default(''),
  targetPath: z.string().optional(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  pipeline: z.array(PipelineStepSchema).optional(),
  cronTime: z.string().optional(),
  runAt: z.string().optional(),
  delaySec: z.number().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
})

// RUN_TASK
z.object({
  type: z.literal('RUN_TASK'),
  pipeline: z.array(PipelineStepSchema),
})

// MCP_CALL
z.object({
  type: z.literal('MCP_CALL'),
  server: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
})
```

---

## 제7장: Core Facade 메서드 시그니처 (Layer 5)

### 원칙
- Core 메서드의 파라미터와 반환값에 `any` 금지
- 범용 데이터 전달은 `Record<string, unknown>` 사용
- 반환값은 `InfraResult<구체타입>`

### 주요 변경

```typescript
class FirebatCore {
  // AI
  async requestAction(prompt: string, history: ChatMessage[], opts?: AiRequestOpts): Promise<CoreResult<FirebatPlan>>;
  async planOnly(prompt: string, history: ChatMessage[], opts?: AiRequestOpts): Promise<InfraResult<FirebatPlan>>;
  async executePlan(plan: FirebatPlan, corrId: string, opts?: AiRequestOpts, onStep?: StepCallback): Promise<CoreResult<ExecutionResult>>;

  // 모듈
  async runModule(moduleName: string, inputData: Record<string, unknown>): Promise<InfraResult<ModuleOutput>>;
  async sandboxExecute(targetPath: string, inputData: Record<string, unknown>): Promise<InfraResult<ModuleOutput>>;

  // 네트워크
  async networkFetch(url: string, options?: NetworkRequestOptions): Promise<InfraResult<NetworkResponse>>;

  // DB
  async queryDatabase(sql: string, params?: unknown[]): Promise<InfraResult<Record<string, unknown>[]>>;

  // MCP
  async callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<InfraResult<unknown>>;
}
```

### StepCallback / ExecutionResult
```typescript
interface StepProgress {
  index: number;
  total: number;
  type: string;
  status: 'start' | 'done' | 'error';
  error?: string;
}

type StepCallback = (step: StepProgress) => void;

interface ExecutionResult {
  executedActions: string[];
  results: Array<{ type: string; success: boolean; data?: unknown; error?: string }>;
}
```

---

## 제8장: CronScheduleOptions 타입 강화 (Layer 3/5)

```typescript
interface CronScheduleOptions {
  cronTime?: string;
  runAt?: string;       // ISO 8601
  delaySec?: number;
  startAt?: string;     // ISO 8601
  endAt?: string;       // ISO 8601
  inputData?: Record<string, unknown>;
  pipeline?: PipelineStep[];
  title?: string;
  description?: string;
}

interface CronTriggerInfo {
  jobId: string;
  targetPath: string;
  trigger: 'CRON_SCHEDULER' | 'SCHEDULED_ONCE' | 'DELAYED_RUN';  // 리터럴 유니온
  inputData?: Record<string, unknown>;
  pipeline?: PipelineStep[];
}

interface CronJobResult {
  jobId: string;
  targetPath: string;
  trigger: 'CRON_SCHEDULER' | 'SCHEDULED_ONCE' | 'DELAYED_RUN';
  success: boolean;
  durationMs: number;
  error?: string;
}

interface CronJobInfo {
  jobId: string;
  targetPath: string;
  title?: string;
  description?: string;
  cronTime?: string;
  runAt?: string;
  delaySec?: number;
  startAt?: string;
  endAt?: string;
  inputData?: Record<string, unknown>;
  pipeline?: PipelineStep[];
  createdAt: string;   // ISO 8601
  mode: 'cron' | 'once' | 'delay';
}
```

---

## 제9장: CoreResult 응답 봉투 (Layer 7)

```typescript
interface CoreResult<T> {
  success: boolean;
  thoughts?: string;
  reply?: string;
  executedActions: string[];
  data?: T;
  error?: string;
}
```

API route → Frontend 응답도 이 형식을 따른다.
`T`는 반드시 구체적 타입으로 지정.

---

## 제10장: Suggestion 타입 (Layer 6)

```typescript
type Suggestion =
  | string
  | { type: 'input'; label: string; placeholder?: string }
  | { type: 'toggle'; label: string; options: string[]; defaults?: string[] };
```

---

## 제11장: config.json 전체 스키마 (Layer 1)

```typescript
interface ModuleConfig {
  name: string;           // kebab-case 식별자
  type: 'module' | 'service' | 'reusable';
  scope: 'system' | 'user';
  version: string;        // semver
  description: string;
  runtime: 'node' | 'python' | 'bash' | 'rust' | 'wasm' | 'php' | 'native';

  // 유틸리티/모듈 전용
  packages?: string[];
  project?: string;
  secrets?: string[];
  capability?: string;
  providerType?: 'local' | 'api';

  // I/O 스키마 (JSON Schema)
  input: JsonSchema;      // 반드시 { type: "object", ... }
  output: JsonSchema;     // 반드시 { type: "object", ... }
}

/** JSON Schema 최소 부분집합 */
interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
  items?: JsonSchema | JsonSchemaProperty;
  description?: string;
}

interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  format?: string;        // 'uri', 'email', 'date-time' 등
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema | JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}
```

---

## 제12장: any 제거 마이그레이션 체크리스트

### core/types/index.ts
| 위치 | 현행 | 개정 |
|---|---|---|
| EXECUTE.inputData | `z.any()` | `z.record(z.string(), z.unknown())` |
| EXECUTE.mockData | `z.any()` | 삭제 (inputData로 통일) |
| NETWORK_REQUEST.body | `z.any()` | `z.union([z.string(), z.record(z.string(), z.unknown())])` |
| SAVE_PAGE.spec | `z.any()` | `PageSpecSchema` |
| DATABASE_QUERY.query | `z.any()` | `z.string()` |
| DATABASE_QUERY.params | `z.any()` | `z.array(z.unknown())` |
| SCHEDULE_TASK.inputData | `z.any()` | `z.record(z.string(), z.unknown())` |
| SCHEDULE_TASK.pipeline[].type | `z.string()` | `z.enum([...4가지])` |
| SCHEDULE_TASK.pipeline[].body | `z.any()` | `z.union([z.string(), z.record(...)])` |
| SCHEDULE_TASK.pipeline[].inputData | `z.any()` | `z.record(z.string(), z.unknown())` |
| SCHEDULE_TASK.pipeline[].inputMap | `z.record(z.string(), z.any())` | `z.record(z.string(), z.unknown())` |
| SCHEDULE_TASK.pipeline[].arguments | `z.record(z.string(), z.any())` | `z.record(z.string(), z.unknown())` |
| RUN_TASK (동일) | (위와 동일) | (위와 동일) |
| MCP_CALL.arguments | `z.record(z.string(), z.any())` | `z.record(z.string(), z.unknown())` |
| ModuleOutput.data | `z.any()` | `z.record(z.string(), z.unknown())` |
| InfraResult.meta | `any` | `ResultMeta` |
| CoreResult (전체) | `T = any` | `T`는 사용처에서 구체 지정 |

### core/ports/index.ts
| 위치 | 현행 | 개정 |
|---|---|---|
| ISandboxPort.execute inputData | `any` | `Record<string, unknown>` |
| ISandboxPort.execute 반환 | `InfraResult<any>` | `InfraResult<ModuleOutput>` |
| ILlmPort.ask history | `any[]` | `ChatMessage[]` |
| ILlmPort.ask 반환 | `InfraResult<any>` | `InfraResult<LlmJsonResponse>` |
| INetworkPort.fetch options | `any` | `NetworkRequestOptions` |
| INetworkPort.fetch 반환 | `InfraResult<any>` | `InfraResult<NetworkResponse>` |
| PipelineStep.type | `string` | discriminated union |
| PipelineStep.body | `any` | `string \| Record<string, unknown>` |
| PipelineStep.inputData | `any` | `Record<string, unknown>` |
| PipelineStep.inputMap | `Record<string, any>` | `Record<string, unknown>` |
| CronScheduleOptions.inputData | `any` | `Record<string, unknown>` |
| CronTriggerInfo.trigger | `string` | 리터럴 유니온 |
| CronTriggerInfo.inputData | `any` | `Record<string, unknown>` |
| IDatabasePort.query | `any, any` | `string, unknown[]` |
| IDatabasePort.listPages | `InfraResult<any[]>` | `InfraResult<PageListItem[]>` |
| IDatabasePort.getPage | `InfraResult<any>` | `InfraResult<PageSpec>` |
| McpToolInfo.inputSchema | `any` | `JsonSchema` |
| IMcpClientPort.callTool args | `any` | `Record<string, unknown>` |
| IMcpClientPort.callTool 반환 | `InfraResult<any>` | `InfraResult<unknown>` |
| ILogPort.meta | `any` | `LogMeta` |
| ICronPort.list 반환 | 인라인 타입 | `CronJobInfo[]` |

### core/index.ts (Core Facade)
| 위치 | 현행 | 개정 |
|---|---|---|
| requestAction history | `any[]` | `ChatMessage[]` |
| executePlan plan | `any` | `FirebatPlan` |
| runModule inputData | `any` | `Record<string, unknown>` |
| sandboxExecute inputData | `any` | `Record<string, unknown>` |
| networkFetch options | `any` | `NetworkRequestOptions` |
| networkFetch 반환 | `InfraResult<any>` | `InfraResult<NetworkResponse>` |
| queryDatabase | `any, any` | `string, unknown[]` |
| callMcpTool args | `any` | `Record<string, unknown>` |

---

## 제13장: 시스템 모듈 I/O 스키마 정규화

### firecrawl (web-scrape, api)

Firecrawl API v1 기준 전체 파라미터 반영:

```json
{
  "input": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": {
        "type": "string",
        "format": "uri",
        "description": "스크래핑할 URL"
      },
      "keyword": {
        "type": "string",
        "description": "이 키워드가 포함된 섹션만 추출 (Firebat 자체 후처리)"
      },
      "formats": {
        "type": "array",
        "items": { "type": "string", "enum": ["markdown", "html", "rawHtml", "links", "screenshot", "screenshot@fullPage"] },
        "default": ["markdown"],
        "description": "반환 포맷"
      },
      "onlyMainContent": {
        "type": "boolean",
        "default": true,
        "description": "메인 콘텐츠만 추출 (nav, footer 제외)"
      },
      "includeTags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "포함할 HTML 태그 목록"
      },
      "excludeTags": {
        "type": "array",
        "items": { "type": "string" },
        "description": "제외할 HTML 태그 목록"
      },
      "headers": {
        "type": "object",
        "additionalProperties": { "type": "string" },
        "description": "커스텀 HTTP 헤더"
      },
      "waitFor": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000,
        "default": 3000,
        "description": "페이지 로드 후 대기 시간 (ms)"
      },
      "timeout": {
        "type": "integer",
        "minimum": 1000,
        "maximum": 60000,
        "default": 30000,
        "description": "요청 타임아웃 (ms)"
      },
      "mobile": {
        "type": "boolean",
        "default": false,
        "description": "모바일 뷰포트 사용"
      },
      "skipTlsVerification": {
        "type": "boolean",
        "default": false,
        "description": "TLS 인증서 검증 건너뛰기"
      },
      "removeBase64Images": {
        "type": "boolean",
        "default": true,
        "description": "base64 인코딩 이미지 제거"
      },
      "blockAds": {
        "type": "boolean",
        "default": true,
        "description": "광고 차단"
      },
      "maxAge": {
        "type": "integer",
        "minimum": 0,
        "default": 0,
        "description": "캐시 최대 수명 (초). 0=캐시 미사용"
      }
    },
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "required": ["url", "title", "text"],
    "properties": {
      "url":   { "type": "string", "description": "최종 URL (리다이렉트 후)" },
      "title": { "type": "string", "description": "페이지 제목" },
      "text":  { "type": "string", "description": "마크다운 형식 본문 텍스트" },
      "html":  { "type": "string", "description": "HTML 원본 (formats에 html 포함 시)" },
      "links": {
        "type": "array",
        "items": { "type": "string", "format": "uri" },
        "description": "페이지 내 링크 목록 (formats에 links 포함 시)"
      },
      "screenshot": { "type": "string", "description": "스크린샷 URL (formats에 screenshot 포함 시)" }
    },
    "additionalProperties": false
  }
}
```

### kakao-talk (notification, api)

카카오톡 나에게 보내기 API 전체 파라미터 반영:

```json
{
  "input": {
    "type": "object",
    "required": ["text"],
    "properties": {
      "type": {
        "type": "string",
        "enum": ["text", "feed", "list"],
        "default": "text",
        "description": "메시지 타입"
      },
      "text": {
        "type": "string",
        "maxLength": 200,
        "description": "메시지 본문 (최대 200자)"
      },
      "link": {
        "type": "string",
        "format": "uri",
        "description": "버튼 클릭 시 이동할 URL"
      },
      "buttonTitle": {
        "type": "string",
        "default": "자세히 보기",
        "description": "버튼 텍스트"
      },
      "imageUrl": {
        "type": "string",
        "format": "uri",
        "description": "feed/list 타입에 표시할 이미지 URL"
      },
      "imageWidth": {
        "type": "integer",
        "minimum": 200,
        "maximum": 800,
        "description": "이미지 너비 (px)"
      },
      "imageHeight": {
        "type": "integer",
        "minimum": 200,
        "maximum": 800,
        "description": "이미지 높이 (px)"
      },
      "buttons": {
        "type": "array",
        "maxItems": 2,
        "items": {
          "type": "object",
          "required": ["title", "link"],
          "properties": {
            "title": { "type": "string", "description": "버튼 텍스트" },
            "link": { "type": "string", "format": "uri", "description": "버튼 URL" }
          },
          "additionalProperties": false
        },
        "description": "커스텀 버튼 목록 (최대 2개, buttonTitle 대체)"
      },
      "listHeaderTitle": {
        "type": "string",
        "description": "list 타입의 헤더 제목"
      },
      "items": {
        "type": "array",
        "maxItems": 5,
        "items": {
          "type": "object",
          "required": ["title"],
          "properties": {
            "title": { "type": "string", "description": "항목 제목" },
            "description": { "type": "string", "description": "항목 설명" },
            "imageUrl": { "type": "string", "format": "uri", "description": "항목 이미지 URL" },
            "link": { "type": "string", "format": "uri", "description": "항목 클릭 URL" }
          },
          "additionalProperties": false
        },
        "description": "list 타입의 항목 목록 (최대 5개)"
      }
    },
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "required": ["success", "resultCode"],
    "properties": {
      "success":    { "type": "boolean", "description": "발송 성공 여부" },
      "resultCode": { "type": "integer", "description": "카카오 API 응답 코드 (0=성공)" }
    },
    "additionalProperties": false
  }
}
```

### browser-scrape (web-scrape, local)

Playwright 전체 옵션 반영:

```json
{
  "input": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": {
        "type": "string",
        "format": "uri",
        "description": "스크래핑할 URL"
      },
      "selector": {
        "type": "string",
        "description": "CSS 선택자. 지정하면 해당 요소만 반환"
      },
      "waitFor": {
        "type": "string",
        "enum": ["networkidle", "load", "domcontentloaded", "commit"],
        "default": "networkidle",
        "description": "페이지 로드 대기 전략"
      },
      "waitForSelector": {
        "type": "string",
        "description": "이 CSS 선택자가 나타날 때까지 추가 대기"
      },
      "excludeDomains": {
        "type": "array",
        "items": { "type": "string" },
        "description": "링크 필터링 시 제외할 도메인 목록"
      },
      "viewport": {
        "type": "object",
        "properties": {
          "width":  { "type": "integer", "default": 1280, "description": "뷰포트 너비" },
          "height": { "type": "integer", "default": 720, "description": "뷰포트 높이" }
        },
        "additionalProperties": false,
        "description": "브라우저 뷰포트 크기"
      },
      "locale": {
        "type": "string",
        "default": "ko-KR",
        "description": "브라우저 로케일 (BCP 47)"
      },
      "timezoneId": {
        "type": "string",
        "default": "Asia/Seoul",
        "description": "브라우저 타임존 (IANA)"
      },
      "extraHeaders": {
        "type": "object",
        "additionalProperties": { "type": "string" },
        "description": "추가 HTTP 헤더"
      },
      "javascriptEnabled": {
        "type": "boolean",
        "default": true,
        "description": "JavaScript 실행 여부"
      },
      "screenshot": {
        "type": "boolean",
        "default": false,
        "description": "스크린샷 캡처 (base64 반환)"
      },
      "fullPage": {
        "type": "boolean",
        "default": false,
        "description": "전체 페이지 스크린샷 (screenshot=true 시)"
      }
    },
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "required": ["url", "title", "text"],
    "properties": {
      "url":   { "type": "string", "description": "최종 URL (리다이렉트 후)" },
      "title": { "type": "string", "description": "페이지 제목" },
      "text":  { "type": "string", "description": "페이지 본문 텍스트" },
      "links": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["href", "text"],
          "properties": {
            "href": { "type": "string", "description": "링크 URL" },
            "text": { "type": "string", "description": "링크 텍스트" }
          },
          "additionalProperties": false
        },
        "description": "페이지 내 외부 링크 (최대 10개)"
      },
      "firstLink": {
        "type": ["object", "null"],
        "properties": {
          "href": { "type": "string" },
          "text": { "type": "string" }
        },
        "additionalProperties": false,
        "description": "첫 번째 외부 링크"
      },
      "screenshot": {
        "type": "string",
        "description": "스크린샷 base64 데이터 (screenshot=true 시)"
      }
    },
    "additionalProperties": false
  }
}
```

---

## 제14장: Function Calling 연동

config.json의 `input` JSON Schema는 Gemini Function Calling의 도구 파라미터로 **직접 전달**된다.

```typescript
// config.json → Gemini Tool Definition 변환
function configToGeminiTool(config: ModuleConfig): GeminiToolDefinition {
  return {
    name: config.name,
    description: config.description,
    parameters: config.input,  // JSON Schema 그대로
  };
}
```

이로써:
1. 모듈 추가 시 config.json만 작성하면 AI 도구로 자동 등록
2. AI가 파라미터를 잘못 생성하면 Gemini가 스키마 레벨에서 차단
3. 프롬프트에 모듈 예시를 하드코딩할 필요 없음

---

## 부록 A: 타입 가드 유틸리티

```typescript
// InfraResult 성공 확인
function isSuccess<T>(r: InfraResult<T>): r is InfraResult<T> & { success: true; data: T } {
  return r.success === true && r.data !== undefined;
}

// PipelineStep 타입 가드
function isExecuteStep(s: PipelineStep): s is ExecuteStep { return s.type === 'EXECUTE'; }
function isMcpCallStep(s: PipelineStep): s is McpCallStep { return s.type === 'MCP_CALL'; }
function isNetworkStep(s: PipelineStep): s is NetworkRequestStep { return s.type === 'NETWORK_REQUEST'; }
function isLlmStep(s: PipelineStep): s is LlmTransformStep { return s.type === 'LLM_TRANSFORM'; }
```

---

## 부록 B: 금기 사항 요약

1. **`any` 사용 금지** — `unknown` + 타입 가드로 대체
2. **`as any` 캐스팅 금지** — 타입이 안 맞으면 인터페이스를 수정
3. **`z.any()` 금지** — `z.unknown()` 또는 구체 스키마
4. **`string` 리터럴을 `z.string()`으로 처리 금지** — `z.literal()` 또는 `z.enum()` 사용
5. **optional chaining으로 타입 우회 금지** — 타입이 undefined 가능이면 인터페이스에 명시
6. **config.json input/output에 자연어 기술 금지** — JSON Schema만 허용
7. **AI 프롬프트에 모듈 파라미터 하드코딩 금지** — config.json에서 동적 생성
8. **`InfraResult<any>` 반환 금지** — 구체 타입 `T` 지정 필수
9. **함수에 동적 오브젝트로 파라미터를 받는데 오브젝트의 필드에 `any`라 기재한건 사기** — 필드별 정의
10. **`try {} catch(e: any)` 에서 `e`를 `any`로 캐치하는 것**만 허용 — catch절 `any`는 TypeScript 제약으로 인한 유일한 예외

import type { InfraResult } from '../types';

/**
 * Firebat - Core Ports
 * Core가 물리적 세상(Infra)과 통신하기 위해 요구하는 엄격한 인터페이스(명세서)입니다.
 * 중요: Core는 절대 try-catch에 의존하지 않으며, Infra는 에러 발생 시 throw 대신 무조건 InfraResult(success:false)를 반환해야 합니다.
 *
 * any 사용 금지 — 모든 데이터는 구체적 타입 또는 unknown + 타입 가드로 처리
 */

// ── 공통 타입 ──────────────────────────────────────────────────────────────

/** LLM 대화 메시지 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Base64 인코딩된 이미지 데이터 (data:image/png;base64,... 또는 순수 base64) */
  image?: string;
  /** 이미지 MIME 타입 (image/png, image/jpeg 등) */
  imageMimeType?: string;
}

/** LLM JSON 응답 (FirebatPlan 구조) */
export interface LlmJsonResponse {
  thoughts: string;
  reply: string;
  actions: Record<string, unknown>[];  // 파싱 후 FirebatAction[]으로 검증
  suggestions: unknown[];              // 파싱 후 Suggestion[]으로 검증
}

/** LLM 호출의 token 사용량 + 비용 (어댑터가 자기 SDK 응답에서 추출).
 *  CLI 모드는 사용자 구독이라 cost=0 (또는 미산정). API 모드만 cost 계산. */
export interface LlmTokenUsage {
  /** 입력 (prompt) 토큰 수 */
  inputTokens?: number;
  /** 출력 (completion) 토큰 수 */
  outputTokens?: number;
  /** 입력+출력 합계 (선택). 어댑터가 직접 줄 수도, Core 가 input+output 합산할 수도 */
  totalTokens?: number;
  /** 모델 식별자 (가격 lookup 용) */
  model?: string;
  /** 어댑터가 직접 계산한 USD 비용 (선택). 미설정 시 Core 가 model + tokens 으로 산정 */
  costUsd?: number;
}

/** 네트워크 요청 옵션 */
export interface NetworkRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  timeout?: number;
}

/** 네트워크 응답 */
export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  data: string | Record<string, unknown>;
}

/** 모듈 출력 (stdout JSON) */
export interface ModuleOutput {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  code?: string;
}

/** 로그 메타데이터 */
export interface LogMeta {
  correlationId?: string;
  model?: string;
  durationMs?: number;
  [key: string]: string | number | boolean | undefined;
}

/** InfraResult 메타데이터 */
export interface ResultMeta {
  durationMs?: number;
  cached?: boolean;
  model?: string;
  [key: string]: string | number | boolean | undefined;
}

/** 페이지 목록 항목 */
export interface PageListItem {
  slug: string;
  title: string;
  status: string;
  project?: string;
  visibility?: 'public' | 'password' | 'private';
  updatedAt?: string;
  createdAt?: string;
}

/** PageSpec 헤드 */
export interface PageHead {
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
  /** Layout 페이지별 override — 글로벌 layoutMode 무시하고 이 페이지만 다른 모드.
   *  사용 예: 글로벌은 right-sidebar 인데 hero 풀폭 페이지만 'full' / 단일 글 'boxed' 등.
   *  미설정 시 글로벌 cms layout.mode 사용. */
  layoutMode?: 'full' | 'right-sidebar' | 'left-sidebar' | 'both-sidebar' | 'boxed';
}

/** PageSpec 컴포넌트 (discriminated union) */
export type PageComponent =
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

export interface FormField {
  name: string;
  label?: string;
  type: 'text' | 'email' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date';
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    backgroundColor?: string | string[];
  }>;
}

/** PageSpec — 페이지 전체 데이터 */
export interface PageSpec {
  slug: string;
  head?: PageHead;
  body?: PageComponent[];
  project?: string;
  _visibility?: 'public' | 'password' | 'private';
  /** DB 발행 시각 — JSON-LD Article schema 의 datePublished/dateModified 에 사용 */
  _createdAt?: string;
  _updatedAt?: string;
  _hasPassword?: boolean;
}

// ── JSON Schema 타입 (config.json input/output) ─────────────────────────

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null' | Array<'object' | 'null' | 'string' | 'number' | 'integer' | 'boolean' | 'array'>;
  description?: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: JsonSchema | JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | { type: string };
}

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
  items?: JsonSchema | JsonSchemaProperty;
  description?: string;
}

// ── Port 인터페이스 ─────────────────────────────────────────────────────

export interface IStoragePort {
  /** 해당 경로의 텍스트 콘텐츠 읽기 */
  read(path: string): Promise<InfraResult<string>>;
  /** 바이너리 파일 읽기 → base64 + mimeType + size. 이미지/PDF/기타 바이너리. */
  readBinary(path: string): Promise<InfraResult<{ base64: string; mimeType: string; size: number }>>;
  /** 파일 쓰기(부모 폴더 자동 생성 포함) — 사용자/AI 도구 zone (user/, app/(user)/, data/firebat-memory). */
  write(path: string, content: string): Promise<InfraResult<void>>;
  /** Internal cache 쓰기 — data/cache/sysmod-results 만. Core 의 cacheData 호출 전용.
   *  AI 도구 (write_file / edit_file) 는 일반 write 만 호출 → cache 자동 차단. */
  writeCache(path: string, content: string): Promise<InfraResult<void>>;
  /** Internal cache 삭제 — data/cache/sysmod-results 만. Core 의 cacheDrop 호출 전용. */
  deleteCache(path: string): Promise<InfraResult<void>>;
  /** 파일 삭제 */
  delete(path: string): Promise<InfraResult<void>>;
  /** 디렉토리 내 파일 목록 조회 (이름 목록) */
  list(path: string): Promise<InfraResult<string[]>>;
  /** 디렉토리 내 항목 목록 조회 (이름 + 디렉토리 여부) */
  listDir(path: string): Promise<InfraResult<Array<{ name: string; isDirectory: boolean }>>>;
  /** Glob 패턴 매칭 — `**\/*.ts` 같은 파일 경로 검색.
   *  zone whitelist 활용 (canRead 와 동일 정책). 패턴이 zone 밖 매칭하면 결과 0건.
   *  결과: 매칭된 파일 절대 경로의 baseDir 상대 경로 배열. */
  glob(pattern: string, opts?: { limit?: number }): Promise<InfraResult<string[]>>;
  /** 파일 내용 grep — 패턴 매칭 line 추출. zone whitelist + glob 으로 파일 후보 한정. */
  grep(pattern: string, opts?: { path?: string; fileType?: string; limit?: number; ignoreCase?: boolean }): Promise<InfraResult<Array<{ file: string; line: number; text: string }>>>;
}

export interface ILogPort {
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** 디버그 로그 — 기본 off, setDebug(true)로 활성화 */
  debug(message: string, meta?: LogMeta): void;
  /** 디버그 모드 on/off */
  setDebug(enabled: boolean): void;
}

export interface SandboxExecuteOpts {
  /** 모듈 stdout 의 `[STATUS] {"progress":0.5,"message":"..."}` 라인 파싱 콜백.
   *  모듈이 진행도 보고하면 caller (Core·TaskManager 등) 가 StatusManager 와 연결 가능.
   *  형식: `[STATUS] <JSON-object>` — 줄 시작에 정확히 위치해야 인식됨.
   *  - progress: 0~1 number (선택)
   *  - message: string (선택)
   *  - meta: object (선택, 모듈 특정 정보)
   *  최종 결과 JSON (마지막 줄) 은 별개 — 이 콜백은 진행 보고 전용. */
  onProgress?: (update: { progress?: number; message?: string; meta?: Record<string, unknown> }) => void;
  /** 추가 환경변수 — config.json secrets 외에 명시 주입. caller (Core facade 등) 가 timezone, locale,
   *  사용자 컨텍스트 등 cross-cutting 값을 sysmod 자식 프로세스에 전달할 때 사용.
   *  ALLOWED_ENV_KEYS 화이트리스트와 무관 — 명시 호출이라 보안 통과. */
  extraEnv?: Record<string, string>;
}

export interface ISandboxPort {
  /** 유저 모듈 코드를 자식 프로세스로 실행하고 그 ModuleOutput을 InfraResult에 담아 리턴 */
  execute(targetPath: string, inputData: Record<string, unknown>, opts?: SandboxExecuteOpts): Promise<InfraResult<ModuleOutput>>;
}

/** 스트리밍 청크 타입 */
export interface LlmChunk {
  type: 'text' | 'thinking';
  content: string;
}

/** LLM 호출 옵션 — 요청별 모델 오버라이드 등 */
export interface LlmCallOpts {
  /** 이 호출에만 사용할 모델 (미지정 시 기본 모델) */
  model?: string;
  /** Thinking 수준 (minimal/low/medium/high) */
  thinkingLevel?: string;
  /** 샘플링 온도 — 0=deterministic, 1=default, 2=창의적.
   *  도구 호출 턴엔 낮게 (스키마 준수), 최종 응답 턴엔 높게 (자연스러운 글) 동적 설정 권장.
   *  API 핸들러만 반영 (CLI 는 구독 기반이라 이 파라미터 미지원). */
  temperature?: number;
  /** 스트리밍 청크 콜백 — 설정 시 generateContentStream 사용 */
  onChunk?: (chunk: LlmChunk) => void;
  /** 현재 프롬프트에 첨부할 이미지 (Base64 data URL 또는 순수 base64) */
  image?: string;
  /** 이미지 MIME 타입 */
  imageMimeType?: string;
  /** 이전 응답 ID (OpenAI Responses API) — 설정 시 history 재전송 불필요, OpenAI 서버가 상태 유지 */
  previousResponseId?: string;
  /** JSON 응답 강제 (responseMimeType=application/json). askText 에서 사용. 마크다운·설명 방지. */
  jsonMode?: boolean;
  /** JSON 스키마 강제 (Gemini responseSchema / OpenAI response_format.json_schema).
   *  jsonMode=true 와 함께 사용. grammar-level constrained decoding 으로 구조 위반 출력 불가능.
   *  enum·required·additionalProperties 등 전부 강제 준수. */
  jsonSchema?: Record<string, unknown>;
  /** CLI 모드 세션 resume — 이전 CLI 서브프로세스 세션 ID. 있으면 --resume 으로 재연결.
   *  모델이 바뀌면 호출자가 null 로 전달해야 함 (세션은 모델과 결합). */
  cliResumeSessionId?: string;
  /** CLI 모드 세션 캡처 콜백 — 첫 호출 시 stream 이벤트에서 발견한 새 session_id 전달.
   *  호출자는 이걸 DB 에 저장했다가 다음 턴에 cliResumeSessionId 로 되돌려줌. */
  onCliSessionId?: (sessionId: string) => void;
  /** CLI 데몬 캐시 key 로 사용될 대화 ID (Claude Code persistent daemon).
   *  있으면 해당 대화의 장시간 서브프로세스를 재사용 — 매 턴 spawn 제거. */
  conversationId?: string;
}

// ── Function Calling 타입 ──────────────────────────────────────────────────

/** Function Calling 도구 정의 — Gemini functionDeclarations 형식 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** strict 모드 (OpenAI Structured Outputs) — 스키마 엄격 준수 강제.
   *  true로 설정하려면 parameters가 additionalProperties:false + 모든 field required 요건 만족 필요.
   */
  strict?: boolean;
}

/** LLM이 반환한 도구 호출 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** 이미 실행된 결과 (OpenAI hosted MCP connector 등에서 LLM 서버가 내부 실행한 경우).
   *  값이 있으면 Core는 executeToolCall을 건너뛰고 이 결과를 그대로 사용. */
  preExecutedResult?: Record<string, unknown>;
}

/** 도구 실행 결과 — LLM에 피드백 */
export interface ToolResult {
  name: string;
  result: Record<string, unknown>;
}

/** 도구 호출 ↔ 결과 교환 1턴 — 멀티턴 루프에서 이전 턴을 전달 */
export interface ToolExchangeEntry {
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  /** LLM 원본 응답 parts (thought_signature 등 보존) — 어댑터가 멀티턴 시 그대로 사용 */
  rawModelParts?: unknown[];
}

/** Function Calling 응답 — 텍스트 + 도구 호출 */
export interface LlmToolResponse {
  text: string;
  toolCalls: ToolCall[];
  /** LLM 원본 응답 parts — 멀티턴 교환 시 보존용 */
  rawModelParts?: unknown[];
  /** OpenAI Responses API 응답 ID — 다음 요청의 previous_response_id로 사용하면 history 재전송 불필요 */
  responseId?: string;
  /** Token 사용량 + 비용 (어댑터가 자기 SDK 응답에서 추출).
   *  CostManager 가 누적 → 일별·모델별 통계. */
  usage?: LlmTokenUsage;
  /** LLM 이 내부에서 이미 호출한 도구 이름 배열 (CLI 모드처럼 어댑터가 도구 루프를 직접 돌린 경우).
   *  Core 는 이를 executedActions 에 반영해 액션 뱃지 표시. 실제 실행은 어댑터가 끝냈으므로 재호출 X. */
  internallyUsedTools?: string[];
  /** LLM 이 내부에서 실행한 render 도구의 결과 블록들 (CLI 모드 — UI 표시 필요).
   *  component/html 블록 형태. ai-manager 가 자신의 blocks 배열에 추가. */
  renderedBlocks?: Array<
    | { type: 'text'; text: string }
    | { type: 'html'; htmlContent: string; htmlHeight?: string }
    | { type: 'component'; name: string; props: Record<string, unknown> }
  >;
  /** MCP 경유로 생성된 pending actions (schedule_task / save_page 등 승인 필요 작업).
   *  CLI 모드에서 MCP 핸들러가 createPending 해서 tool_result 에 planId 포함 → 여기로 전달.
   *  ai-manager 가 자신의 pendingActions 배열에 추가. */
  pendingActions?: Array<{
    planId: string;
    name: string;
    summary: string;
    args?: Record<string, unknown>;
    /** 과거 시각 요청 감지 시 'past-runat' — UI 가 즉시 발송/시간 변경 버튼 표시 */
    status?: 'past-runat';
    /** status='past-runat' 일 때 원래 요청된 runAt (ISO 8601) */
    originalRunAt?: string;
  }>;
  /** MCP suggest 도구로 생성된 사용자 선택지 (CLI 모드) */
  suggestions?: unknown[];
}

export interface ILlmPort {
  /** AI에게 질의를 보내고 JSON 파싱된 결과를 받아옵니다. (레거시 — Function Calling 전환 후 제거 예정) */
  ask(prompt: string, systemPrompt?: string, history?: ChatMessage[], opts?: LlmCallOpts): Promise<InfraResult<LlmJsonResponse>>;
  /** AI에게 질의를 보내고 순수 텍스트 결과를 받아옵니다. (코드 어시스트 등 JSON 불필요 시) */
  askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>>;
  /** Function Calling — 도구 정의와 함께 질의, 텍스트 + 도구 호출 반환. toolExchanges로 멀티턴 도구 루프 지원 */
  askWithTools(prompt: string, systemPrompt: string, tools: ToolDefinition[], history?: ChatMessage[], toolExchanges?: ToolExchangeEntry[], opts?: LlmCallOpts): Promise<InfraResult<LlmToolResponse>>;
  /** 기본 모델 ID 반환 */
  getModelId(): string;
  /** 지정 모델 런타임의 내부 메타 도구 목록 (AI 가 호출하면 안 되는 것들).
   *  CLI 전용 (enter_plan_mode, Task, Agent 등 각 CLI 내장 도구). API 모드는 빈 배열.
   *  AiManager 가 시스템 프롬프트에 주입 → 공급자별 하드코딩 회피. */
  getBannedInternalTools(modelId?: string): string[];
  /** 모델별 1M 토큰당 가격 (USD). null = 가격 정보 없음 (CLI 구독 모델 등 — 비용 산정 불가).
   *  CostManager 가 이 정보로 LlmTokenUsage.costUsd 계산. */
  getModelPricing?(modelId: string): { inputPer1M: number; outputPer1M: number } | null;
}

export interface INetworkPort {
  /** 격리 샌드박스 없이 빠르게 수행하는 가벼운 HTTP 통신 */
  fetch(url: string, options?: NetworkRequestOptions): Promise<InfraResult<NetworkResponse>>;
}

// ── 파이프라인 단계 (Discriminated Union) ────────────────────────────────

/** 파이프라인 단계 공통 필드 */
interface PipelineStepBase {
  description?: string;
  inputData?: Record<string, unknown>;
  inputMap?: Record<string, unknown>;
}

/** EXECUTE — 모듈 실행 */
export interface ExecuteStep extends PipelineStepBase {
  type: 'EXECUTE';
  path: string;
}

/** MCP_CALL — 외부 MCP 도구 호출 */
export interface McpCallStep extends PipelineStepBase {
  type: 'MCP_CALL';
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

/** NETWORK_REQUEST — HTTP 요청 */
export interface NetworkRequestStep extends PipelineStepBase {
  type: 'NETWORK_REQUEST';
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
}

/** LLM_TRANSFORM — LLM 변환 */
export interface LlmTransformStep extends PipelineStepBase {
  type: 'LLM_TRANSFORM';
  instruction: string;
}

/** CONDITION — 조건 검사 (false면 파이프라인 중단, 에러가 아닌 정상 종료) */
export interface ConditionStep {
  type: 'CONDITION';
  description?: string;
  field: string;       // 검사 대상 ($prev, $prev.price 등)
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'includes' | 'not_includes' | 'exists' | 'not_exists';
  value?: unknown;     // 비교 값 (exists/not_exists는 불필요)
}

/** SAVE_PAGE — 페이지 발행 (cron 컨텍스트의 자동 발행 전용).
 *  pipeline 등록 시점에 사용자가 전체 흐름을 승인했으므로 매 트리거마다 재승인 게이트 우회.
 *  inputMap 으로 직전 LLM_TRANSFORM 결과를 spec.body 등에 매핑하거나,
 *  step 의 slug/spec 필드에 직접 명시할 수 있다. */
export interface SavePageStep extends PipelineStepBase {
  type: 'SAVE_PAGE';
  /** 페이지 slug. inputMap 으로 동적 생성 (예: "$prev.slug") 도 가능. */
  slug?: string;
  /** PageSpec — head + body 등. inputMap 으로 부분 매핑 가능. */
  spec?: Record<string, unknown>;
  /** 기존 페이지 덮어쓰기 허용 (기본 false — slug 충돌 시 자동 -N 접미사) */
  allowOverwrite?: boolean;
}

/** TOOL_CALL — Function Calling 도구 (image_gen / search_history / search_media / render_* 등) 직접 호출.
 *  EXECUTE 가 모듈 (sandbox 코드) 호출이라면, TOOL_CALL 은 도구 (Core 함수) 호출.
 *  자동 블로그 발행 시 image_gen 같은 도구를 cron pipeline 에서 활용 가능 — 사용자 채팅 안 거침. */
export interface ToolCallStep extends PipelineStepBase {
  type: 'TOOL_CALL';
  /** 도구 이름 (image_gen / search_history / search_media / render_* 등). ToolDispatcher 가 dispatch. */
  tool: string;
}

/** 파이프라인 단계 = 7가지 중 하나 */
export type PipelineStep = ExecuteStep | McpCallStep | NetworkRequestStep | LlmTransformStep | ConditionStep | SavePageStep | ToolCallStep;

/** 파이프라인 단계 타입 리터럴 */
export type PipelineStepType = PipelineStep['type'];

// ── 크론/스케줄링 ───────────────────────────────────────────────────────

/** 발화 전 조건 체크 — sysmod 호출 결과로 분기. 미충족 시 이번 발화 skip (pipeline 실행 X).
 *  반복 cron + 특정 조건 제외 패턴의 일반 메커니즘. 휴장일·잔고·부재 모드 등 어떤 조건도 sysmod 결과로 표현. */
export interface CronRunWhen {
  /** 조건 체크용 sysmod 호출 */
  check: { sysmod: string; action: string; inputData?: Record<string, unknown> };
  /** 결과 객체 안 field 경로 (예: '$result.isTradingDay' 또는 단일 키 'isTradingDay') */
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'includes' | 'not_includes' | 'exists' | 'not_exists';
  value?: string;
}

/** 자동 retry 정책 — 일시 실패 (네트워크 timeout·rate limit·503 등) 복구용 */
export interface CronRetry {
  count: number;       // 1~5 권장. 0 또는 미설정 = retry X
  delayMs?: number;    // 기본 30000 (30초)
}

/** cron 발화 후 결과 알림 hook — pipeline 비즈니스 로직과 분리, ScheduleManager 가 처리.
 *  글로벌 default (Vault 'system:cron:default-notify') 와 잡별 override 지원. */
export interface CronNotify {
  onSuccess?: { sysmod: string; chatId?: string; template?: string };
  /** retry 모두 소진 후 최종 실패 시 발동 */
  onError?: { sysmod: string; chatId?: string; template?: string };
}

/** 크론 실행 모드.
 *  pipeline (default): TaskManager 가 미리 짠 step 흐름을 결정적으로 실행. askText 단발. 싸고 결정적.
 *  agent: 트리거 시 AI Function Calling 사이클 (askWithTools) 로 agentPrompt 실행. 도구 자유 사용,
 *  검색·검증·콘텐츠 생성 가능. 비싸지만 퀄리티 ↑. 블로그·리포트·일정 정리 등 동적 콘텐츠 잡 전용. */
export type CronExecutionMode = 'pipeline' | 'agent';

export interface CronScheduleOptions {
  cronTime?: string;
  runAt?: string;
  delaySec?: number;
  startAt?: string;
  endAt?: string;
  inputData?: Record<string, unknown>;
  pipeline?: PipelineStep[];
  title?: string;
  description?: string;
  /** 첫 성공 시 자동 취소 (가격 알림 등 조건부 1회 패턴) */
  oneShot?: boolean;
  /** 발화 전 조건 체크 — 미충족 시 이번 발화 skip */
  runWhen?: CronRunWhen;
  /** 자동 retry 정책 */
  retry?: CronRetry;
  /** 결과 알림 hook (글로벌 default 도 가능) */
  notify?: CronNotify;
  /** 실행 모드 (기본 pipeline) */
  executionMode?: CronExecutionMode;
  /** agent 모드 전용 — 트리거 시 AI 에 전달할 자연어 instruction.
   *  agent 모드인데 미설정이면 title 을 fallback prompt 로 사용. */
  agentPrompt?: string;
}

/** 크론 실행 로그 */
export interface CronLogEntry {
  jobId: string;
  targetPath: string;
  title?: string;
  triggeredAt: string;
  success: boolean;
  durationMs: number;
  error?: string;
  /** 마지막 step 의 의미있는 결과 요약 — silent failure 추적용.
   *  SAVE_PAGE step → {savedSlug, renamed}, EXECUTE → 모듈 출력 핵심 필드,
   *  LLM_TRANSFORM 단독 종료 → {textPreview} 등. 형식 자유 (JSON-friendly). */
  output?: Record<string, unknown>;
  /** 실행된 step 수 / 총 step 수 — 파이프라인 어디까지 갔는지 가시화 */
  stepsExecuted?: number;
  stepsTotal?: number;
}

/** 크론 트리거 타입 */
export type CronTriggerType = 'CRON_SCHEDULER' | 'SCHEDULED_ONCE' | 'DELAYED_RUN';

/** 크론 트리거 정보 — 타이머가 발화할 때 Core에 전달 */
export interface CronTriggerInfo {
  jobId: string;
  targetPath: string;
  trigger: CronTriggerType;
  inputData?: Record<string, unknown>;
  pipeline?: PipelineStep[];
  oneShot?: boolean;
  runWhen?: CronRunWhen;
  retry?: CronRetry;
  notify?: CronNotify;
  /** notify template 치환용 — `{title}` placeholder 에 사용 */
  title?: string;
  /** 실행 모드 (pipeline 기본) */
  executionMode?: CronExecutionMode;
  /** agent 모드 prompt */
  agentPrompt?: string;
}

/** 크론 잡 실행 결과 — Core가 실행 후 반환 */
export interface CronJobResult {
  jobId: string;
  targetPath: string;
  trigger: CronTriggerType;
  success: boolean;
  durationMs: number;
  error?: string;
  /** 의미있는 결과 데이터 (SAVE_PAGE 의 slug 등). cron-logs.json 에 그대로 저장. */
  output?: Record<string, unknown>;
  /** 파이프라인 진행 추적 */
  stepsExecuted?: number;
  stepsTotal?: number;
}

/** 크론 잡 모드 */
export type CronJobMode = 'cron' | 'once' | 'delay';

/** 크론 잡 정보 (목록 조회용) */
export interface CronJobInfo {
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
  createdAt: string;
  mode: CronJobMode;
  runWhen?: CronRunWhen;
  retry?: CronRetry;
  notify?: CronNotify;
  executionMode?: CronExecutionMode;
  agentPrompt?: string;
}

export interface ICronPort {
  /**
   * 통합 스케줄링 등록
   * - cronTime만: 영구 반복
   * - cronTime + endAt: 기간 한정 반복
   * - runAt: 특정 시각 1회
   * - delaySec: N초 후 1회
   */
  schedule(jobId: string, targetPath: string, opts: CronScheduleOptions): Promise<InfraResult<void>>;
  /** 스케줄링 해제 */
  cancel(jobId: string): Promise<InfraResult<void>>;
  /** 기존 잡을 즉시 1회 발화 (스케줄링 변경 X). 정상 cron 발화와 동일 fireTrigger 경유 → cron-logs 기록 보장. */
  triggerNow(jobId: string): Promise<InfraResult<void>>;
  /** 등록된 잡 목록 조회 */
  list(): CronJobInfo[];
  /** 타임존 설정 */
  setTimezone(tz: string): void;
  /** 현재 타임존 조회 */
  getTimezone(): string;
  /** 트리거 콜백 등록 — 타이머 발화 시 Core가 실행을 오케스트레이션 */
  onTrigger(callback: (info: CronTriggerInfo) => Promise<CronJobResult>): void;
  /** 실행 로그 조회 */
  getLogs(limit?: number): CronLogEntry[];
  /** 실행 로그 전체 삭제 */
  clearLogs(): void;
  /** 페이지 URL 알림 소비 (소비 후 정리) */
  consumeNotifications(): Array<{ jobId: string; url: string; triggeredAt: string }>;
  /** 페이지 URL 알림 추가 */
  appendNotify(entry: { jobId: string; url: string; triggeredAt: string }): void;
}

export interface IDatabasePort {
  /** SQL 쿼리 실행 */
  query(sql: string, params?: unknown[]): Promise<InfraResult<Record<string, unknown>[]>>;

  // ── PageSpec CRUD ──────────────────────────────────────────────────────
  /** 페이지 목록 조회 */
  listPages(): Promise<InfraResult<PageListItem[]>>;
  /** 특정 slug의 PageSpec 전체 조회 */
  getPage(slug: string): Promise<InfraResult<PageSpec>>;
  /** PageSpec 저장 (upsert) */
  savePage(slug: string, spec: string): Promise<InfraResult<void>>;
  /** 페이지 삭제 */
  deletePage(slug: string): Promise<InfraResult<void>>;
  /** 프로젝트별 페이지 slug 목록 */
  listPagesByProject(project: string): Promise<InfraResult<string[]>>;
  /** 프로젝트 단위 일괄 삭제 */
  deletePagesByProject(project: string): Promise<InfraResult<string[]>>;
  /** 페이지 검색 — title / description / project / 본문 텍스트(spec JSON) 매칭. 공개 페이지만 (visibility != private). */
  searchPages(query: string, limit?: number): Promise<InfraResult<PageListItem[]>>;
  /** 페이지 visibility 설정 */
  setPageVisibility(slug: string, visibility: 'public' | 'password' | 'private', password?: string): Promise<InfraResult<void>>;
  /** 페이지 비밀번호 검증 */
  verifyPagePassword(slug: string, password: string): Promise<InfraResult<boolean>>;

  // ── Shared conversations (공유 대화) ────────────────────────────────────
  createShare(input: { type: 'turn' | 'full'; title: string; messages: unknown[]; owner?: string; sourceConvId?: string; ttlMs: number; dedupKey?: string }): Promise<InfraResult<{ slug: string; expiresAt: number; reused?: boolean }>>;
  getShare(slug: string): Promise<InfraResult<SharedConversationRecord | null>>;
  cleanupExpiredShares(): Promise<InfraResult<{ deleted: number }>>;
}

export type SharedConversationRecord = {
  slug: string;
  type: 'turn' | 'full';
  title: string;
  messages: unknown[];
  createdAt: number;
  expiresAt: number;
};

export interface IVaultPort {
  /** 시크릿 값 조회 (없으면 null) */
  getSecret(key: string): string | null;
  /** 시크릿 저장 (upsert) */
  setSecret(key: string, value: string): boolean;
  /** 시크릿 삭제 */
  deleteSecret(key: string): boolean;
  /** 저장된 모든 시크릿 키 이름 목록 */
  listKeys(): string[];
  /** 특정 접두사로 시작하는 시크릿 키 목록 */
  listKeysByPrefix(prefix: string): string[];
}

// ── MCP 클라이언트 ──────────────────────────────────────────────────────

export interface McpServerConfig {
  /** 서버 고유 이름 */
  name: string;
  /** 전송 방식 */
  transport: 'stdio' | 'sse';
  /** stdio: 실행할 커맨드 */
  command?: string;
  /** stdio: 커맨드 인자 */
  args?: string[];
  /** stdio: 환경 변수 */
  env?: Record<string, string>;
  /** sse: 서버 URL */
  url?: string;
  /** 활성화 여부 */
  enabled: boolean;
}

export interface McpToolInfo {
  /** 도구가 속한 MCP 서버 이름 */
  server: string;
  /** 도구 이름 */
  name: string;
  /** 도구 설명 */
  description: string;
  /** 입력 스키마 (JSON Schema) */
  inputSchema?: JsonSchema;
}

// ── 인증 ────────────────────────────────────────────────────────────────

/** 통합 세션 — 로그인 세션(만료 있음) + API 토큰(만료 없음) */
export interface AuthSession {
  token: string;
  type: 'session' | 'api';
  role: 'admin';
  label?: string;
  createdAt: number;
  expiresAt?: number;
  /** 마지막 사용 시각 (ms epoch) — validateApiToken / validateSession 호출 시 갱신.
   *  도용 의심 패턴 감지 + 미사용 토큰 정리 + 어드민 UI 표시에 활용. */
  lastUsedAt?: number;
}

export interface IAuthPort {
  /** 세션 저장 */
  saveSession(session: AuthSession): boolean;
  /** 토큰으로 세션 조회 (만료 검사 포함, 만료 시 자동 삭제) */
  getSession(token: string): AuthSession | null;
  /** 세션 삭제 */
  deleteSession(token: string): boolean;
  /** 특정 타입의 모든 세션 목록 */
  listSessions(type: 'session' | 'api'): AuthSession[];
  /** 특정 타입의 모든 세션 삭제 */
  deleteSessions(type: 'session' | 'api'): number;
}

// ── MCP 클라이언트 Port ──────────────────────────────────────────────────

export interface IMcpClientPort {
  /** 등록된 MCP 서버 설정 목록 */
  listServers(): McpServerConfig[];
  /** MCP 서버 설정 추가/수정 */
  addServer(config: McpServerConfig): Promise<InfraResult<void>>;
  /** MCP 서버 설정 제거 + 연결 해제 */
  removeServer(name: string): Promise<InfraResult<void>>;
  /** 특정 서버에 연결하고 도구 목록 조회 */
  listTools(serverName: string): Promise<InfraResult<McpToolInfo[]>>;
  /** 모든 활성 서버의 도구 목록 (AI 프롬프트용) */
  listAllTools(): Promise<InfraResult<McpToolInfo[]>>;
  /** 도구 실행 */
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<InfraResult<unknown>>;
  /** 모든 연결 해제 (셧다운용) */
  disconnectAll(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────
//  Embedder / Router 포트 — 텍스트 임베딩·self-learning 도구 라우팅
// ─────────────────────────────────────────────────────────────────────────

/** 텍스트 임베딩 포트 — 멀티언어 e5 모델 등 infra 구현체를 추상화 */
export interface IEmbedderPort {
  /** 모델 버전 — 캐시 무효화 키 */
  readonly version: string;
  /** 사용자 쿼리 임베딩 (검색 입력) */
  embedQuery(text: string): Promise<Float32Array>;
  /** 인덱스 대상 문서 임베딩 */
  embedPassage(text: string): Promise<Float32Array>;
  /** 정규화된 벡터 간 cosine similarity */
  cosine(a: Float32Array, b: Float32Array): number;
  /** Float32Array → Buffer (SQLite BLOB 저장용) */
  float32ToBuffer(arr: Float32Array): Buffer;
  /** Buffer → Float32Array */
  bufferToFloat32(buf: Buffer): Float32Array;
}

export type RouteFeedbackSignal = 'positive' | 'negative' | 'neutral';

export interface RouteResult {
  names: string[];
  cacheId: number;
  source: 'cache' | 'llm';
  previousFeedback?: RouteFeedbackSignal;
  needsPreviousContext?: boolean;
}

export interface RecentRoutingContext {
  previousQuery: string;
  previousNames: string[];
}

export interface ComponentCatalogItem {
  name: string;
  description: string;
}

export type RouteKind = 'tools' | 'components';

/** Self-learning 도구 라우팅 포트 — Flash Lite + 벡터 캐시 기반 infra 구현체 */
export interface IToolRouterPort {
  routeTools(
    userQuery: string,
    allTools: ToolDefinition[],
    alwaysInclude: string[],
    recentContext?: RecentRoutingContext,
  ): Promise<RouteResult>;
  routeComponents(query: string, catalog: ComponentCatalogItem[]): Promise<RouteResult>;
  generateSearchQuery(rawQuery: string, prevQuery?: string): Promise<{ query: string; needsPreviousContext: boolean }>;
  rerankHistory<T extends { preview: string }>(query: string, candidates: T[], topK?: number): Promise<T[]>;
  recordSuccess(cacheId: number): Promise<void>;
  recordFailure(cacheId: number, weight?: number): Promise<void>;
}

/** 라우터 팩토리 — 특정 모델 ID 로 IToolRouterPort 구현체 생성 */
export type ToolRouterFactory = (modelId: string) => IToolRouterPort;

/**
 * 권한 포트 모두 모아 Core에 주입하기 위한 단일 통제권 컨테이너
 */
export interface FirebatInfraContainer {
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
  media: IMediaPort;
  imageProcessor: IImageProcessorPort;
  imageGen: IImageGenPort;
  /** Vault 기반 모델명을 매 요청 시 읽어야 해서 factory 로 주입 */
  toolRouter: ToolRouterFactory;
}

// ══════════════════════════════════════════════════════════════════════════
// Media (이미지/파일 저장·서빙) — AI 생성 이미지, OG 썸네일 캐싱, 업로드 등 공용 미디어 인프라
// ══════════════════════════════════════════════════════════════════════════

export interface MediaSaveOptions {
  /** 파일 확장자 (png/jpg/webp 등) — 미지정 시 contentType 에서 추론 */
  ext?: string;
  /** 파일명 힌트 — 네이밍 규칙 적용: YYYY-MM-DD-<hint-slug>-<rand>.ext */
  filenameHint?: string;
  /** 썸네일 생성 여부 (기본 true). 256px 썸네일 동시 저장 */
  thumbnail?: boolean;
  /** 반응형 variants 생성 (기본 빈 배열 = 비활성) */
  variants?: Array<{ width: number; format?: 'webp' | 'avif' | 'jpeg' }>;
  /** 저장 scope — 'user' / 'system'. 기본 'user'. */
  scope?: 'user' | 'system';
  /** 이미지 생성 도구가 넘기는 메타 — 갤러리에서 검색·표시용 */
  prompt?: string;
  revisedPrompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  /** aspect ratio crop 결과 보존 — 예: "16:9", "1:1", "4:5" */
  aspectRatio?: string;
  /** crop 전략 — 'attention' (자동) / 'entropy' / 'center' / {x,y} */
  focusPoint?: 'attention' | 'entropy' | 'center' | { x: number; y: number };
  /** 출처 — 'ai-generated' (image_gen 결과, 기본) / 'upload' (사용자 업로드).
   *  갤러리 필터·표시·향후 분석 (출처별 분석) 에 활용. */
  source?: 'ai-generated' | 'upload';
}

export interface MediaVariant {
  width: number;
  height?: number;
  format: string;      // 'webp' | 'avif' | 'jpeg' | ...
  url: string;         // /user/media/<slug>-480w.webp
  bytes: number;
}

export interface MediaSaveResult {
  /** 고유 slug — URL 조립 및 재조회용. 네이밍 규칙: YYYY-MM-DD-<hint>-<rand> */
  slug: string;
  /** 공개 URL 원본 — /user/media/<slug>.<ext> 또는 /system/media/... */
  url: string;
  /** 썸네일 URL (256px webp) */
  thumbnailUrl?: string;
  /** 반응형 variants 목록 (생성 활성 시) */
  variants?: MediaVariant[];
  /** Blurhash 문자열 (생성 활성 시) */
  blurhash?: string;
  /** 이미지 실제 크기 */
  width?: number;
  height?: number;
  /** 원본 바이트 크기 */
  bytes: number;
}

export interface MediaFileRecord {
  slug: string;
  ext: string;
  contentType: string;
  bytes: number;
  width?: number;
  height?: number;
  createdAt: number;
  scope?: 'user' | 'system';
  /** 갤러리 검색·표시용 메타 */
  filenameHint?: string;
  prompt?: string;
  revisedPrompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  /** aspect ratio crop 결과 (예: "16:9") */
  aspectRatio?: string;
  /** crop 전략 */
  focusPoint?: 'attention' | 'entropy' | 'center' | { x: number; y: number };
  /** 반응형 variants */
  variants?: MediaVariant[];
  /** 썸네일 URL */
  thumbnailUrl?: string;
  /** Blurhash (LQIP) */
  blurhash?: string;
  /** 처리 상태 — 미설정(legacy) = 'done' 으로 간주.
   *  - 'rendering': v1.0+ 비동기 패턴에서 placeholder 단계 (현재 미사용)
   *  - 'done': 정상 생성 완료
   *  - 'error': 생성 실패 — 메타만 존재, 원본 파일 없음. 재생성 가능.
   *  og:image 가드, 갤러리 시각 분기, 재생성 버튼 표시 등에 사용. */
  status?: 'rendering' | 'done' | 'error';
  /** status='error' 일 때 실패 사유 (사용자 표시용) */
  errorMsg?: string;
  /** 출처 — 'ai-generated' / 'upload'. legacy(미설정) = 'ai-generated' 로 간주.
   *  갤러리 시각 구분 + 검색 + 향후 분석 (사용자 본인 자산 vs AI 생성). */
  source?: 'ai-generated' | 'upload';
}

export interface IMediaPort {
  /** binary 저장 + URL 발급. 원본만 저장 — variants 는 saveVariant() 로 별도 기록. */
  save(binary: Buffer | Uint8Array, contentType: string, opts?: MediaSaveOptions): Promise<InfraResult<MediaSaveResult>>;
  /** 기존 slug 의 base 파일을 새 binary 로 교체 (placeholder → 실제 이미지 swap 용).
   *  비동기 image_gen 패턴 — startGenerate 가 placeholder 박고 reserve 한 slug 를 백그라운드에서 finalize.
   *  meta 도 함께 업데이트 (bytes/contentType/width/height) — status 는 caller 가 별도 updateMeta 로 'done' 설정. */
  finalizeBase(
    slug: string,
    scope: 'user' | 'system',
    binary: Buffer,
    contentType: string,
    extOverride?: string,
  ): Promise<InfraResult<void>>;
  /** variant/thumbnail binary 를 기존 slug 에 연결해 저장. suffix 규칙: '480w', 'thumb', 'full' 등 */
  saveVariant(
    slug: string,
    scope: 'user' | 'system',
    suffix: string,
    format: string,
    binary: Buffer,
    variantMeta: Omit<MediaVariant, 'url'>,
  ): Promise<InfraResult<string>>;
  /** 메타 JSON 업데이트 — variants[] / thumbnailUrl / blurhash / width·height 반영 */
  updateMeta(slug: string, scope: 'user' | 'system', patch: Partial<MediaFileRecord>): Promise<InfraResult<void>>;
  /** 실패 기록 저장 — 원본 binary 없이 메타 JSON 만 status='error' 로 기록.
   *  사용자가 갤러리에서 재생성·삭제 결정할 수 있도록 prompt·model 등 보존. */
  saveErrorRecord(opts: MediaSaveOptions & { errorMsg: string }): Promise<InfraResult<{ slug: string }>>;
  /** slug 로 파일 경로 + 메타데이터 조회. API route 에서 스트리밍 응답용. */
  read(slug: string): Promise<InfraResult<{ binary: Buffer; contentType: string; record: MediaFileRecord } | null>>;
  /** 메타데이터만 (HEAD 등) */
  stat(slug: string): Promise<InfraResult<MediaFileRecord | null>>;
  /** 수동 삭제 (정리 cron 등에서 사용) — 원본 + 모든 variants + 썸네일 + 메타 JSON 일괄 제거 */
  remove(slug: string): Promise<InfraResult<void>>;
  /** 갤러리용 목록 — scope 필터 + 검색 + 페이징. 최신순 정렬. */
  list(opts?: { scope?: 'user' | 'system' | 'all'; limit?: number; offset?: number; search?: string }): Promise<InfraResult<{ items: MediaFileRecord[]; total: number }>>;
}

// ══════════════════════════════════════════════════════════════════════════
// Image Processor (후처리 — resize/convert/thumbnail/blurhash). sharp 기반.
// 원본 이미지를 받아 다양한 포맷·크기 variants 생성. MediaManager 가 파이프라인 조립.
// ══════════════════════════════════════════════════════════════════════════

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;       // 'png' | 'jpeg' | 'webp' | 'avif' | ...
  bytes: number;
  hasAlpha?: boolean;
}

export interface ResizeOpts {
  width?: number;
  height?: number;
  fit?: 'contain' | 'cover' | 'fill' | 'inside' | 'outside';
  /** 크롭 위치 — cover/outside 시에만 유효.
   *  'attention' = sharp 내장 saliency 감지 (인물·제품 자동 중심)
   *  'entropy' = 엔트로피 최대 영역 (디테일 많은 곳)
   *  'center' = 가운데 (기본)
   *  { x, y } = 0~1 상대 좌표 수동 지정 (0.5, 0.5 = 정중앙) */
  position?: 'attention' | 'entropy' | 'center' | { x: number; y: number };
  /** 출력 포맷 — 미지정 시 원본 유지 */
  format?: 'png' | 'jpeg' | 'webp' | 'avif';
  /** 품질 (jpeg/webp/avif 만) */
  quality?: number;
  /** progressive encoding (jpeg/webp) */
  progressive?: boolean;
  /** EXIF 등 메타데이터 제거 */
  stripMetadata?: boolean;
}

export interface IImageProcessorPort {
  /** 이미지 메타데이터 파싱 (포맷 무관) */
  getMetadata(binary: Buffer | Uint8Array): Promise<InfraResult<ImageMetadata>>;
  /** 리사이즈 + 포맷 변환 */
  process(binary: Buffer | Uint8Array, opts: ResizeOpts): Promise<InfraResult<Buffer>>;
  /** Blurhash 생성 (LQIP, 32자 내외 문자열) */
  blurhash(binary: Buffer | Uint8Array, components?: { x: number; y: number }): Promise<InfraResult<string>>;
  /** Placeholder PNG 생성 (비동기 image_gen 의 "렌더링중" 임시 이미지).
   *  단순 회색 사각형 — 텍스트는 안 박음 (locale·폰트 의존 회피). 사용자는 갤러리 카드 + 페이지 reload 시 swap 으로 진행 인지. */
  createPlaceholder(width: number, height: number): Promise<InfraResult<Buffer>>;
}

// ══════════════════════════════════════════════════════════════════════════
// Image Generation (AI 이미지 생성) — LLM 과 대칭 구조. API/CLI 모드별 핸들러 + config.
// ══════════════════════════════════════════════════════════════════════════

export interface ImageGenOpts {
  prompt: string;
  /** 출력 크기 — 공식 지원 값 중 하나. 예: "1024x1024" | "1792x1024" | "1024x1792" */
  size?: string;
  /** 품질 — provider 마다 해석 다름 ("standard" | "hd" | "low" | "medium" | "high" 등) */
  quality?: string;
  /** 스타일 지시 (선택) */
  style?: string;
  /** n 개 생성 (1 권장, 다수 지원 provider 만) */
  n?: number;
  /** 모델 ID override — 미지정 시 ImageGenCallOpts 의 기본 사용 */
  model?: string;
  /** 참조 이미지 (image-to-image 변환). MediaManager 가 slug/url/base64 → binary 로 resolve 후 주입.
   *  - OpenAI: /v1/images/edits 엔드포인트 + multipart 로 전달 (gpt-image-1 지원)
   *  - Gemini: contents.parts 에 inline_data part 추가 (image-to-image 자연 동작)
   *  - 미지원 provider 는 에러 반환. */
  referenceImage?: {
    binary: Buffer;
    contentType: string;
  };
}

export interface ImageGenCallOpts {
  /** 모델 ID — config-adapter 가 이걸로 config 선택 */
  model?: string;
  /** 요청 상관 ID — 로깅 추적 */
  corrId?: string;
}

export interface ImageGenResult {
  /** 생성된 이미지 binary (PNG/WEBP 등) */
  binary: Buffer;
  contentType: string;
  /** 감지 가능한 경우 해상도 */
  width?: number;
  height?: number;
  /** provider 가 반환한 revised_prompt 등 */
  revisedPrompt?: string;
  /** 이미지 1장 비용 USD — 어댑터가 config.pricing 으로 산정. 구독 기반 (CLI) 은 0 또는 미설정.
   *  CostManager 가 이 값을 받아 LLM 비용 통계에 통합 누적 (token 0, costUsd 만 박음). */
  costUsd?: number;
}

export interface ImageModelInfo {
  id: string;
  displayName: string;
  provider: string;
  format: string;
  requiresOrganizationVerification?: boolean;
  /** 지원 사이즈 목록 — 설정 UI drop-down 에 노출. ["auto"] 면 모델 자동 */
  sizes?: string[];
  /** 지원 품질 목록 — 설정 UI drop-down 에 노출. ["standard"] 면 품질 고정 */
  qualities?: string[];
  /** CLI 구독 기반 여부 — API 키 불필요, 과금 구독에 포함 */
  subscription?: boolean;
}

export interface IImageGenPort {
  /** 현재 설정된 모델 ID 반환 — 로그용 */
  getModelId(): string;
  /** 설정 UI 용 모델 목록 — registry 에서 로드된 모든 config */
  listModels(): ImageModelInfo[];
  /** 이미지 생성 — Core 의 MediaManager 가 이 결과를 IMediaPort 로 저장 */
  generate(opts: ImageGenOpts, callOpts?: ImageGenCallOpts): Promise<InfraResult<ImageGenResult>>;
}

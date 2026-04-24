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
  /** 파일 쓰기(부모 폴더 자동 생성 포함) */
  write(path: string, content: string): Promise<InfraResult<void>>;
  /** 파일 삭제 */
  delete(path: string): Promise<InfraResult<void>>;
  /** 디렉토리 내 파일 목록 조회 (이름 목록) */
  list(path: string): Promise<InfraResult<string[]>>;
  /** 디렉토리 내 항목 목록 조회 (이름 + 디렉토리 여부) */
  listDir(path: string): Promise<InfraResult<Array<{ name: string; isDirectory: boolean }>>>;
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

export interface ISandboxPort {
  /** 유저 모듈 코드를 자식 프로세스로 실행하고 그 ModuleOutput을 InfraResult에 담아 리턴 */
  execute(targetPath: string, inputData: Record<string, unknown>): Promise<InfraResult<ModuleOutput>>;
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

/** 파이프라인 단계 = 5가지 중 하나 */
export type PipelineStep = ExecuteStep | McpCallStep | NetworkRequestStep | LlmTransformStep | ConditionStep;

/** 파이프라인 단계 타입 리터럴 */
export type PipelineStepType = PipelineStep['type'];

// ── 크론/스케줄링 ───────────────────────────────────────────────────────

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
}

/** 크론 잡 실행 결과 — Core가 실행 후 반환 */
export interface CronJobResult {
  jobId: string;
  targetPath: string;
  trigger: CronTriggerType;
  success: boolean;
  durationMs: number;
  error?: string;
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
  /** 원본 파일명 힌트 — 저장엔 영향 없고 로그에만 사용 */
  originalName?: string;
  /** 썸네일 생성 여부 (기본 false). true 면 256px 썸네일 동시 저장 */
  thumbnail?: boolean;
  /** 썸네일 최대 너비 px (thumbnail=true 시 유효). 기본 256 */
  thumbnailWidth?: number;
}

export interface MediaSaveResult {
  /** 고유 slug — URL 조립 및 재조회용 */
  slug: string;
  /** 공개 URL — /api/media/<slug>.<ext> 형태 */
  url: string;
  /** 썸네일 URL (thumbnail=true 시만) — /api/media/<slug>-thumb.<ext> */
  thumbnailUrl?: string;
  /** 이미지 실제 크기 (감지 가능한 경우만) */
  width?: number;
  height?: number;
  /** 바이트 크기 */
  bytes: number;
}

export interface MediaFileRecord {
  slug: string;
  ext: string;
  contentType: string;
  bytes: number;
  createdAt: number;
}

export interface IMediaPort {
  /** binary 저장 + URL 발급. 썸네일 옵션으로 동시 생성 가능. */
  save(binary: Buffer | Uint8Array, contentType: string, opts?: MediaSaveOptions): Promise<InfraResult<MediaSaveResult>>;
  /** slug 로 파일 경로 + 메타데이터 조회. API route 에서 스트리밍 응답용. */
  read(slug: string): Promise<InfraResult<{ binary: Buffer; contentType: string; record: MediaFileRecord } | null>>;
  /** 메타데이터만 (HEAD 등) */
  stat(slug: string): Promise<InfraResult<MediaFileRecord | null>>;
  /** 수동 삭제 (정리 cron 등에서 사용) */
  remove(slug: string): Promise<InfraResult<void>>;
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
}

export interface IImageGenPort {
  /** 현재 설정된 모델 ID 반환 — 로그용 */
  getModelId(): string;
  /** 이미지 생성 — Core 의 ImageManager 가 이 결과를 IMediaPort 로 저장 */
  generate(opts: ImageGenOpts, callOpts?: ImageGenCallOpts): Promise<InfraResult<ImageGenResult>>;
}

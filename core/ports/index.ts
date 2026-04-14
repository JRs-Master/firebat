import type { InfraResult } from '../types';

/**
 * Firebat - Core Ports
 * Core가 물리적 세상(Infra)과 통신하기 위해 요구하는 엄격한 인터페이스(명세서)입니다.
 * 중요: Core는 절대 try-catch에 의존하지 않으며, Infra는 에러 발생 시 throw 대신 무조건 InfraResult(success:false)를 반환해야 합니다.
 */

export interface IStoragePort {
  /**
   * 해당 경로의 텍스트 콘텐츠 읽기
   */
  read(path: string): Promise<InfraResult<string>>;

  /**
   * 파일 쓰기(부모 폴더 자동 생성 포함)
   */
  write(path: string, content: string): Promise<InfraResult<void>>;

  /**
   * 파일 삭제
   */
  delete(path: string): Promise<InfraResult<void>>;

  /**
   * 디렉토리 내 파일 목록 조회 (이름 목록)
   */
  list(path: string): Promise<InfraResult<string[]>>;

  /**
   * 디렉토리 내 항목 목록 조회 (이름 + 디렉토리 여부)
   */
  listDir(path: string): Promise<InfraResult<Array<{ name: string; isDirectory: boolean }>>>;
}

export interface ILogPort {
  // 로깅은 시스템 종료와 무관하므로 예외적으로 리턴값을 강제하지 않음
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  debug(message: string, meta?: any): void;
}

export interface ISandboxPort {
  /**
   * 유저 모듈 코드를 자식 프로세스로 실행하고 그 ModuleOutput을 InfraResult에 담아 리턴
   */
  execute(targetPath: string, inputData: any): Promise<InfraResult<any>>;
}

/** LLM 호출 옵션 — 요청별 모델 오버라이드 등 */
export interface LlmCallOpts {
  /** 이 호출에만 사용할 모델 (미지정 시 기본 모델) */
  model?: string;
}

export interface ILlmPort {
  /**
   * AI에게 질의를 보내고 JSON 파싱된 결과를 받아옵니다. (Agent 전용)
   */
  ask(prompt: string, systemPrompt?: string, history?: any[], opts?: LlmCallOpts): Promise<InfraResult<any>>;

  /**
   * AI에게 질의를 보내고 순수 텍스트 결과를 받아옵니다. (코드 어시스트 등 JSON 불필요 시)
   */
  askText(prompt: string, systemPrompt?: string, opts?: LlmCallOpts): Promise<InfraResult<string>>;

  /**
   * 기본 모델 ID 반환
   */
  getModelId(): string;
}

export interface INetworkPort {
  /**
   * 격리 샌드박스 없이 빠르게 수행하는 가벼운 HTTP 통신
   */
  fetch(url: string, options?: any): Promise<InfraResult<any>>;
}

/** 파이프라인 단계 정의 */
export interface PipelineStep {
  type: string;         // TEST_RUN | MCP_CALL | NETWORK_REQUEST | LLM_TRANSFORM
  path?: string;        // TEST_RUN 시 모듈 경로
  server?: string;      // MCP_CALL 시 서버명
  tool?: string;        // MCP_CALL 시 도구명
  arguments?: Record<string, any>; // MCP_CALL 시 인자
  url?: string;         // NETWORK_REQUEST 시 URL
  method?: string;      // NETWORK_REQUEST 시 HTTP 메서드
  body?: any;           // NETWORK_REQUEST 시 요청 body
  headers?: Record<string, string>; // NETWORK_REQUEST 시 헤더
  instruction?: string; // LLM_TRANSFORM 시 변환 지시문
  inputData?: any;      // 이 단계에 주입할 고정 입력
  inputMap?: Record<string, any>;   // 입력 매핑 ("$prev" → 이전 단계 결과)
}

export interface CronScheduleOptions {
  cronTime?: string;    // 반복 주기 (크론 표현식)
  runAt?: string;       // 특정 시각 1회 실행 (ISO 8601)
  delaySec?: number;    // N초 후 1회 실행
  startAt?: string;     // 기간 시작 (ISO 8601)
  endAt?: string;       // 기간 종료 — 자동 해제 (ISO 8601)
  inputData?: any;      // 모듈에 전달할 입력 데이터 (실행 시 stdin data로 주입)
  pipeline?: PipelineStep[]; // 복합 작업 파이프라인 (targetPath 대신 사용)
  title?: string;       // 사이드바 표시용 짧은 이름
  description?: string; // 상세 스케줄 설명
}

/** 크론 트리거 정보 — 타이머가 발화할 때 Core에 전달 */
export type CronTriggerInfo = {
  jobId: string;
  targetPath: string;
  trigger: string;    // 'CRON_SCHEDULER' | 'SCHEDULED_ONCE' | 'DELAYED_RUN'
  inputData?: any;
  pipeline?: PipelineStep[]; // 복합 작업 파이프라인
};

/** 크론 잡 실행 결과 — Core가 실행 후 반환 */
export type CronJobResult = {
  jobId: string;
  targetPath: string;
  trigger: string;
  success: boolean;
  durationMs: number;
  error?: string;
};

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
  list(): Array<{ jobId: string; targetPath: string; title?: string; description?: string; cronTime?: string; runAt?: string; delaySec?: number; startAt?: string; endAt?: string; inputData?: any; pipeline?: PipelineStep[]; createdAt: string; mode: string }>;
  /** 타임존 설정 */
  setTimezone(tz: string): void;
  /** 현재 타임존 조회 */
  getTimezone(): string;
  /** 트리거 콜백 등록 — 타이머 발화 시 Core가 실행을 오케스트레이션 */
  onTrigger(callback: (info: CronTriggerInfo) => Promise<CronJobResult>): void;
}

export interface IDatabasePort {
  /**
   * SQL(Postgres/SQLite) 또는 NoSQL(MongoDB) 쿼리를 범용으로 실행하고 결과를 반환합니다.
   * 향후 MongoDB 어댑터를 끼워넣을 때는 queryPayload로 JSON 객체를 그대로 받아서 처리하게 됩니다.
   */
  query(queryPayload: any, options?: any): Promise<InfraResult<any>>;

  // ── PageSpec CRUD ──────────────────────────────────────────────────────
  /** 페이지 목록 조회 (slug, status, title, updatedAt) */
  listPages(): Promise<InfraResult<any[]>>;
  /** 특정 slug의 PageSpec 전체 조회 */
  getPage(slug: string): Promise<InfraResult<any>>;
  /** PageSpec 저장 (upsert) */
  savePage(slug: string, spec: string): Promise<InfraResult<void>>;
  /** 페이지 삭제 */
  deletePage(slug: string): Promise<InfraResult<void>>;
  /** 프로젝트별 페이지 slug 목록 */
  listPagesByProject(project: string): Promise<InfraResult<string[]>>;
  /** 프로젝트 단위 일괄 삭제 */
  deletePagesByProject(project: string): Promise<InfraResult<string[]>>;
}

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

// ── MCP 클라이언트 ──────────────────────────────────────────────────────────

export interface McpServerConfig {
  /** 서버 고유 이름 (예: gmail, slack) */
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
  inputSchema?: any;
}

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
  callTool(serverName: string, toolName: string, args: any): Promise<InfraResult<any>>;
  /** 모든 연결 해제 (셧다운용) */
  disconnectAll(): Promise<void>;
}

/**
 * 9가지 권한을 모두 모아 Core에 주입하기 위한 단일 통제권 컨테이너
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
}

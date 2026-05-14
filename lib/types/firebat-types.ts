/**
 * Firebat 공용 타입 정의 — Frontend / API route / Library 가 사용.
 *
 * 옛 TS Core 의 type 정의들을 추출 — Phase B-4 cutover 후 옛 `core/` 디렉토리 제거 위함.
 * 이 파일은 type-only — 어떤 runtime 의존성도 하지 않음.
 *
 * Rust Core 는 같은 schema 를 serde 로 직렬화/역직렬화 — Frontend 가 받은 JSON 이 이 type 과 1:1.
 *
 * 추후 ts-proto / @bufbuild/protoc-gen-es 도입 시 본 파일을 generated stub 으로 swap 가능.
 */

// ── 페이지 (PageManager) ────────────────────────────────────────────

/** 페이지 list 결과 1건 — 옛 TS PageListItem 1:1. */
export interface PageListItem {
  slug: string;
  title: string;
  status: string;
  project?: string;
  visibility?: 'public' | 'password' | 'private';
  updatedAt?: string;
  createdAt?: string;
  /**
   * Featured image — head.og.image 또는 body 첫 Image src 자동 추출.
   * 카드 magazine 변형·OG 폴백·검색 결과 미리보기에 사용. 추출 실패 시 undefined.
   */
  featuredImage?: string;
  /**
   * 페이지 description — head.description 또는 첫 Text 블록 발췌 (~120자).
   * 카드 list/magazine 변형에서 미리보기.
   */
  excerpt?: string;
}

// ── 인증 (AuthManager) ──────────────────────────────────────────────

/** 인증 세션 — 옛 TS AuthSession 1:1. session 토큰과 API 토큰 모두 통합 모델. */
export interface AuthSession {
  token: string;
  type: 'session' | 'api';
  role: 'admin';
  label?: string;
  createdAt: number;
  expiresAt?: number;
  /**
   * 마지막 사용 시각 (ms epoch) — validateApiToken / validateSession 호출 시 갱신.
   * 도용 의심 패턴 감지 + 미사용 토큰 정리 + 어드민 UI 표시에 활용.
   */
  lastUsedAt?: number;
}

// ── Core Facade Shape ───────────────────────────────────────────────

// ── 파이프라인 / Cron — Rust core/ports.rs 의 typed struct 와 1:1 ─────
//
// 2026-05-14 A1-full Step 4: 옛 `type X = unknown` 폐기. Rust serde rename_all="camelCase"
// + tagged enum 정확히 mirror. 새 step type / 새 op 추가 시 Rust + TS 양쪽 동시 갱신 강제.

/** Pipeline step — Rust `PipelineStep` (tagged "type" + SCREAMING_SNAKE_CASE) 1:1. */
export type PipelineStep =
  | { type: 'EXECUTE'; path: string; inputData?: unknown; inputMap?: unknown }
  | { type: 'MCP_CALL'; server: string; tool: string; arguments?: unknown; inputData?: unknown; inputMap?: unknown }
  | { type: 'NETWORK_REQUEST'; url: string; method?: string; body?: unknown; headers?: unknown }
  | { type: 'LLM_TRANSFORM'; instruction: string; inputData?: unknown; inputMap?: unknown }
  | { type: 'CONDITION'; field: string; op: string; value?: unknown }
  | { type: 'SAVE_PAGE'; slug?: string; spec?: unknown; inputData?: unknown; inputMap?: unknown; allowOverwrite?: boolean }
  | { type: 'TOOL_CALL'; tool: string; inputData?: unknown; inputMap?: unknown };

/** Cron `runWhen` pre-condition — sysmod 호출 결과 의 field 비교. */
export interface CronRunWhenCheck {
  sysmod: string;
  action: string;
  inputData?: unknown;
}

export interface CronRunWhen {
  check: CronRunWhenCheck;
  field: string;
  op: string;
  value?: unknown;
}

/** Cron retry 정책 — count 회 반복, delayMs 간격. */
export interface CronRetry {
  count: number;
  delayMs?: number;
}

/** Cron notify hook — onSuccess / onError sysmod 호출 + template 치환. */
export interface CronNotifyHook {
  sysmod: string;
  template?: string;
  chatId?: string;
}

export interface CronNotify {
  onSuccess?: CronNotifyHook;
  onError?: CronNotifyHook;
}

/** executionMode — agent 모드 (LLM 직접) / 미설정 (pipeline 또는 sandbox). */
export type CronExecutionMode = 'agent' | string;

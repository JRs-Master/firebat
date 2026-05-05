/**
 * Firebat 공용 타입 정의 — Frontend / API route / Library 가 사용.
 *
 * 옛 TS Core 의 type 정의들을 추출 — Phase B-4 cutover 후 옛 `core/` 디렉토리 제거 위함.
 * 이 파일은 type-only — 어떤 runtime 의존성도 박지 않음.
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

/**
 * Firebat Core facade interface — Frontend 가 `getCore()` 로 받는 객체의 shape.
 *
 * 실 구현은 `RustCoreProxy` (lib/rust-core-proxy.ts) — Proxy + Reflect 패턴으로 메서드 호출 시
 * `callCore('methodName', wrappedArgs)` 로 자동 변환 → gRPC → Rust Core.
 *
 * 본 type 은 Frontend 의 옛 호출 패턴 (`core.savePage(slug, spec)`) 과 호환성 유지용 — `any` 로
 * 노출. 정밀 typed shape 은 매니저별 typed proto stub 박힌 후 swap 가능.
 *
 * **중요**: 옛 TS `core/index.ts` 의 FirebatCore class 는 Phase B-4 cutover 후 폐기. 본 type 만
 * Frontend 가 의존.
 */
export type FirebatCore = any;

// ── 파이프라인 / Cron — 옛 core/ports 의 TS interface 들 ─────────────
//
// Frontend 는 backend 가 결정한 JSON shape 그대로 forward — Rust serde 가 single source.
// 따라서 type alias 로 noop 박음 (Phase B-4 cutover 단계, 후속에서 정밀 type 으로 교체 가능).

export type PipelineStep = unknown;
export type CronRunWhen = unknown;
export type CronRetry = unknown;
export type CronNotify = unknown;
export type CronExecutionMode = unknown;

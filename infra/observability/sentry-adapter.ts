/**
 * Sentry Adapter — 서버 사이드 초기화 + StatusManager subscriber + Logger forward.
 *
 * 디자인:
 *   - DSN 미설정 시 자동 비활성 (사용자 부담 0)
 *   - DSN 우선순위: process.env.SENTRY_DSN → Vault 'system:sentry-dsn'
 *   - 일반 로직 — 특정 에러·도메인 분기 X. 모든 logger.error / status error 자동 forward
 *   - PII 마스킹은 pii-sanitizer 가 일괄 처리
 *   - 멱등 — 재호출 시 한 번만 초기화 (globalThis 캐시)
 *
 * 사용:
 *   1. sentry.server.config.ts 가 모듈 로드 시 자동 init (Next.js 런타임 진입점)
 *   2. infra/boot.ts 에서 wireServerSideForwarders(core) 호출 — StatusManager subscribe + logger wrap
 */
import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryEvent, sanitizeBreadcrumb } from './pii-sanitizer';

type GlobalSentryState = {
  firebatSentryInitialized?: boolean;
  firebatSentryEnabled?: boolean;
  firebatSentryWiredCore?: unknown;
};

const g = globalThis as unknown as GlobalSentryState;

/** Vault 키 — DSN 영속 저장 (어드민 UI 입력 시) */
export const VK_SENTRY_DSN = 'system:sentry-dsn';
export const VK_SENTRY_ENV = 'system:sentry-environment';

/** DSN 결정 — env 우선, fallback Vault. 둘 다 비면 null (Sentry 비활성). */
export function resolveSentryDsn(vaultGet?: (key: string) => string | null | undefined): string | null {
  const envDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (envDsn && envDsn.startsWith('https://')) return envDsn;
  if (vaultGet) {
    const v = vaultGet(VK_SENTRY_DSN);
    if (v && v.startsWith('https://')) return v;
  }
  return null;
}

/** 환경 (production/development/staging 등). env 우선, fallback Vault, 최종 NODE_ENV. */
export function resolveSentryEnvironment(vaultGet?: (key: string) => string | null | undefined): string {
  return process.env.SENTRY_ENVIRONMENT
    || (vaultGet ? vaultGet(VK_SENTRY_ENV) || '' : '')
    || process.env.NODE_ENV
    || 'development';
}

/**
 * Sentry 초기화 (서버·Edge 공통). 클라이언트는 sentry.client.config.ts 가 별도 init.
 * 멱등 — 이미 초기화됐으면 noop.
 */
export function initSentryServer(opts: {
  dsn: string | null;
  environment: string;
  runtime: 'nodejs' | 'edge';
}): boolean {
  if (g.firebatSentryInitialized) return g.firebatSentryEnabled === true;

  if (!opts.dsn) {
    g.firebatSentryInitialized = true;
    g.firebatSentryEnabled = false;
    return false;
  }

  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    // 트레이스 샘플링은 보수적으로 — 비용·노이즈 방지. 사용자가 필요시 env 로 조정.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    // 에러는 모두 보냄 (sampleRate=1 default).
    // PII 마스킹 — beforeSend / beforeBreadcrumb 양쪽 적용.
    beforeSend: (event) => sanitizeSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
    beforeBreadcrumb: (crumb) => sanitizeBreadcrumb(crumb as unknown as Record<string, unknown>) as unknown as typeof crumb,
    // 표준 옵션
    sendDefaultPii: false,
    debug: false,
    // Next.js 16 + Sentry 10.x — Edge 런타임은 일부 SDK 옵션 미지원. integrations 빈 배열로 시작.
    integrations: [],
  });

  g.firebatSentryInitialized = true;
  g.firebatSentryEnabled = true;
  return true;
}

/** Sentry 활성 여부 — Logger wrap 등에서 분기용 */
export function isSentryEnabled(): boolean {
  return g.firebatSentryEnabled === true;
}

/** 임의 메시지 캡처 (logger.error wrap 용). PII 마스킹은 beforeSend 가 처리. */
export function captureError(message: string, meta?: Record<string, unknown>): void {
  if (!isSentryEnabled()) return;
  try {
    Sentry.withScope((scope) => {
      if (meta) {
        // extras 는 beforeSend 가 자동 sanitize.
        scope.setExtras(meta);
      }
      // Error 객체로 변환 → 스택트레이스 포함
      Sentry.captureException(new Error(message));
    });
  } catch {
    // Sentry 실패가 앱을 죽이면 안 됨
  }
}

/** 직접 Exception 캡처 (try/catch 블록 등) */
export function captureException(err: unknown, meta?: Record<string, unknown>): void {
  if (!isSentryEnabled()) return;
  try {
    Sentry.withScope((scope) => {
      if (meta) scope.setExtras(meta);
      Sentry.captureException(err);
    });
  } catch {
    // noop
  }
}

/**
 * Logger 의 error 를 Sentry 로 자동 forward.
 * ILogPort 구현체를 wrap — 기존 동작 (콘솔·파일) 유지하고 추가로 Sentry 호출.
 *
 * 멱등 — 같은 logger 객체에 두 번 wrap 방지 (Symbol 마커).
 */
const SENTRY_WRAP_MARKER = Symbol.for('firebat.sentry.logger.wrapped');

/** ILogPort 호환 logger 의 error 메서드를 wrap. ILogPort.LogMeta 가 Record 보다 좁아도 동작하도록 unknown 통과. */
export function wrapLoggerWithSentry<T extends { error: (msg: string, meta?: never) => void }>(logger: T): T {
  // 이미 wrap 된 logger 면 그대로 반환
  if ((logger as unknown as Record<symbol, boolean>)[SENTRY_WRAP_MARKER]) return logger;

  const original = (logger as unknown as { error: (msg: string, meta?: unknown) => void }).error.bind(logger);
  (logger as unknown as { error: (msg: string, meta?: unknown) => void }).error = (msg: string, meta?: unknown) => {
    original(msg, meta);
    captureError(msg, (meta && typeof meta === 'object') ? (meta as Record<string, unknown>) : undefined);
  };
  (logger as unknown as Record<symbol, boolean>)[SENTRY_WRAP_MARKER] = true;
  return logger;
}

/**
 * StatusManager subscriber — error 종료된 job 자동 forward.
 *
 * core: FirebatCore. 구체 import 회피 (순환 참조) — 메서드 시그니처만 의존.
 * 반환: unsubscribe 함수.
 */
export function wireStatusManagerForwarder(core: {
  subscribeJobUpdates: (h: (e: { job: { id: string; type: string; status: string; error?: string; meta?: Record<string, unknown> }; change: string }) => void) => () => void;
}): () => void {
  // 같은 core 에 중복 wire 방지
  if (g.firebatSentryWiredCore === core) {
    return () => { /* already wired */ };
  }
  g.firebatSentryWiredCore = core;

  return core.subscribeJobUpdates((evt) => {
    if (evt.change !== 'failed') return;
    if (!isSentryEnabled()) return;
    const { job } = evt;
    try {
      Sentry.withScope((scope) => {
        scope.setTag('job_type', job.type);
        scope.setTag('job_id', job.id);
        if (job.meta) scope.setExtras(job.meta);
        Sentry.captureException(new Error(`[StatusManager] ${job.type} job failed: ${job.error || 'unknown error'}`));
      });
    } catch {
      // noop
    }
  });
}

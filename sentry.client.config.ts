/**
 * Sentry 클라이언트 (브라우저) 초기화.
 *
 * NEXT_PUBLIC_SENTRY_DSN 만 사용 (브라우저 노출 가능 환경변수).
 * 비활성: DSN 미설정 시 noop.
 *
 * 어드민 채팅 본문·Vault 키·토큰 등 PII 는 beforeSend 에서 일괄 mask.
 */
import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryEvent, sanitizeBreadcrumb } from './infra/observability/pii-sanitizer';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn && dsn.startsWith('https://')) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    // 브라우저 replay·session·breadcrumb 모두 PII 위험 — 보수적 옵션.
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
    beforeSend: (event) => sanitizeSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
    beforeBreadcrumb: (crumb) => sanitizeBreadcrumb(crumb as unknown as Record<string, unknown>) as unknown as typeof crumb,
    sendDefaultPii: false,
    debug: false,
    integrations: [],
  });
}

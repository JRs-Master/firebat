/**
 * Sentry Edge 런타임 초기화 (proxy.ts / middleware 등).
 *
 * Edge 런타임은 fs / crypto.randomBytes 등 일부 Node API 미지원.
 * Sentry SDK 의 Edge 호환 옵션만 사용.
 */
import * as Sentry from '@sentry/nextjs';
import { sanitizeSentryEvent, sanitizeBreadcrumb } from './infra/observability/pii-sanitizer';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn && dsn.startsWith('https://')) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    beforeSend: (event) => sanitizeSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
    beforeBreadcrumb: (crumb) => sanitizeBreadcrumb(crumb as unknown as Record<string, unknown>) as unknown as typeof crumb,
    sendDefaultPii: false,
    debug: false,
  });
}

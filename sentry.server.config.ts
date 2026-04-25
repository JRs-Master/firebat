/**
 * Sentry 서버 사이드 초기화 (Node.js 런타임).
 *
 * Next.js instrumentation hook 으로 진입. DSN 미설정 시 자동 비활성.
 * PII 마스킹 + 토큰·시크릿 패턴 자동 redact 는 sanitizeSentryEvent 가 처리.
 */
import { initSentryServer, resolveSentryDsn, resolveSentryEnvironment } from './infra/observability/sentry-adapter';

// 모듈 로드 시점엔 Vault 미접근 (boot.ts 가 vault 셋업하기 전 가능성). env 만 우선 시도.
// 어드민 UI 에서 DSN 입력 후 저장 시엔 별도 init 호출 또는 재시작 필요.
const dsn = resolveSentryDsn();
if (dsn) {
  initSentryServer({
    dsn,
    environment: resolveSentryEnvironment(),
    runtime: 'nodejs',
  });
}

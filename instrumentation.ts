/**
 * Firebat System Bootstrap
 * Next.js instrumentation hook — 서버 최초 기동 시 한 번만 실행됩니다.
 * Node.js 런타임에서만 child_process를 사용하는 코드를 로드합니다.
 *
 * Sentry: NEXT_RUNTIME 별 config 로드. DSN 미설정 시 자동 noop.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
    const { setupSystemDependencies } = await import('./instrumentation.node');
    setupSystemDependencies().catch((e: any) =>
      console.warn('[Firebat] Bootstrap warning:', e?.message)
    );
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Firebat — Next.js instrumentation hook.
 *
 * 서버 최초 기동 시 1회 — Node.js 런타임에서만 instrumentation.node 로드 (SIGTERM/SIGINT
 * graceful shutdown handler 등록). Edge Runtime 에서는 skip.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node');
  }
}

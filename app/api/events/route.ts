import { NextRequest } from 'next/server';
import { eventBus, type FirebatEvent } from '../../../lib/events';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { logger } from '../../../lib/util/logger';

/** GET /api/events — SSE 이벤트 스트림 (Core → 클라이언트 실시간 알림) */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
  };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));

      unsubscribe = eventBus.subscribe((event: FirebatEvent) => {
        if (closed) return;
        try {
          const data = JSON.stringify({ type: event.type, data: event.data });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch (e) {
          // 클라이언트 끊김 (브라우저 close / 네트워크 drop) — 진단 가시화.
          logger.debug('events', 'SSE event enqueue 실패 — 클라이언트 끊김 추정', { error: e, eventType: event.type });
          cleanup();
        }
      });

      keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch (e) {
          // 30s ping 실패 = 클라이언트 끊김. 진단 가시화 + cleanup.
          logger.debug('events', 'SSE keepalive ping 실패 — 클라이언트 끊김 추정', { error: e });
          cleanup();
        }
      }, 30000);
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

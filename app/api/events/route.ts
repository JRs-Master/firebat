import { NextRequest } from 'next/server';
import { eventBus, type FirebatEvent } from '../../../lib/events';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

/** GET /api/events — SSE 이벤트 스트림 (Core → 클라이언트 실시간 알림) */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
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
        } catch { cleanup(); }
      });

      keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch { cleanup(); }
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

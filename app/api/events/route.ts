import { NextRequest } from 'next/server';
import { eventBus, type FirebatEvent } from '../../../lib/events';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { logger } from '../../../lib/util/logger';
import { createClient } from '@connectrpc/connect';
import { EventService } from '../../../lib/proto-gen/firebat_pb';
import { transport } from '../../../lib/api-gen/_transport';

/** GET /api/events — SSE 이벤트 스트림 (Core → 클라이언트 실시간 알림)
 *  Rust EventManager 의 이벤트(status:update / cron:complete / gallery:refresh / sidebar:refresh)를
 *  gRPC server-stream(EventService.Subscribe)으로 받아 SSE 로 forward. + Next-local eventBus 도 같이. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const ac = new AbortController();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
    try { ac.abort(); } catch { /* already aborted */ }
  };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));

      const send = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
        } catch (e) {
          // 클라이언트 끊김 (브라우저 close / 네트워크 drop) — 진단 가시화.
          logger.debug('events', 'SSE event enqueue 실패 — 클라이언트 끊김 추정', { error: e, eventType: type });
          cleanup();
        }
      };

      // Next-local eventBus — Next 측에서 직접 emit 하는 이벤트(현재 없음, 향후 대비).
      unsubscribe = eventBus.subscribe((event: FirebatEvent) => send(event.type, event.data));

      // Rust EventManager → gRPC server-stream → SSE 다리. 끊김 시 ac.abort 로 Rust 측 자동 unsubscribe.
      (async () => {
        try {
          const eventClient = createClient(EventService, transport);
          for await (const ev of eventClient.subscribe({}, { signal: ac.signal })) {
            if (closed) break;
            let data: unknown = null;
            if (ev.dataJson) { try { data = JSON.parse(ev.dataJson); } catch { data = null; } }
            send(ev.type, data);
          }
        } catch (e) {
          // 정상 종료(abort) 포함 — closed 면 조용히, 아니면 진단 후 재연결은 EventSource 가 처리.
          if (!closed) {
            logger.debug('events', 'Rust 이벤트 스트림 종료/끊김 — 재연결 대기', { error: e });
            cleanup();
          }
        }
      })();

      // keepalive 15s — Caddy / reverse proxy idle timeout 경계 회피 (hub chat SSE 와 통일).
      keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch (e) {
          logger.debug('events', 'SSE keepalive ping 실패 — 클라이언트 끊김 추정', { error: e });
          cleanup();
        }
      }, 15000);
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

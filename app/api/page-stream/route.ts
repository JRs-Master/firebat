import { NextRequest } from 'next/server';
import { logger } from '../../../lib/util/logger';
import { createClient } from '@connectrpc/connect';
import { EventService } from '../../../lib/proto-gen/firebat_pb';
import { transport } from '../../../lib/api-gen/_transport';
import { get as getPageRpc } from '../../../lib/api-gen/page';
import { parsePageRecord } from '../../../lib/util/page-pb-convert';
import { resolvePageVisibility } from '../../../lib/page-visibility';

/**
 * GET /api/page-stream?slug=&topic= — 발행 페이지 전용 공개 SSE (S6).
 *
 * admin `/api/events` 는 필터 없는 전체 스트림(인증 게이트)이라 공개 재사용 시 어드민 이벤트
 * (status/cron/sidebar/gallery)가 통째로 새므로, 공개 표면은 이 라우트 하나로만 —
 * **서버측 topic 필터**(EventService.Subscribe topics → Rust EventFilter::Types)로 요청한
 * topic 의 프레임만 흐른다.
 *
 * 게이트 3중 (익명 endpoint 의 전부):
 *   1. slug 페이지 실재 + visibility=public (resolvePageVisibility — RSC 와 단일 정책)
 *   2. topic ∈ 그 페이지 spec 의 live 블록(props.topic) — 페이지에 없는 topic 은 못 엿들음
 *      (allowlist = 페이지 spec 자체, page-form 의 "저장 승인 = 배선 승인" 원칙 미러)
 *   3. IP 동시 연결 캡 (4) — 익명 SSE 팬아웃 방어
 */

/** live 계열 컴포넌트 type — 이 블록들의 props.topic 만 공개 구독 허용. */
const LIVE_TYPES = new Set(['live_feed', 'livefeed', 'live_chart', 'livechart', 'live_stock_chart', 'livestockchart']);

/** spec 트리에서 live 블록 topic 수집 — module._baked 안 live 블록도 정당한 페이지 일부라 전체 walk. */
function collectLiveTopics(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const c of node) collectLiveTopics(c, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
  if (LIVE_TYPES.has(type)) {
    const topic = (rec.props as Record<string, unknown> | undefined)?.topic;
    if (typeof topic === 'string' && topic.trim()) out.add(topic.trim());
  }
  for (const v of Object.values(rec)) collectLiveTopics(v, out);
}

/** IP 동시 연결 캡 — 프로세스 로컬 카운터 (single-instance 배포 전제, events/route 클래스). */
const ipConn = new Map<string, number>();
const MAX_CONN_PER_IP = 4;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug')?.trim() ?? '';
  const topic = req.nextUrl.searchParams.get('topic')?.trim() ?? '';
  if (!slug || !topic) return new Response('missing slug/topic', { status: 400 });

  // 게이트 1 — 페이지 실재 + public.
  const result = await getPageRpc({ slug }).catch(() => null);
  if (!result?.ok || !result.data) return new Response('not found', { status: 404 });
  const spec = parsePageRecord(result.data);
  const visibility = await resolvePageVisibility(spec);
  if (visibility !== 'public') return new Response('forbidden', { status: 403 });

  // 게이트 2 — topic 이 그 페이지 spec 의 live 블록에 선언돼 있어야.
  const topics = new Set<string>();
  collectLiveTopics((spec as Record<string, unknown>).body, topics);
  if (!topics.has(topic)) return new Response('forbidden', { status: 403 });

  // 게이트 3 — IP 동시 연결 캡.
  const ip = clientIp(req);
  const cur = ipConn.get(ip) ?? 0;
  if (cur >= MAX_CONN_PER_IP) return new Response('too many connections', { status: 429 });
  ipConn.set(ip, cur + 1);

  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const ac = new AbortController();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    const n = (ipConn.get(ip) ?? 1) - 1;
    if (n <= 0) ipConn.delete(ip);
    else ipConn.set(ip, n);
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
          logger.debug('page-stream', 'SSE enqueue 실패 — 클라이언트 끊김 추정', { error: e, slug, topic });
          cleanup();
        }
      };

      // Rust EventManager → 서버측 Types 필터 구독 → SSE. 요청 topic 프레임만 흐른다.
      (async () => {
        try {
          const eventClient = createClient(EventService, transport);
          for await (const ev of eventClient.subscribe({ topics: [topic] }, { signal: ac.signal })) {
            if (closed) break;
            let data: unknown = null;
            if (ev.dataJson) { try { data = JSON.parse(ev.dataJson); } catch { data = null; } }
            send(ev.type, data);
          }
        } catch (e) {
          if (!closed) {
            logger.debug('page-stream', 'Rust 이벤트 스트림 종료/끊김', { error: e, slug, topic });
            cleanup();
          }
        }
      })();

      // keepalive 15s — reverse proxy idle timeout 경계 회피 (events/route 와 통일).
      keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch { cleanup(); }
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

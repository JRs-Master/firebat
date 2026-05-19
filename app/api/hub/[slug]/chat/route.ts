import { NextRequest } from 'next/server';
import { sendMessage } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

// AI 응답 대기 시간 고려 (CLI 모드 멀티턴 도구 호출 포함 가능). admin chat 과 동일.
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

/**
 * 외부 hub endpoint — POST /api/hub/<slug>/chat
 *
 * 워드프레스 등 외부 사이트 위젯이 호출. admin auth 미사용. 대신:
 *   - Header `X-Api-Token` (인스턴스 발급 token)
 *   - Header `X-Session-Id` (방문자 localStorage UUID — 대화 동일성 유지)
 *   - Header `Origin` (allowed_domains whitelist 검사)
 *
 * Body: `{ message: string }`
 *
 * 비즈니스 흐름은 모두 Rust HubService.SendMessage RPC 안에서 처리:
 *   1. authenticate (slug + api_token + origin)
 *   2. ensure_conversation (instance_id + session_id)
 *   3. append_user_message
 *   4. HubContext (allowed_sysmods / allowed_references / history) + AiManager 호출
 *   5. append_system_message
 *
 * route 는 HTTP/SSE 어댑터 역할만 — header 영역 추출 + SSE wrap.
 *
 * SSE 이벤트:
 *   result — { conversationId, success, reply, blocks?, suggestions? }
 *   error  — { error }
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  // 우리 사이트 자신의 호스트 — Rust HubManager 가 origin == self host 면 자동 허용 (admin demo / page mode).
  // x-forwarded-host = Caddy reverse proxy 가 전달하는 사용자 원본 host. 폴백 = req.headers.get('host').
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';

  if (!apiToken) {
    return jsonResponse(401, { error: 'X-Api-Token 헤더가 필요합니다.' });
  }
  if (!sessionId) {
    return jsonResponse(400, { error: 'X-Session-Id 헤더가 필요합니다.' });
  }

  let body: { message?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: '요청 본문이 잘못됐습니다.' });
  }
  const userMessage = (body?.message ?? '').toString().trim();
  if (!userMessage) {
    return jsonResponse(400, { error: 'message 필드가 필요합니다.' });
  }

  return streamResponse({ slug, apiToken, sessionId, origin, selfHost, userMessage, abortSignal: req.signal });
}

function streamResponse(args: {
  slug: string;
  apiToken: string;
  sessionId: string;
  origin: string;
  selfHost: string;
  userMessage: string;
  abortSignal: AbortSignal;
}) {
  const { slug, apiToken, sessionId, origin, selfHost, userMessage, abortSignal } = args;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); }
        catch { closed = true; }
      };
      const send = (event: string, data: unknown) => {
        try {
          safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (err) {
          logger.debug('hub', 'SSE send 실패', { event, error: err });
        }
      };

      const onAbort = () => { closed = true; };
      try { abortSignal?.addEventListener('abort', onAbort); } catch {}

      const keepAlive = setInterval(() => {
        if (closed) { clearInterval(keepAlive); return; }
        safeEnqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
      }, 15000);

      try {
        const r = await sendMessage({
          slug,
          apiToken,
          origin,
          selfHost,
          sessionId,
          userMessage,
        });

        if (!r.ok) {
          // Rust HubManager 의 UNAUTHORIZED_ORIGIN: sentinel — 무단 임베드 발견 시.
          // 403 reject 대신 Firebat 광고 메시지 + 사이트 링크 SSE 응답 — 무단 사용자 활용 트래픽화.
          const UNAUTHORIZED_PREFIX = 'UNAUTHORIZED_ORIGIN:';
          if (r.message.includes(UNAUTHORIZED_PREFIX)) {
            send('result', {
              conversationId: '',
              success: true,
              reply:
                '🔥 **Firebat Just Imagine. Firebat runs.**\n\n' +
                '이 챗봇은 무단으로 임베드되어 있습니다. ' +
                '직접 만든 AI 어시스턴트를 본인 사이트에 설치하고 싶으시다면 ' +
                '[firebat.co.kr](https://firebat.co.kr) 에서 무료로 시작하실 수 있습니다.',
              blocks: undefined,
              suggestions: ['firebat.co.kr 둘러보기'],
            });
          } else {
            send('error', { error: r.message });
          }
        } else {
          const { conversationId, rawJson } = r.data;
          let aiResponse: Record<string, unknown> = {};
          try {
            aiResponse = JSON.parse(rawJson);
          } catch (err) {
            logger.debug('hub', 'rawJson 파싱 실패', { error: err });
          }
          const reply = typeof aiResponse.reply === 'string' ? aiResponse.reply : '';
          const data = aiResponse.data;
          const blocks = aiResponse.blocks;
          const suggestions = aiResponse.suggestions;
          const success = aiResponse.success !== false;
          const error = typeof aiResponse.error === 'string' ? aiResponse.error : undefined;

          send('result', {
            conversationId,
            success,
            reply,
            data,
            blocks,
            suggestions,
            error,
          });
        }
      } catch (err) {
        send('error', { error: (err as Error)?.message ?? '알 수 없는 오류' });
      }

      clearInterval(keepAlive);
      try { abortSignal?.removeEventListener('abort', onAbort); } catch {}
      closed = true;
      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // 외부 사이트 (워드프레스 등) 안 직접 호출 가능하도록 CORS open.
      // 진짜 인증은 X-Api-Token + allowed_domains 안 처리.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Type',
    },
  });
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// CORS preflight — 외부 사이트 fetch 자동 호출.
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

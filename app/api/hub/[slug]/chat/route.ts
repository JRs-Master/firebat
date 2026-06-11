import { NextRequest } from 'next/server';
import { createClient } from '@connectrpc/connect';
import { HubService } from '../../../../../lib/proto-gen/firebat_pb';
import { transport } from '../../../../../lib/api-gen/_transport';
import { unBigInt } from '../../../../../lib/api-gen/_unbigint';
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

  let body: { message?: string; planMode?: string; planExecuteId?: string; planReviseId?: string; userMsgId?: string; aiMsgId?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: '요청 본문이 잘못됐습니다.' });
  }
  const userMessage = (body?.message ?? '').toString().trim();
  if (!userMessage) {
    return jsonResponse(400, { error: 'message 필드가 필요합니다.' });
  }
  // visitor 의 plan mode — Rust HubService.SendMessage 가 받아 LlmCallOpts.plan_mode + AiRequestOpts.plan_mode 로 전달.
  const planMode = typeof body.planMode === 'string' ? body.planMode : '';
  // ✓실행 / ⚙수정 제안 — visitor 가 plan card 클릭 시 frontend 가 동봉. Rust HubService 가 plan_store 조회 후
  // 시스템 프롬프트 안 plan_to_instruction / plan_to_revise_instruction 주입.
  const planExecuteId = typeof body.planExecuteId === 'string' ? body.planExecuteId : '';
  const planReviseId = typeof body.planReviseId === 'string' ? body.planReviseId : '';
  // 클라 발급 메시지 id — 프론트 로컬 메시지와 hub_messages 정렬(admin systemId 패턴). 빈 값 = uuid fallback.
  const userMsgId = typeof body.userMsgId === 'string' ? body.userMsgId : '';
  const aiMsgId = typeof body.aiMsgId === 'string' ? body.aiMsgId : '';

  return streamResponse({ slug, apiToken, sessionId, origin, selfHost, userMessage, planMode, planExecuteId, planReviseId, userMsgId, aiMsgId, abortSignal: req.signal });
}

function streamResponse(args: {
  slug: string;
  apiToken: string;
  sessionId: string;
  origin: string;
  selfHost: string;
  userMessage: string;
  planMode: string;
  planExecuteId: string;
  planReviseId: string;
  userMsgId: string;
  aiMsgId: string;
  abortSignal: AbortSignal;
}) {
  const { slug, apiToken, sessionId, origin, selfHost, userMessage, planMode, planExecuteId, planReviseId, userMsgId, aiMsgId, abortSignal } = args;
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
        // admin chat 과 동일한 streaming RPC — Rust 가 인증 + 대화 ensure + user 영속화 + AI 호출(emit)
        // + AI 응답 영속화를 한 흐름에 처리하고 chunk/step/result/error 를 server-stream. 옛 unary
        // SendMessage 분기 폐기 → hub plan mode 가 admin 과 같은 경로 = plan-confirm 실행 카드 누락 차단.
        const hubClient = createClient(HubService, transport);
        const aiStream = hubClient.sendMessageStream({
          slug,
          apiToken,
          origin,
          selfHost,
          sessionId,
          userMessage,
          planMode,
          planExecuteId,
          planReviseId,
          userMsgId,
          aiMsgId,
        } as any);

        let finalResult: Record<string, unknown> | null = null;
        let stepIndex = 0;

        for await (const ev of aiStream) {
          const evt: any = unBigInt(ev);
          const oneof = evt?.event;
          if (!oneof) continue;
          if (oneof.case === 'chunk') {
            const v = oneof.value;
            send('chunk', { type: v.eventType, content: v.content });
          } else if (oneof.case === 'step') {
            const v = oneof.value;
            send('step', {
              index: stepIndex,
              type: v.name,
              status: v.status,
              description: v.description ?? v.name,
              error: v.errorMessage ?? undefined,
            });
            if (v.status !== 'start') stepIndex++;
          } else if (oneof.case === 'result') {
            try {
              finalResult = JSON.parse(oneof.value.rawJson);
            } catch (e) {
              send('error', { error: `result JSON 파싱 실패: ${(e as Error).message}` });
            }
          } else if (oneof.case === 'error') {
            send('error', { error: oneof.value.errorMessage });
          }
        }

        if (finalResult) {
          const result = finalResult;
          const reply = typeof result.reply === 'string' ? result.reply : '';
          const passthroughData = (result.data && typeof result.data === 'object')
            ? result.data as Record<string, unknown>
            : {};
          // admin /api/chat/stream 의 result event 형식과 동일 — top-level + data 안 mirror.
          const mergedData: Record<string, unknown> = {
            ...passthroughData,
            blocks: result.blocks,
            suggestions: result.suggestions,
            pendingActions: result.pendingActions,
          };
          send('result', {
            success: result.success !== false,
            reply,
            executedActions: result.executedActions,
            toolResults: result.toolResults,
            data: mergedData,
            suggestions: result.suggestions,
            error: typeof result.error === 'string' ? result.error : undefined,
          });
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? '알 수 없는 오류';
        // 인증 단계(streaming RPC 시작 전) UNAUTHORIZED_ORIGIN: sentinel — 무단 임베드 시 403 대신
        // Firebat 광고 응답으로 트래픽화. (Rust authenticate 가 permission_denied 로 던짐 → 여기 catch.)
        if (msg.includes('UNAUTHORIZED_ORIGIN:')) {
          send('result', {
            success: true,
            reply:
              '🔥 **Firebat Just Imagine. Firebat runs.**\n\n' +
              '이 챗봇은 무단으로 임베드되어 있습니다. ' +
              '직접 만든 AI 어시스턴트를 본인 사이트에 설치하고 싶으시다면 ' +
              '[firebat.co.kr](https://firebat.co.kr) 에서 무료로 시작하실 수 있습니다.',
            suggestions: ['firebat.co.kr 둘러보기'],
          });
        } else {
          send('error', { error: msg });
        }
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

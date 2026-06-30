import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { createClient } from '@connectrpc/connect';
import { AiService } from '../../../../lib/proto-gen/firebat_pb';
import { transport } from '../../../../lib/api-gen/_transport';
import { relayChatStream } from '../../../../lib/util/chat-stream-relay';

// CLI 모드 (Claude Code 등) 는 초기 MCP 도구 로딩·멀티턴 도구 사용에 수분 소요 가능.
// Next.js 기본 타임아웃으로 SSE 끊기는 것 방지.
export const maxDuration = 600; // 10분
export const dynamic = 'force-dynamic';

type ChatOpts = {
  model?: string;
  owner?: string;
  image?: string;
  previousResponseId?: string;
  conversationId?: string;
  planMode?: 'off' | 'auto' | 'always';
  planExecuteId?: string;
  planReviseId?: string;
  // chat-turn message ids → Rust persists user/system with these ids (single shared path = process_with_tools).
  userMsgId?: string;
  aiMsgId?: string;
  userImage?: string;
  userSuggestion?: boolean;
};

/**
 * Function Calling SSE 스트리밍 엔드포인트 (User AI 유일 경로)
 *
 * 이벤트 종류:
 *   chunk   — 텍스트·thinking 스트리밍
 *   step    — 도구 호출 진행 (start/done/error)
 *   result  — 최종 응답 (reply + blocks + suggestions + pendingActions)
 *   error   — 오류
 *
 * 레거시 JSON 모드 (plan 이벤트, corrId 기반 2-step) 는 v0.1, 2026-04-22 삭제됨.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { prompt, config, history = [], image, previousResponseId, conversationId, planMode, planExecuteId, planReviseId, systemId, userId, userSuggestion } = await req.json();

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400 });
  }

  // planMode 3단계 지원: 'off'/'auto'/'always'. 레거시 boolean 호환 (true→'always', false→'off').
  const planModeNormalized: 'off' | 'auto' | 'always' | undefined =
    planMode === true || planMode === 'always' ? 'always'
    : planMode === 'auto' ? 'auto'
    : undefined; // 'off' / false / undefined 모두 미전달 (default off)

  const opts: ChatOpts = {
    model: config?.model as string | undefined,
    owner: 'admin',
    ...(image ? { image: image as string } : {}),
    ...(previousResponseId ? { previousResponseId: previousResponseId as string } : {}),
    ...(conversationId ? { conversationId: conversationId as string } : {}),
    ...(planModeNormalized ? { planMode: planModeNormalized } : {}),
    ...(typeof planExecuteId === 'string' && planExecuteId ? { planExecuteId } : {}),
    ...(typeof planReviseId === 'string' && planReviseId ? { planReviseId } : {}),
    // message ids → Rust persists the turn (user+system) server-side in the single shared path, with these
    // ids so the client's reconcile matches. Survives SSE disconnect (the old client-tied TS save did not).
    ...(typeof systemId === 'string' && systemId ? { aiMsgId: systemId } : {}),
    ...(typeof userId === 'string' && userId ? { userMsgId: userId } : {}),
    ...(image ? { userImage: image as string } : {}),
    ...(userSuggestion === true ? { userSuggestion: true } : {}),
  };
  // Turn persistence is server-side (Rust single path via the ids injected into opts) — no saveOpts needed.
  return handleToolsMode(prompt, history, opts, req.signal);
}

/** Function Calling 모드 — 도구 호출 루프를 SSE로 스트리밍 */
function handleToolsMode(
  prompt: string,
  _history: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: ChatOpts,
  abortSignal?: AbortSignal,
) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // 연결 종료 플래그 — controller 가 닫힌 뒤 enqueue 호출하면 throw 발생.
      // CLI 서브프로세스(Claude Code) 는 비동기로 계속 이벤트 emit 하므로,
      // 클라이언트 abort 후에도 엉뚱한 enqueue 시도가 이어지면 uncaughtException 연쇄.
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); }
        catch { closed = true; /* 재시도 금지 — 닫힌 뒤엔 전부 무시 */ }
      };
      const send = (event: string, data: unknown) => {
        try {
          safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* JSON 직렬화 실패 시 조용히 드롭 */ }
      };

      // 클라이언트 abort (페이지 닫기·탭 이동·네트워크 끊김) 감지 → flag 세팅
      const onAbort = () => { closed = true; };
      try { abortSignal?.addEventListener('abort', onAbort); } catch {}

      // Keep-alive ping — 15초마다 SSE 주석. Claude Code 초기 로딩 수분 지속 시 연결 유지.
      const keepAlive = setInterval(() => {
        if (closed) { clearInterval(keepAlive); return; }
        safeEnqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
      }, 15000);

      try {
        // 진짜 streaming RPC — Rust core 가 매 turn 의 reasoning chunk + 도구 호출 step + 최종
        // result event 를 server-stream 으로 전송. 옛 unary requestActionWithTools 폐기.
        const aiClient = createClient(AiService, transport);
        const aiStream = aiClient.streamRequestActionWithTools({
          prompt,
          tools: { toolsJson: '[]' },
          opts: { optsJson: JSON.stringify(opts ?? {}) },
        } as any);

        // Persistence (user + system) is server-side now — the single shared path (Rust process_with_tools)
        // writes the turn with the ai*MsgId injected into `opts` above, in a detached task that survives a
        // client SSE disconnect. This is the background-resume fix: the old client-tied saveMessage here died
        // when the client navigated away, so the answer was lost. The relay only drives the live SSE display.
        await relayChatStream(aiStream, send);
      } catch (err: any) {
        send('error', { error: err?.message || '알 수 없는 오류' });
      }
      clearInterval(keepAlive);
      try { abortSignal?.removeEventListener('abort', onAbort); } catch {}
      closed = true;
      try { controller.close(); } catch { /* 이미 닫혀있으면 무시 */ }
    },
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

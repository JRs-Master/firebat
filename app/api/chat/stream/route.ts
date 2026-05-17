import { NextRequest } from 'next/server';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { requestActionWithTools } from '../../../../lib/api-gen/ai';
import { getConversation, saveConversation } from '../../../../lib/api-gen/conversation';

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
  const { prompt, config, history = [], image, previousResponseId, conversationId, planMode, planExecuteId, planReviseId, systemId, userId } = await req.json();

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
  };
  const saveOpts = {
    systemId: typeof systemId === 'string' ? systemId : undefined,
    userId: typeof userId === 'string' ? userId : undefined,
    userPrompt: prompt,
    image: typeof image === 'string' ? image : undefined,
  };
  return handleToolsMode(prompt, history, opts, req.signal, saveOpts);
}

/** Function Calling 모드 — 도구 호출 루프를 SSE로 스트리밍 */
function handleToolsMode(
  prompt: string,
  _history: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: ChatOpts,
  abortSignal?: AbortSignal,
  saveOpts?: { systemId?: string; userId?: string; userPrompt?: string; image?: string },
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
        const r = await requestActionWithTools({
          prompt,
          tools: { toolsJson: '[]' },
          opts: { optsJson: JSON.stringify(opts ?? {}) },
        } as any);

        if (!r.ok) {
          send('error', { error: r.message });
        } else {
          const result = r.data as {
            success?: boolean;
            reply?: string;
            executedActions?: unknown;
            toolResults?: unknown;
            blocks?: unknown;
            suggestions?: unknown;
            pendingActions?: unknown;
            data?: unknown;
            error?: string;
          };
          // AiResponse 안 = blocks / suggestions / pendingActions / etc 모두 top-level 박힘.
          // 단 옛 frontend (useChat.ts) 안 = `ev.data.data?.blocks` 박은 영역 (옛 TS port 안
          // `result.data` 안 박힌 영역 가정). 즉 backend send 안 `data` 안 = top-level 필드 mirror
          // 박은 영역 = frontend 옛 매핑 호환. 옛 `result.data` 박은 영역 (이미 객체 박혀있으면)
          // 도 같이 박힘 — 옛 호환.
          const passthroughData = result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : {};
          const mergedData: Record<string, unknown> = {
            ...passthroughData,
            blocks: result.blocks,
            suggestions: result.suggestions,
            pendingActions: result.pendingActions,
          };
          send('result', {
            success: result.success,
            reply: result.reply,
            executedActions: result.executedActions,
            toolResults: result.toolResults,
            data: mergedData,
            suggestions: result.suggestions,
            error: result.error,
          });

          // ── 백엔드 주도 저장 (v0.1, 2026-04-22) ─────────────────────────────
          // 프론트 state 가 꼬여도 (애니메이션 throttle·브라우저 crash 등) DB 는 정확한 최종 상태 보유.
          // 클라이언트가 보낸 systemId 로 upsert → unionMerge 가 프론트 POST 와 자연 병합 (동일 ID 일치).
          if (opts.conversationId && saveOpts?.systemId) {
            try {
              // user 메시지 + system(AI 응답) 메시지 쌍 저장
              const userMsg = saveOpts.userId && saveOpts.userPrompt
                ? { id: saveOpts.userId, role: 'user' as const, content: saveOpts.userPrompt, ...(saveOpts.image ? { image: saveOpts.image } : {}) }
                : null;
              // suggestions / pendingActions 포함 — 새로고침 후에도 ✓실행 버튼·승인 UI 복원.
              // `data` 안 mergedData 박힌 영역 그대로 (top-level blocks / suggestions / pendingActions
              // mirror — frontend `ev.data.data.blocks` 매핑 호환).
              const suggestionsArr = Array.isArray(result.suggestions) ? (result.suggestions as unknown[]) : undefined;
              const pendingArr = Array.isArray(result.pendingActions) ? (result.pendingActions as unknown[]) : undefined;
              const systemMsg = {
                id: saveOpts.systemId,
                role: 'system' as const,
                content: result.reply || '',
                executedActions: result.executedActions,
                toolResults: result.toolResults,
                data: mergedData,
                ...(suggestionsArr && suggestionsArr.length > 0 ? { suggestions: suggestionsArr } : {}),
                ...(pendingArr && pendingArr.length > 0 ? { pendingActions: pendingArr } : {}),
                ...(result.error ? { error: result.error } : {}),
              };
              const msgs = userMsg ? [userMsg, systemMsg] : [systemMsg];
              // 기존 title 유지 — 없으면 첫 user 메시지 기반.
              const owner = opts.owner || 'admin';
              const existing = await getConversation({ owner, id: opts.conversationId });
              const existingTitle = existing.ok && existing.data ? existing.data.title : '';
              const title = existingTitle
                || ((saveOpts.userPrompt || '새 대화').slice(0, 28) + ((saveOpts.userPrompt || '').length > 28 ? '…' : ''));
              await saveConversation({
                owner,
                id: opts.conversationId,
                title,
                messagesJson: JSON.stringify(msgs),
              });
            } catch { /* 백엔드 저장 실패해도 프론트 saveToDb 가 백업 역할 — 조용히 무시 */ }
          }
        }
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

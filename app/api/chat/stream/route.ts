import { NextRequest } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import type { FirebatCore } from '../../../../core';

// CLI 모드 (Claude Code 등) 는 초기 MCP 도구 로딩·멀티턴 도구 사용에 수분 소요 가능.
// Next.js 기본 타임아웃으로 SSE 끊기는 것 방지.
export const maxDuration = 600; // 10분
export const dynamic = 'force-dynamic';

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
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { prompt, config, history = [], image, previousResponseId, conversationId, planMode, planExecuteId, planReviseId } = await req.json();

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400 });
  }

  const opts = {
    model: config?.model as string | undefined,
    owner: 'admin',
    ...(image ? { image: image as string } : {}),
    ...(previousResponseId ? { previousResponseId: previousResponseId as string } : {}),
    ...(conversationId ? { conversationId: conversationId as string } : {}),
    ...(planMode === true ? { planMode: true } : {}),
    ...(typeof planExecuteId === 'string' && planExecuteId ? { planExecuteId } : {}),
    ...(typeof planReviseId === 'string' && planReviseId ? { planReviseId } : {}),
  };
  const core = getCore();
  return handleToolsMode(core, prompt, history, opts, req.signal);
}

/** Function Calling 모드 — 도구 호출 루프를 SSE로 스트리밍 */
function handleToolsMode(
  core: FirebatCore,
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { model?: string; owner?: string; image?: string; previousResponseId?: string; conversationId?: string; planMode?: boolean; planExecuteId?: string; planReviseId?: string },
  abortSignal?: AbortSignal,
) {
  const encoder = new TextEncoder();

  const toolLabel = (name: string): string => {
    switch (name) {
      case 'execute': return '모듈 실행 중';
      case 'mcp_call': return '외부 서비스 연결 중';
      case 'network_request': return 'API 호출 중';
      case 'write_file': return '파일 저장 중';
      case 'read_file': return '파일 읽는 중';
      case 'save_page': return '페이지 저장 중';
      case 'delete_page': return '페이지 삭제 중';
      case 'schedule_task': return '스케줄 등록 중';
      case 'cancel_task': return '스케줄 해제 중';
      case 'run_task': return '파이프라인 실행 중';
      case 'request_secret': return 'API 키 요청';
      case 'suggest': return '선택지 제시';
      case 'render_html': return 'HTML 렌더링 중';
      case 'list_dir': return '폴더 목록 조회 중';
      case 'list_pages': return '페이지 목록 조회 중';
      case 'get_page': return '페이지 조회 중';
      case 'delete_file': return '파일 삭제 중';
      case 'list_cron_jobs': return '스케줄 목록 조회 중';
      case 'search_history': return '과거 대화 검색 중';
      default:
        if (name.startsWith('sysmod_')) return `시스템 모듈 실행 중 (${name.replace('sysmod_', '')})`;
        if (name.startsWith('mcp_')) return '외부 서비스 연결 중';
        return name;
    }
  };

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
        let stepIndex = 0;

        const result = await core.requestActionWithTools(prompt, history, opts, (info) => {
          send('step', {
            index: stepIndex,
            type: info.name,
            status: info.status,
            description: toolLabel(info.name),
            error: info.error,
          });
          if (info.status !== 'start') stepIndex++;
        }, (chunk) => {
          send('chunk', chunk);
        });

        send('result', {
          success: result.success,
          reply: result.reply,
          executedActions: result.executedActions,
          data: result.data,
          suggestions: result.data && typeof result.data === 'object' && 'suggestions' in result.data
            ? (result.data as Record<string, unknown>).suggestions
            : undefined,
          error: result.error,
        });
        // NOTE: 이전에 여기서 server-side fail-safe 저장을 시도했으나 프론트 저장과 중복 발생.
        // 프론트에서 id 통일·덮어쓰기 전까지는 서버 저장 비활성.
      } catch (err: any) {
        send('error', { error: err.message || '알 수 없는 오류' });
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

import { NextRequest } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { storePlan } from '../plan-cache';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { PLAN_UI_RENDER_DELAY_MS } from '../../../../infra/config';
import type { FirebatCore } from '../../../../core';

/**
 * Plan-Execute SSE 스트리밍 엔드포인트
 *
 * 이벤트 종류:
 *   plan    — Plan 수립 완료 (actions 목록 포함)
 *   step    — 개별 액션 진행 상황 (start/done/error)
 *   result  — 최종 실행 결과
 *   error   — 오류
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { prompt, config, history = [], autoExecute = false, mode, image, previousResponseId, conversationId } = await req.json();

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400 });
  }

  const isDemo = auth.role === 'demo';
  const owner = auth.role === 'admin' ? 'admin' : 'demo';
  const opts = {
    model: config?.model as string | undefined,
    isDemo,
    owner,
    ...(image ? { image: image as string } : {}),
    ...(previousResponseId ? { previousResponseId: previousResponseId as string } : {}),
    ...(conversationId ? { conversationId: conversationId as string } : {}),
  };
  const core = getCore();

  // Function Calling 모드
  if (mode === 'tools') {
    return handleToolsMode(core, prompt, history, opts);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: '직렬화 실패' })}\n\n`));
        }
      };

      try {
        // 1. Plan 수립
        const planResult = await core.planOnly(prompt, history, opts);

        if (!planResult.success || !planResult.plan) {
          send('error', { error: planResult.error ?? 'Plan 수립 실패' });
          controller.close();
          return;
        }

        const { plan, corrId } = planResult;

        // 단순 대화 (actions 없음) → 바로 결과 전송
        if (plan.actions.length === 0) {
          send('result', {
            success: true,
            thoughts: plan.thoughts,
            reply: plan.reply,
            executedActions: [],
            suggestions: plan.suggestions?.length ? plan.suggestions : undefined,
          });
          controller.close();
          return;
        }

        // 원본 plan을 서버 캐시에 저장 (execute에서 corrId로 조회)
        storePlan(corrId!, plan);

        // 사용자 확인이 필요한 액션 타입 (생성·삭제·예약 등 되돌리기 어려운 작업)
        const CONFIRM_ACTIONS = new Set([
          'SAVE_PAGE', 'DELETE_PAGE', 'DELETE_FILE', 'SCHEDULE_TASK',
        ]);
        const needsConfirm = plan.actions.some(a => CONFIRM_ACTIONS.has(a.type));
        const shouldAutoExecute = autoExecute || !needsConfirm;

        // 프론트엔드에는 요약 정보만 전송 — 타입 기반 고정 메시지
        const stepLabel = (type: string): string => {
          switch (type) {
            case 'EXECUTE': return '시스템 모듈을 불러오는 중';
            case 'MCP_CALL': return '외부 서비스에 연결하는 중';
            case 'NETWORK_REQUEST': return 'API를 호출하는 중';
            case 'LLM_TRANSFORM': return '결과를 정리하는 중';
            case 'WRITE_FILE': return '파일을 저장하는 중';
            case 'READ_FILE': return '파일을 읽는 중';
            case 'SAVE_PAGE': return '페이지를 저장하는 중';
            case 'DELETE_PAGE': return '페이지를 삭제하는 중';
            case 'SCHEDULE_TASK': return '스케줄을 등록하는 중';
            case 'CANCEL_TASK': return '스케줄을 해제하는 중';
            case 'REQUEST_SECRET': return 'API 키 요청';
            case 'CONDITION': return '조건 검사 중';
            default: return type;
          }
        };

        // RUN_TASK는 파이프라인 단계를 풀어서 표시
        const displayActions: any[] = [];
        for (const a of plan.actions) {
          if (a.type === 'RUN_TASK' && (a as any).pipeline?.length) {
            for (const step of (a as any).pipeline) {
              displayActions.push({ type: step.type, description: stepLabel(step.type) });
            }
          } else {
            displayActions.push({ type: a.type, description: stepLabel(a.type) });
          }
        }
        send('plan', {
          thoughts: plan.thoughts,
          reply: plan.reply,
          actions: displayActions,
          corrId,
          suggestions: plan.suggestions?.length ? plan.suggestions : undefined,
        });

        if (!shouldAutoExecute) {
          controller.close();
          return;
        }

        // plan UI 렌더링 대기
        await new Promise(r => setTimeout(r, PLAN_UI_RENDER_DELAY_MS));

        // 자동 실행 모드 → 바로 실행
        const result = await core.executePlan(plan, corrId!, opts, (step) => {
          send('step', { ...step, description: stepLabel((step as any).type) });
        });

        send('result', result);
      } catch (err: any) {
        send('error', { error: err.message || '알 수 없는 오류' });
      }
      controller.close();
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

/** Function Calling 모드 — 도구 호출 루프를 SSE로 스트리밍 */
function handleToolsMode(
  core: FirebatCore,
  prompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  opts: { model?: string; isDemo: boolean; owner?: string; image?: string; previousResponseId?: string; conversationId?: string },
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
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: '직렬화 실패' })}\n\n`));
        }
      };

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
      } catch (err: any) {
        send('error', { error: err.message || '알 수 없는 오류' });
      }
      controller.close();
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

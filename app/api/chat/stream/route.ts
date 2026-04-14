import { NextRequest } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { storePlan } from '../plan-cache';

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
  const { prompt, config, history = [], autoExecute = false } = await req.json();

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400 });
  }

  const isDemo = req.cookies.get('firebat_admin_token')?.value === 'demo';
  const opts = { model: config?.model as string | undefined, isDemo };
  const core = getCore();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

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
      await new Promise(r => setTimeout(r, 100));

      // 자동 실행 모드 → 바로 실행
      const result = await core.executePlan(plan, corrId!, opts, (step) => {
        send('step', { ...step, description: stepLabel((step as any).type) });
      });

      send('result', result);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

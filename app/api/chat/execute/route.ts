import { NextRequest } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { retrievePlan } from '../plan-cache';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * Plan 실행 SSE 엔드포인트
 * 유저가 Plan을 확인한 후 실행 요청
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { corrId, config } = await req.json();

  if (!corrId) {
    return new Response(JSON.stringify({ error: 'corrId is required' }), { status: 400 });
  }

  // 서버 캐시에서 원본 plan 조회
  const plan = retrievePlan(corrId);
  if (!plan) {
    return new Response(JSON.stringify({ error: 'Plan이 만료되었거나 존재하지 않습니다. 다시 요청해 주세요.' }), { status: 404 });
  }

  const isDemo = auth.role === 'demo';
  const opts = { model: config?.model as string | undefined, isDemo };
  const core = getCore();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const stepLabel = (type: string): string => {
        switch (type) {
          case 'EXECUTE': return '시스템 모듈을 불러오는 중';
          case 'MCP_CALL': return '외부 서비스에 연결하는 중';
          case 'NETWORK_REQUEST': return 'API를 호출하는 중';
          case 'LLM_TRANSFORM': return '결과를 정리하는 중';
          case 'WRITE_FILE': return '파일을 저장하는 중';
          case 'SAVE_PAGE': return '페이지를 저장하는 중';
          case 'DELETE_PAGE': return '페이지를 삭제하는 중';
          case 'SCHEDULE_TASK': return '스케줄을 등록하는 중';
          case 'CANCEL_TASK': return '스케줄을 해제하는 중';
          default: return type;
        }
      };
      const result = await core.executePlan(plan, corrId, opts, (step) => {
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

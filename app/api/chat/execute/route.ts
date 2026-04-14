import { NextRequest } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { retrievePlan } from '../plan-cache';

/**
 * Plan 실행 SSE 엔드포인트
 * 유저가 Plan을 확인한 후 실행 요청
 */
export async function POST(req: NextRequest) {
  const { corrId, config } = await req.json();

  if (!corrId) {
    return new Response(JSON.stringify({ error: 'corrId is required' }), { status: 400 });
  }

  // 서버 캐시에서 원본 plan 조회
  const plan = retrievePlan(corrId);
  if (!plan) {
    return new Response(JSON.stringify({ error: 'Plan이 만료되었거나 존재하지 않습니다. 다시 요청해 주세요.' }), { status: 404 });
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

      const result = await core.executePlan(plan, corrId, opts, (step) => {
        send('step', step);
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

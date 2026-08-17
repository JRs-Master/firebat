import { NextRequest, NextResponse } from 'next/server';
import { logger } from '../../../../lib/util/logger';
import { verifyModuleWebhook, processModuleWebhook } from '../../../../lib/api-gen/module';

/**
 * POST /api/hooks/<module> — 모듈이 선언한 인바운드 웹훅의 단일 수신부.
 *
 * 이 라우트는 벤더를 모른다: 어느 헤더가 시크릿을 싣는지, 페이로드를 어떻게 읽는지,
 * 답장을 어디로 보내는지는 전부 그 모듈의 config `webhook` 선언과 액션들이 안다.
 * 여기는 (1) 헤더 전달 → 시크릿 검증 (2) 200 즉답 (재시도 폭탄 방어)
 * (3) 처리 fire-and-forget 만 한다. 선언 없는 모듈 = 401 (부재는 허가가 아니다).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ module: string }> }) {
  const { module } = await ctx.params;
  if (!/^[a-z0-9-]+$/.test(module)) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const verified = await verifyModuleWebhook({ module, headersJson: JSON.stringify(headers) });
  if (!verified.ok || verified.data !== true) {
    return NextResponse.json({ ok: false, error: 'Invalid webhook secret' }, { status: 401 });
  }

  let payload = '';
  try {
    payload = await req.text();
    JSON.parse(payload);
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  // 벤더 서버는 200 을 빨리 받아야 재전송하지 않는다 — 처리 실패는 로그로만.
  processModuleWebhook({ module, payloadJson: payload }).then(res => {
    if (!res.ok) logger.error('webhook', `${module} process 실패`, res.message);
    else {
      const inner = res.data as { success?: boolean; error?: string } | null;
      if (inner && inner.success === false) logger.error('webhook', `${module} process 거부`, inner.error);
    }
  }).catch((err: unknown) => {
    logger.error('webhook', `${module} process 실패`, err);
  });

  return NextResponse.json({ ok: true });
}

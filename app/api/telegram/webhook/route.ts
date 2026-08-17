import { NextRequest, NextResponse } from 'next/server';
import { logger } from '../../../../lib/util/logger';
import { verifyModuleWebhook, processModuleWebhook } from '../../../../lib/api-gen/module';

/**
 * POST /api/telegram/webhook — 옛 수신 주소의 별칭.
 *
 * 정식 수신부는 /api/hooks/telegram (모듈 무관 범용 — /api/hooks/[module]). 텔레그램 서버에는
 * 이 옛 URL 이 등록된 채 남아 있을 수 있어(외부 호환), 같은 검증·처리로 넘긴다.
 * 설정 화면에서 웹훅을 재등록하면 새 주소로 바뀌고, 그 뒤 이 파일은 지워도 된다.
 */
export async function POST(req: NextRequest) {
  const module = 'telegram';
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
  processModuleWebhook({ module, payloadJson: payload }).then(res => {
    if (!res.ok) logger.error('webhook', 'telegram(alias) process 실패', res.message);
  }).catch((err: unknown) => {
    logger.error('webhook', 'telegram(alias) process 실패', err);
  });
  return NextResponse.json({ ok: true });
}

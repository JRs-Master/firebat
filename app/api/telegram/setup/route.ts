import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * 텔레그램 양방향 봇 webhook 등록·해제·상태 조회 — 어드민 전용.
 *
 * - GET     : 현재 webhook 상태 (활성 / URL / owner 수)
 * - POST    : webhook 등록 — body { domain: 'https://firebat.co.kr' }
 * - DELETE  : webhook 해제 + secret 정리
 *
 * 텔레그램 Bot API 가 호출하는 webhook 자체는 /api/telegram/webhook (인증 X — secret token 검증).
 */

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const status = await getCore().getTelegramWebhookStatus();
  return NextResponse.json({ success: true, ...status });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.domain !== 'string') {
    return NextResponse.json({ success: false, error: 'domain 필요 (https://...)' }, { status: 400 });
  }
  const result = await getCore().setupTelegramWebhook(body.domain.trim());
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true, webhookUrl: result.webhookUrl });
}

export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const result = await getCore().removeTelegramWebhook();
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true });
}

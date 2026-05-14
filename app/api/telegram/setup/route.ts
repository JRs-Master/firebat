import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getTelegramWebhookStatus, setupTelegramWebhook, removeTelegramWebhook } from '../../../../lib/api-gen/telegram';

/**
 * 텔레그램 양방향 봇 webhook 등록·해제·상태 조회 — 어드민 전용.
 *
 * - GET     : 현재 webhook 상태 (활성 / URL / owner 수)
 * - POST    : webhook 등록 — body { domain: 'https://your-domain.com' }
 * - DELETE  : webhook 해제 + secret 정리
 *
 * 텔레그램 Bot API 가 호출하는 webhook 자체는 /api/telegram/webhook (인증 X — secret token 검증).
 */

export const GET = withAuth(async () => {
  const res = await getTelegramWebhookStatus();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  const status = (res.data as Record<string, unknown>) ?? {};
  return NextResponse.json({ success: true, ...status });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.domain !== 'string') {
    return NextResponse.json({ success: false, error: 'domain 필요 (https://...)' }, { status: 400 });
  }
  const res = await setupTelegramWebhook({ value: body.domain.trim() });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 400 });
  }
  const inner = (res.data as { success?: boolean; error?: string; webhookUrl?: string }) ?? {};
  if (inner.success === false) {
    return NextResponse.json({ success: false, error: inner.error }, { status: 400 });
  }
  return NextResponse.json({ success: true, webhookUrl: inner.webhookUrl });
});

export const DELETE = withAuth(async () => {
  const res = await removeTelegramWebhook();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 400 });
  }
  const inner = (res.data as { success?: boolean; error?: string }) ?? {};
  if (inner.success === false) {
    return NextResponse.json({ success: false, error: inner.error }, { status: 400 });
  }
  return NextResponse.json({ success: true });
});

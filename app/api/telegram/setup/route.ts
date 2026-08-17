import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { run } from '../../../../lib/api-gen/module';

/**
 * 텔레그램 양방향 봇 webhook 등록·해제·상태 조회 — 어드민 전용.
 *
 * 벤더 API 를 아는 쪽은 telegram 모듈 자신이다 (set-webhook / remove-webhook / webhook-info
 * 액션). 이 라우트는 그 액션을 부르는 admin 어댑터일 뿐 — 옛 TelegramService gRPC 는 은퇴했다.
 *
 * - GET     : webhook-info
 * - POST    : set-webhook — body { domain: 'https://your-domain.com' } → /api/hooks/telegram 등록
 * - DELETE  : remove-webhook
 *
 * 텔레그램이 호출하는 수신부 자체는 /api/hooks/telegram (인증 X — secret token 검증).
 */

async function runTelegram(input: Record<string, unknown>) {
  const res = await run({ module: 'telegram', dataJson: JSON.stringify(input) });
  if (!res.ok) return { ok: false as const, error: res.message };
  const out = res.data as { success: boolean; dataJson?: string; error?: string };
  if (!out.success) return { ok: false as const, error: out.error || 'module refused' };
  let data: unknown = null;
  try { data = out.dataJson ? JSON.parse(out.dataJson) : null; } catch { /* module data stays null */ }
  return { ok: true as const, data };
}

export const GET = withAuth(async () => {
  const r = await runTelegram({ action: 'webhook-info' });
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 500 });
  return NextResponse.json({ success: true, ...(r.data as Record<string, unknown> ?? {}) });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.domain !== 'string') {
    return NextResponse.json({ success: false, error: 'domain 필요 (https://...)' }, { status: 400 });
  }
  const domain = body.domain.trim().replace(/\/+$/, '');
  const url = domain.includes('/api/hooks/') ? domain : `${domain}/api/hooks/telegram`;
  const r = await runTelegram({ action: 'set-webhook', url });
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
  return NextResponse.json({ success: true, webhookUrl: url });
});

export const DELETE = withAuth(async () => {
  const r = await runTelegram({ action: 'remove-webhook' });
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 });
  return NextResponse.json({ success: true });
});

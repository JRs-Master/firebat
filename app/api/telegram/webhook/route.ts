import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/**
 * POST /api/telegram/webhook — 텔레그램 Bot API 가 호출하는 진입점.
 *
 * 흐름:
 *   1. X-Telegram-Bot-Api-Secret-Token 헤더 검증 (Vault 의 webhook secret 과 비교).
 *      → 인증 없이 호출 시 즉시 401. spoofing 방어.
 *   2. body.message.from.id 가 TELEGRAM_OWNER_IDS whitelist 안에 있는지 확인.
 *      → 외부인은 403, 메시지 무시. 자동매매 매수까지 가능한 권한이라 owner 만 허용.
 *   3. text 가 비어있으면 (이미지·스티커·투표 등) 무시.
 *   4. core.processTelegramMessage 로 위임 — AI 호출 + sysmod_telegram 응답.
 *   5. 텔레그램에 200 응답 — 처리 완료 신호 (실패해도 200, retry 폭탄 방어).
 *
 * 인증: 텔레그램 secret token 만 (admin 인증 X — 텔레그램 본체가 호출).
 *       owner whitelist 가 실질 권한 검증.
 */
export async function POST(req: NextRequest) {
  const core = getCore();

  // 1. Secret token 검증
  const expectedSecret = core.getTelegramWebhookSecret();
  const incomingSecret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: 'Invalid secret token' }, { status: 401 });
  }

  // 2. body parse
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const message = body?.message;
  if (!message) {
    // edited_message / channel_post 등 다른 update — 단순 무시 + 200 응답
    return NextResponse.json({ ok: true });
  }

  // 3. owner whitelist
  const fromUserId = message.from?.id;
  const chatId = message.chat?.id;
  if (!fromUserId || !chatId) {
    return NextResponse.json({ ok: true }); // 비정상 형태 무시
  }
  if (!core.isTelegramOwner(fromUserId)) {
    // 외부인 — 무시 (응답 X). 텔레그램은 200 받아야 webhook 정상.
    return NextResponse.json({ ok: true });
  }

  // 4. text 메시지만 처리 (이미지·스티커·투표 등 v1.x 후속)
  const text = (message.text || '').trim();
  if (!text) {
    return NextResponse.json({ ok: true });
  }

  // 5. AI 처리 — 응답은 sysmod_telegram 이 같은 chat 으로 송신.
  //    텔레그램에 빨리 200 응답해야 retry 안 일어남 → 처리는 비동기 fire-and-forget.
  //    실패는 logger 에 기록 (사용자 알림은 X — 무한 응답 루프 방지).
  core.processTelegramMessage(text, chatId).catch((err: any) => {
    console.error('[Telegram webhook] processMessage 실패:', err?.message || err);
  });

  return NextResponse.json({ ok: true });
}

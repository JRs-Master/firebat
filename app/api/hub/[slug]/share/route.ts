import { NextRequest, NextResponse } from 'next/server';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { createShare } from '../../../../../lib/api-gen/conversation';
import { getBaseUrl } from '../../../../../lib/base-url';

/**
 * POST /api/hub/[slug]/share — 익명 hub 방문자의 자기 대화 공유.
 *
 * 옛 /api/share 는 withAuth (admin auth 필수) → hub anonymous 접근 차단.
 * 본 endpoint = X-Api-Token + X-Session-Id 검증 후 옛 createShare RPC 호출.
 *
 * Body: { type: 'turn' | 'full', conversationId?, title?, messages, dedupKey? }
 * → { success: true, slug, url, expiresAt }
 *
 * owner = `hub:<slug>:<sessionId-short>` — 자기 세션 영역 share 만 모이게 (admin share 영역 분리).
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';

  if (!apiToken) return NextResponse.json({ success: false, error: 'X-Api-Token 헤더가 필요합니다.' }, { status: 401 });
  if (!sessionId) return NextResponse.json({ success: false, error: 'X-Session-Id 헤더가 필요합니다.' }, { status: 400 });

  // 인증
  const authRes = await authenticate({ slug, apiToken, origin, selfHost });
  if (!authRes.ok) {
    const msg = authRes.message ?? '인증 실패';
    if (msg.includes('UNAUTHORIZED_ORIGIN:')) {
      return NextResponse.json({ success: false, error: '허용되지 않은 도메인입니다.' }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 401 });
  }
  const instance = authRes.data?.instance;
  if (!instance) return NextResponse.json({ success: false, error: 'instance 조회 실패' }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const type = body.type === 'turn' ? 'turn' : 'full';
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
  const dedupKey = typeof body.dedupKey === 'string' && body.dedupKey ? body.dedupKey : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return NextResponse.json({ success: false, error: '공유할 메시지가 없습니다' }, { status: 400 });
  }

  const title: string = typeof body.title === 'string' && body.title
    ? body.title
    : (type === 'turn' ? '공유된 응답' : '공유된 대화');

  // owner 영역 = hub:<slug>:<sessionId 앞 8자>. 옛 admin share 영역과 자연 분리.
  const ownerTag = `hub:${slug}:${sessionId.slice(0, 8)}`;

  const res = await createShare({
    shareType: type,
    title,
    messagesJson: JSON.stringify(messages),
    owner: ownerTag,
    sourceConvId: conversationId,
    dedupKey,
  });
  if (!res.ok || !res.data || !res.data.slug) {
    return NextResponse.json(
      { success: false, error: res.ok ? '공유 생성 실패' : res.message },
      { status: 500 },
    );
  }
  const base = getBaseUrl(req);
  return NextResponse.json({
    success: true,
    slug: res.data.slug,
    url: `${base}/share/${res.data.slug}`,
    expiresAt: typeof res.data.expiresAt === 'bigint' ? Number(res.data.expiresAt) : res.data.expiresAt,
    reused: res.data.reused === true,
  });
}

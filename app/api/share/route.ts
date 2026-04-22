import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { getBaseUrl } from '../../../lib/base-url';

/**
 * POST /api/share — 공유 링크 생성 (인증 필수, admin 만)
 *
 * body: {
 *   type: 'turn' | 'full',
 *   conversationId: string,     // 원본 대화 ID (참조용)
 *   title?: string,              // 공유 제목 (미지정 시 첫 user 메시지 기반 자동)
 *   messages: unknown[],         // 공유 시점 snapshot
 * }
 * → { success: true, slug, url, expiresAt }
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const body = await req.json();
    const type = body.type === 'turn' ? 'turn' : 'full';
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined;
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0) {
      return NextResponse.json({ success: false, error: '공유할 메시지가 없습니다' }, { status: 400 });
    }

    // title 자동 생성 — 첫 user 메시지 28자 + …
    let title: string = typeof body.title === 'string' ? body.title : '';
    if (!title) {
      const firstUser = messages.find((m: unknown) => m && typeof m === 'object' && (m as Record<string, unknown>).role === 'user');
      const content = firstUser && typeof (firstUser as Record<string, unknown>).content === 'string'
        ? (firstUser as Record<string, unknown>).content as string
        : '';
      title = content ? content.slice(0, 28) + (content.length > 28 ? '…' : '') : (type === 'turn' ? '공유된 응답' : '공유된 대화');
    }

    const core = getCore();
    const res = await core.createShare({
      type,
      title,
      messages,
      owner: auth.role,
      sourceConvId: conversationId,
    });
    if (!res.success || !res.data) {
      return NextResponse.json({ success: false, error: res.error || '공유 생성 실패' }, { status: 500 });
    }
    const base = getBaseUrl(req);
    return NextResponse.json({
      success: true,
      slug: res.data.slug,
      url: `${base}/share/${res.data.slug}`,
      expiresAt: res.data.expiresAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

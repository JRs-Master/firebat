import { NextRequest, NextResponse } from 'next/server';
import { listMedia, removeMedia } from '../../../../../lib/api-gen/media';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/media — 익명 hub 방문자의 갤러리 dispatcher.
 *
 * GET ?limit=50&offset=0&search=...  — hub-scoped 미디어 목록 (user/hub/<id>/media/)
 * DELETE ?slug=...                    — hub-scoped 미디어 삭제 (소유 확인 후)
 *
 * 인증: X-Api-Token + X-Session-Id. hub_owner 자동 instance.id 강제.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

async function authHub(req: NextRequest, slug: string): Promise<{ ok: true; instanceId: string } | { ok: false; status: number; error: string }> {
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  if (!apiToken) return { ok: false, status: 401, error: 'X-Api-Token 헤더가 필요합니다.' };
  if (!sessionId) return { ok: false, status: 400, error: 'X-Session-Id 헤더가 필요합니다.' };
  const res = await authenticate({ slug, apiToken, origin, selfHost });
  if (!res.ok) {
    const msg = res.message ?? '인증 실패';
    if (msg.includes('UNAUTHORIZED_ORIGIN:')) return { ok: false, status: 403, error: '허용되지 않은 도메인입니다.' };
    return { ok: false, status: 401, error: msg };
  }
  if (!res.data?.instance) return { ok: false, status: 500, error: 'instance 조회 실패' };
  return { ok: true, instanceId: res.data.instance.id };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const url = req.nextUrl;
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const search = url.searchParams.get('search') || undefined;

  try {
    const result = await listMedia({ optsJson: JSON.stringify({ limit, offset, search, hubOwner: auth.instanceId }) });
    if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 500 });
    return NextResponse.json({ success: true, items: result.data?.items ?? [], total: result.data?.total ?? 0 });
  } catch (err) {
    logger.debug('hub-media', 'list 실패', { error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  const mediaSlug = req.nextUrl.searchParams.get('slug');
  if (!mediaSlug) return NextResponse.json({ success: false, error: 'slug 파라미터가 필요합니다.' }, { status: 400 });
  // hub 소유 확인 — list 호출해 본 hub 안 자료인지 검증. 정공 (admin endpoint 우회 차단).
  const list = await listMedia({ optsJson: JSON.stringify({ hubOwner: auth.instanceId, limit: 200, offset: 0 }) });
  if (!list.ok) return NextResponse.json({ success: false, error: list.message }, { status: 500 });
  const ownsMedia = (list.data?.items ?? []).some(item => item.slug === mediaSlug);
  if (!ownsMedia) return NextResponse.json({ success: false, error: '이 자료에 접근할 권한이 없습니다.' }, { status: 403 });
  const result = await removeMedia({ slug: mediaSlug });
  if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { listMedia, removeMedia, regenerate as regenerateMedia } from '../../../../../lib/api-gen/media';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/media — 익명 hub 방문자의 갤러리 dispatcher.
 *
 * GET ?limit=50&offset=0&search=...  — hub-scoped 미디어 목록 (user/hub/<id>/media/)
 * DELETE ?slug=...                    — hub-scoped 미디어 삭제 (소유 확인 후)
 * POST   op='regenerate'             — hub-scoped 미디어 재생성 (소유 확인 후, 결과도 같은 scope)
 *
 * 인증: X-Api-Token + X-Session-Id. hub_owner = `<instance_id>:<session_id>` 강제.
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

  // visitor 별 격리 — hubOwner = `<instance_id>:<session_id>`.
  const sessionId = req.headers.get('x-session-id') ?? '';
  const scopeId = `${auth.instanceId}:${sessionId}`;

  try {
    const result = await listMedia({ optsJson: JSON.stringify({ limit, offset, search, hubOwner: scopeId }) });
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
  // visitor 별 격리 — hubOwner = `<instance_id>:<session_id>` 매칭만 통과.
  const sessionId = req.headers.get('x-session-id') ?? '';
  const scopeId = `${auth.instanceId}:${sessionId}`;
  // owner scoping = Rust core(MediaService.remove → remove_owned)가 강제 — 미소유 시 거부. 프론트 가드 폐기.
  const result = await removeMedia({ slug: mediaSlug, hubOwner: scopeId } as any);
  if (!result.ok) return NextResponse.json({ success: false, error: result.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  // visitor 별 격리 — hubOwner = `<instance_id>:<session_id>` 매칭만 통과.
  const sessionId = req.headers.get('x-session-id') ?? '';
  const scopeId = `${auth.instanceId}:${sessionId}`;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'regenerate': {
        const mediaSlug = String(body.slug ?? '');
        if (!mediaSlug) return NextResponse.json({ success: false, error: 'slug 가 필요합니다.' }, { status: 400 });
        // owner scoping = Rust core(MediaService.regenerate → regenerate_image_owned)가 강제 — 미소유 시 거부.
        const res = await regenerateMedia({ slug: mediaSlug, hubOwner: scopeId } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ success: false, error: `지원되지 않는 op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    logger.debug('hub-media', 'op 실패', { op, error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

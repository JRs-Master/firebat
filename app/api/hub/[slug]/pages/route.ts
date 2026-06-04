import { NextRequest, NextResponse } from 'next/server';
import { listPages, deletePage } from '../../../../../lib/api-gen/page';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/pages — 익명 hub 방문자가 자기 hub-scoped page list / delete.
 *
 * 자기 hub 의 page (project = `hub:<instance.id>`) 만 노출. admin / 다른 hub page 0.
 *
 * GET    — list (visitor 가 chat 안 save_page 도구로 만든 page 들)
 * DELETE — delete (자기 hub 자료만, project 영역 가드)
 *
 * 인증: X-Api-Token + X-Session-Id.
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
  const projectKey = `hub:${auth.instanceId}`;

  try {
    const res = await listPages();
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    const all = (res.data ?? []) as Array<{ slug: string; title: string; status: string; updatedAt: bigint | number | string; project?: string | null; visibility?: string }>;
    const pages = all
      .filter(p => p.project === projectKey)
      .map(p => ({ ...p, updatedAt: typeof p.updatedAt === 'bigint' ? Number(p.updatedAt) : p.updatedAt }));
    return NextResponse.json({ success: true, pages });
  } catch (err) {
    logger.debug('hub-pages', 'list 실패', { error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  const projectKey = `hub:${auth.instanceId}`;

  const pageSlug = req.nextUrl.searchParams.get('slug');
  if (!pageSlug) return NextResponse.json({ success: false, error: 'slug 파라미터가 필요합니다.' }, { status: 400 });

  try {
    // project scoping 은 Rust core(PageService.delete)가 강제 — project 불일치 시 권한 거부. 프론트 가드 폐기.
    const del = await deletePage({ slug: pageSlug, project: projectKey } as any);
    if (!del.ok) return NextResponse.json({ success: false, error: del.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.debug('hub-pages', 'delete 실패', { error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
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

import { NextRequest, NextResponse } from 'next/server';
import { listPages, deletePage, setVisibility as setPageVisibility, rename as renamePage } from '../../../../../lib/api-gen/page';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/pages — 익명 hub 방문자가 자기 hub-scoped page list / delete / visibility / rename.
 *
 * 자기 hub 의 page (project = `hub:<instance.id>`) 만 노출. admin / 다른 hub page 0.
 *
 * GET    — list (visitor 가 chat 안 save_page 도구로 만든 page 들)
 * DELETE — delete (자기 hub 자료만, project 영역 가드)
 * POST   — op='visibility' (가시성 변경) / op='rename' (slug 변경). 둘 다 project 영역 가드.
 *
 * owner scoping = Rust core(PageService) 가 project 불일치 시 권한 거부. 프론트 가드 폐기.
 * 인증: X-Api-Token + X-Session-Id.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

async function authHub(
  req: NextRequest,
  slug: string,
): Promise<{ ok: true; instanceId: string } | { ok: false; response: NextResponse }> {
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return { ok: false, response: principal };
  return { ok: true, instanceId: principal.hubInstance!.id };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;
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
  if (!auth.ok) return auth.response;
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

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;
  const projectKey = `hub:${auth.instanceId}`;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'visibility': {
        const pageSlug = String(body.slug ?? '');
        const visibility = String(body.visibility ?? '');
        if (!pageSlug) return NextResponse.json({ success: false, error: 'slug 필수' }, { status: 400 });
        if (!['public', 'password', 'private'].includes(visibility)) {
          return NextResponse.json({ success: false, error: 'visibility 는 public·password·private 중 하나여야 합니다.' }, { status: 400 });
        }
        if (visibility === 'password' && !body.password) {
          return NextResponse.json({ success: false, error: 'password 모드에서는 비밀번호가 필요합니다.' }, { status: 400 });
        }
        // project scoping 은 Rust core(PageService.setVisibility)가 강제 — project 불일치 시 권한 거부.
        const res = await setPageVisibility({ slug: pageSlug, visibility, password: body.password ?? undefined, project: projectKey } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      case 'rename': {
        const oldSlug = String(body.slug ?? '');
        const newSlug = String(body.newSlug ?? '');
        if (!oldSlug || !newSlug) return NextResponse.json({ success: false, error: 'slug 와 newSlug 가 필요합니다.' }, { status: 400 });
        // project scoping 은 Rust core(PageService.rename)가 강제 — project 불일치 시 권한 거부.
        const res = await renamePage({ oldSlug, newSlug, setRedirect: body.setRedirect ?? false, project: projectKey } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ success: false, error: `지원되지 않는 op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    logger.debug('hub-pages', 'op 실패', { op, error: err });
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

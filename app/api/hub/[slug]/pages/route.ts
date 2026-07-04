import { NextRequest, NextResponse } from 'next/server';
import { listPages, deletePage, setVisibility as setPageVisibility, rename as renamePage } from '../../../../../lib/api-gen/page';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/pages — 익명 hub 방문자가 자기 hub-scoped page list / delete / visibility / rename.
 *
 * Page scope는 2층:
 *   - session (`hub:<inst>:<sid>`) — visitor 가 chat 의 save_page 로 만든 자기 페이지(save 쪽이 이
 *     세션 키로 저장, per-session 격리 `f5e43d1`). 목록 노출 + 조작 가능.
 *   - instance (`hub:<inst>`) — 위젯 공유 페이지(admin 이 demo 용으로 노출, 예: 계산기).
 *     목록 노출만, 조작은 불가(read-only — 익명 세션이 공유 페이지를 지우면 안 됨).
 * 옛 GET 이 instance 키만 필터해 "hub 에서 만든 페이지가 목록에 영영 안 뜨고, 공유 페이지는
 * 아무 세션이나 지울 수 있던" 역전을 이 2층으로 정정.
 *
 * GET    — list (자기 세션 페이지 ∪ 인스턴스 공유 페이지)
 * DELETE — delete (자기 세션 페이지만)
 * POST   — op='visibility' / op='rename' (자기 세션 페이지만)
 *
 * scope 강제 = Rust core(PageService)가 project 불일치 시 권한 거부. 프론트 가드 폐기.
 * 인증: X-Api-Token + X-Session-Id.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

async function authHub(
  req: NextRequest,
  slug: string,
): Promise<{ ok: true; instanceId: string; owner: string } | { ok: false; response: NextResponse }> {
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return { ok: false, response: principal };
  return { ok: true, instanceId: principal.hubInstance!.id, owner: principal.owner };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;
  const sessionKey = auth.owner;                    // hub:<inst>:<sid> — own pages
  const instanceKey = `hub:${auth.instanceId}`;     // hub:<inst> — widget-shared pages

  try {
    const res = await listPages();
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    const all = (res.data ?? []) as Array<{ slug: string; title: string; status: string; updatedAt: bigint | number | string; project?: string | null; visibility?: string }>;
    const pages = all
      .filter(p => p.project === sessionKey || p.project === instanceKey)
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
  // Mutations act on the visitor's OWN session pages only — instance-shared pages are read-only.
  const projectKey = auth.owner;

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
  // Mutations act on the visitor's OWN session pages only — instance-shared pages are read-only.
  const projectKey = auth.owner;

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

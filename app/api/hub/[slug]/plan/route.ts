import { NextRequest, NextResponse } from 'next/server';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { getPending, consumePending, rejectPending } from '../../../../../lib/api-gen/ai';
import { savePage, deletePage } from '../../../../../lib/api-gen/page';
import { writeFile, deleteFile } from '../../../../../lib/api-gen/storage';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/plan — 익명 hub 방문자의 승인 카드 commit/reject (admin /api/plan/commit 의 hub 등가).
 *
 * 인증 = X-Api-Token + X-Session-Id (fs route 와 동일). 비즈니스 보안:
 *  - 모든 pending 은 hubScope(`<instance_id>:<session_id>`) 검증 — A 가 B 의 pending 을 commit/reject 못 함.
 *  - 실행은 visitor 의 owner scope 로만 — savePage/deletePage 에 project=`hub:<id>` 전달,
 *    write/delete_file 은 path 가 `user/hub/<id>/` 안인지 검증(isHubScopedPath). admin scope 누수 차단.
 *
 * body: `{ op: 'commit' | 'reject', planId, action?, runAt? }`
 *  (admin commit 의 schedule_task action/runAt 은 hub 미허용이라 미사용 — 방어적으로 거부)
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

async function authHub(
  req: NextRequest,
  slug: string,
): Promise<{ ok: true; instanceId: string; scope: string } | { ok: false; response: NextResponse }> {
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return { ok: false, response: principal };
  return {
    ok: true,
    instanceId: principal.hubInstance!.id,
    scope: `${principal.hubInstance!.id}:${principal.sessionId}`,
  };
}

/** path 가 `user/hub/<instance_id>/` prefix 안인지 — fs route 와 동일 (path traversal + 타 hub 차단). */
function isHubScopedPath(path: string, instanceId: string): boolean {
  const prefix = `user/hub/${instanceId}/`;
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (normalized.includes('..')) return false;
  return normalized === `user/hub/${instanceId}` || normalized.startsWith(prefix);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;

  let body: { op?: string; planId?: string } = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'JSON body 가 필요합니다.' }, { status: 400 }); }

  const op = String(body.op ?? '');
  const planId = String(body.planId ?? '');
  if (!planId) return NextResponse.json({ success: false, error: 'planId 가 필요합니다.' }, { status: 400 });

  // pending 조회 + cross-tenant 가드 — 이 방문자(scope) 소유의 pending 만 commit/reject 가능.
  const pendingRes = await getPending({ planId });
  if (!pendingRes.ok || !pendingRes.data) {
    return NextResponse.json({ success: false, error: '승인 항목을 찾을 수 없거나 만료되었습니다.' }, { status: 404 });
  }
  const pending = pendingRes.data as { args?: Record<string, unknown> & { name?: string }; hubScope?: string };
  if (!pending.hubScope || pending.hubScope !== auth.scope) {
    // 미존재처럼 404 (존재 여부 노출 방지) — 다른 hub/세션의 pending.
    return NextResponse.json({ success: false, error: '승인 항목을 찾을 수 없거나 만료되었습니다.' }, { status: 404 });
  }

  try {
    if (op === 'reject') {
      await rejectPending({ planId });
      return NextResponse.json({ success: true });
    }
    if (op !== 'commit') {
      return NextResponse.json({ success: false, error: `지원되지 않는 op: ${op}` }, { status: 400 });
    }

    const args = (pending.args ?? {}) as Record<string, unknown> & { name?: string };
    const project = `hub:${auth.instanceId}`;
    let result: { success: boolean; data?: unknown; error?: string };

    switch (args.name) {
      case 'save_page': {
        const slugArg = String(args.slug ?? '');
        const spec = args.spec as Record<string, unknown> | string;
        const specStr = typeof spec === 'string' ? spec : JSON.stringify(spec);
        const r = await savePage({ slug: slugArg, spec: specStr, project });
        result = r.ok
          ? { success: true, data: { slug: r.data?.slug ?? slugArg, url: `/${r.data?.slug ?? slugArg}` } }
          : { success: false, error: r.message };
        break;
      }
      case 'delete_page': {
        const r = await deletePage({ slug: String(args.slug ?? ''), project });
        result = r.ok ? { success: true } : { success: false, error: r.message };
        break;
      }
      case 'write_file': {
        const path = String(args.path ?? '');
        if (!isHubScopedPath(path, auth.instanceId)) {
          return NextResponse.json({ success: false, error: '이 경로에 쓸 권한이 없습니다.' }, { status: 403 });
        }
        const r = await writeFile({ path, content: String(args.content ?? '') });
        result = r.ok ? { success: true } : { success: false, error: r.message };
        break;
      }
      case 'delete_file': {
        const path = String(args.path ?? '');
        if (!isHubScopedPath(path, auth.instanceId)) {
          return NextResponse.json({ success: false, error: '이 경로를 삭제할 권한이 없습니다.' }, { status: 403 });
        }
        const r = await deleteFile({ path });
        result = r.ok ? { success: true } : { success: false, error: r.message };
        break;
      }
      // schedule_task / cancel_cron_job 은 hub 정책상 미허용 (배경 실행) → pending 자체가 안 생기지만 방어적 거부.
      default:
        return NextResponse.json(
          { success: false, error: `hub 에서 지원하지 않는 작업입니다: ${args.name ?? 'unknown'}` },
          { status: 400 },
        );
    }

    // 성공 시에만 consume (실패 시 재시도 가능).
    if (result.success) await consumePending({ planId });
    return NextResponse.json(result);
  } catch (err) {
    const msg = (err as Error)?.message ?? '서버 오류가 발생했습니다.';
    logger.debug('hub-plan', 'op 실패', { op, planId, error: err });
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

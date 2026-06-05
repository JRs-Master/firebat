import { NextRequest, NextResponse } from 'next/server';
import { scanProjects, setProjectVisibility, deleteProject } from '../../../../../lib/api-gen/project';
import { readFile, writeFile, getFileTree } from '../../../../../lib/api-gen/storage';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/fs — 익명 hub 방문자의 file system + project dispatcher.
 *
 * 인증 = X-Api-Token + X-Session-Id.
 * 모든 file path = `user/hub/<instance.id>/` prefix 강제 (path traversal 가드).
 *
 * ops:
 *  - 'projects' — hub-scoped projects (`user/hub/<id>/modules/*` + project='hub:<id>' page) 목록
 *  - 'tree' — `{ root: 'user/hub/<id>/modules/<module>' }` 파일 트리
 *  - 'read' — `{ path: 'user/hub/<id>/...' }` 파일 본문
 *  - 'write' — `{ path: 'user/hub/<id>/...', content }` 파일 저장
 *  - 'set-project-visibility' — `{ project, visibility, password? }` 자기 hub 프로젝트 가시성
 *  - 'delete-project' — `{ project }` 자기 hub 프로젝트 일괄 삭제
 *
 * project op 의 owner scoping = Rust core(ProjectService)가 hub_id 로 강제 — 미소유 시 거부.
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

/** path 가 `user/hub/<instance_id>/` prefix 안인지 검증 — path traversal + 다른 hub 자료 접근 차단. */
function isHubScopedPath(path: string, instanceId: string): boolean {
  const prefix = `user/hub/${instanceId}/`;
  // normalize — 옛 leading slash / 중복 slash 정리
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (normalized.includes('..')) return false;
  return normalized.startsWith(prefix);
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'projects': {
        const res = await scanProjects({ hubId: auth.instanceId });
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true, projects: res.data ?? [] });
      }
      case 'tree': {
        const root = String(body.root ?? '');
        if (!root) return NextResponse.json({ success: false, error: 'root 필수' }, { status: 400 });
        if (!isHubScopedPath(root + '/', auth.instanceId)) {
          return NextResponse.json({ success: false, error: '이 경로에 접근할 권한이 없습니다.' }, { status: 403 });
        }
        const res = await getFileTree({ path: root });
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true, tree: res.data });
      }
      case 'read': {
        const path = String(body.path ?? '');
        if (!path) return NextResponse.json({ success: false, error: 'path 필수' }, { status: 400 });
        if (!isHubScopedPath(path, auth.instanceId)) {
          return NextResponse.json({ success: false, error: '이 파일에 접근할 권한이 없습니다.' }, { status: 403 });
        }
        const res = await readFile({ path });
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        const data = res.data as { content?: string } | undefined;
        return NextResponse.json({ success: true, content: data?.content });
      }
      case 'write': {
        const path = String(body.path ?? '');
        const content = body.content;
        if (!path || content === undefined) {
          return NextResponse.json({ success: false, error: 'path 와 content 필수' }, { status: 400 });
        }
        if (!isHubScopedPath(path, auth.instanceId)) {
          return NextResponse.json({ success: false, error: '이 파일에 접근할 권한이 없습니다.' }, { status: 403 });
        }
        const res = await writeFile({ path, content });
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      case 'set-project-visibility': {
        const project = String(body.project ?? '');
        const visibility = String(body.visibility ?? '');
        if (!project) return NextResponse.json({ success: false, error: 'project 필수' }, { status: 400 });
        if (!['public', 'password', 'private'].includes(visibility)) {
          return NextResponse.json({ success: false, error: 'visibility 는 public·password·private 중 하나여야 합니다.' }, { status: 400 });
        }
        if (visibility === 'password' && !body.password) {
          return NextResponse.json({ success: false, error: 'password 모드에서는 비밀번호가 필요합니다.' }, { status: 400 });
        }
        // hub scoping = Rust core(ProjectService.setVisibility)가 hub_id 로 강제 — 미소유 시 거부.
        const res = await setProjectVisibility({ project, visibility, password: body.password ?? undefined, hubId: auth.instanceId } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      case 'delete-project': {
        const project = String(body.project ?? '');
        if (!project) return NextResponse.json({ success: false, error: 'project 필수' }, { status: 400 });
        // hub scoping = Rust core(ProjectService.delete → delete_owned)가 hub_id 로 강제 — 미소유 시 거부.
        const res = await deleteProject({ project, hubId: auth.instanceId } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ success: false, error: `지원되지 않는 op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    logger.debug('hub-fs', 'op 실패', { op, error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
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

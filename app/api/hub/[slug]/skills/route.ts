import { NextRequest, NextResponse } from 'next/server';
import {
  listFiles,
  readFile,
  saveFile,
  deleteFile,
} from '../../../../../lib/api-gen/skill';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/skills
 *
 * Anonymous hub visitor's Skills dispatcher. Mirrors admin /api/skills + forces the
 * owner to `<instance.id>:<sessionId>` (per-session, like templates). The sidebar is
 * reused in hub, so skills (a sidebar panel) are managed here per session.
 *
 * Auth: X-Api-Token + X-Session-Id. owner: session-scoped (visitor-supplied owner ignored).
 *
 * ops: list / get / save / delete.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

const KINDS = ['design', 'tool-usage', 'procedure', 'persona', 'policy'];

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';

  if (!apiToken) return jsonResponse(401, { error: 'X-Api-Token 헤더가 필요합니다.' });
  if (!sessionId) return jsonResponse(400, { error: 'X-Session-Id 헤더가 필요합니다.' });

  const authRes = await authenticate({ slug, apiToken, origin, selfHost });
  if (!authRes.ok) {
    const msg = authRes.message ?? '인증 실패';
    if (msg.includes('UNAUTHORIZED_ORIGIN:')) {
      return jsonResponse(403, { error: '허용되지 않은 도메인입니다.' });
    }
    return jsonResponse(401, { error: msg });
  }
  const instance = authRes.data?.instance;
  if (!instance) return jsonResponse(500, { error: 'instance 조회 실패' });
  // 세션 스코프(`hub:<inst>:<sid>`) — 같은 위젯 다른 세션끼리 스킬 격리. skill_file owner_dir 가
  // `hub:` prefix 를 요구(entities·library·AI inject 와 동일 canonical). prefix 빠지면 owner_dir
  // 에러 → list Err → grpc unwrap_or_default → 빈 배열(system 스킬도 안 보임).
  const hubOwner = `hub:${instance.id}:${sessionId}`;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'list': {
        const res = await listFiles({ owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, items: res.data });
      }
      case 'get': {
        const sslug = String(body.slug ?? '');
        if (!sslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await readFile({ slug: sslug, owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, item: res.data });
      }
      case 'save': {
        const sslug = String(body.slug ?? '');
        if (!sslug) return jsonResponse(400, { error: 'slug 필수' });
        const kind = String(body.kind ?? 'procedure');
        if (kind && !KINDS.includes(kind)) {
          return jsonResponse(400, { error: `kind 는 ${KINDS.join('/')} 중 하나` });
        }
        const content = typeof body.content === 'string' ? body.content : '';
        const res = await saveFile({
          slug: sslug,
          name: String(body.name ?? sslug).trim() || sslug,
          kind,
          description: String(body.description ?? ''),
          content,
          owner: hubOwner,
        });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'delete': {
        const sslug = String(body.slug ?? '');
        if (!sslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await deleteFile({ slug: sslug, owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-skills', 'op 실패', { op, error: err });
    return jsonResponse(500, { error: (err as Error)?.message ?? '서버 오류' });
  }
}

function jsonResponse(status: number, body: unknown) {
  return NextResponse.json(body, { status });
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

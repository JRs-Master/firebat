import { NextRequest, NextResponse } from 'next/server';
import { listReferences, getSource } from '../../../../../lib/api-gen/library';
import { libraryOpDispatch } from '../../../../../lib/handlers/library';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/library
 *
 * 익명 hub 방문자의 Library dispatcher. admin /api/library/[op] 와 동등 RPC 매핑 +
 * hub-scoped owner 자동 주입 → 방문자가 admin 자료를 못 보고 자기 hub 자료만 관리.
 *
 * 인증: X-Api-Token + X-Session-Id (sessions route 와 동일 패턴).
 * owner: `hub:<instance.id>` 강제. 방문자가 args.owner 보내도 무시.
 * 권한 가드: 매 reference 조작은 해당 reference.owner 가 본 hub 와 일치할 때만 허용.
 *
 * Body: `{ op: 'list-references' | 'create-reference' | 'delete-reference' |
 *          'list-sources' | 'get-source' | 'delete-source' | 'upload-text-source',
 *          ...args }`
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

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
  // visitor 별 격리 — `hub:<instance_id>:<session_id>` 형태 owner 사용.
  // 같은 hub 안 다른 방문자 자료 노출 0 (privacy 보장).
  const hubOwner = `hub:${instance.id}:${sessionId}`;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  // Reference 권한 가드 — owner 가 본 hub 와 일치할 때만 통과.
  const ensureRefOwnership = async (refId: string): Promise<NextResponse | null> => {
    const list = await listReferences({ owner: hubOwner });
    if (!list.ok) return jsonResponse(500, { error: list.message });
    const found = (list.data ?? []).some(r => r.id === refId);
    if (!found) {
      return jsonResponse(403, { error: '이 reference 에 접근할 권한이 없습니다.' });
    }
    return null;
  };

  // Source 권한 가드 — source.reference 가 본 hub owner 와 일치할 때만.
  const ensureSourceOwnership = async (srcId: string): Promise<NextResponse | null> => {
    const res = await getSource({ id: srcId });
    if (!res.ok || !res.data?.source) {
      return jsonResponse(404, { error: 'source 를 찾을 수 없습니다.' });
    }
    return ensureRefOwnership(res.data.source.referenceId);
  };

  // hub 가 쓸 수 있는 op 만 허용 — reextract/search 등은 가드 없는 노출 차단 위해 미지원.
  const HUB_OPS = new Set([
    'list-references', 'create-reference', 'delete-reference',
    'list-sources', 'get-source', 'delete-source', 'upload-text-source',
  ]);
  if (!HUB_OPS.has(op)) return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });

  try {
    // id-기반 조작은 본 hub owner 의 reference/source 인지 가드 (list/create 는 hubOwner 자동 스코프).
    let guard: NextResponse | null = null;
    switch (op) {
      case 'delete-reference': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        guard = await ensureRefOwnership(id);
        break;
      }
      case 'list-sources':
      case 'upload-text-source': {
        const refId = String(body.referenceId ?? '');
        if (!refId) return jsonResponse(400, { error: 'referenceId 필수' });
        guard = await ensureRefOwnership(refId);
        break;
      }
      case 'get-source':
      case 'delete-source': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        guard = await ensureSourceOwnership(id);
        break;
      }
    }
    if (guard) return guard;

    // op→RPC 매핑은 admin 라우트와 공유 (libraryOpDispatch). owner = hubOwner 강제.
    const result = await libraryOpDispatch(op, body, hubOwner);
    if (!result.ok) return jsonResponse(500, { error: result.message });
    return NextResponse.json({ success: true, data: result.data });
  } catch (err) {
    logger.debug('hub-library', 'op 실패', { op, error: err });
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

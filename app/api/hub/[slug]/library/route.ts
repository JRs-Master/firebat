import { NextRequest, NextResponse } from 'next/server';
import {
  createReference,
  listReferences,
  deleteReference,
  uploadSource,
  listSources,
  getSource,
  deleteSource,
} from '../../../../../lib/api-gen/library';
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
  const hubOwner = `hub:${instance.id}`;

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

  try {
    switch (op) {
      case 'list-references': {
        const res = await listReferences({ owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, data: res.data ?? [] });
      }
      case 'create-reference': {
        const res = await createReference({
          name: String(body.name ?? ''),
          description: String(body.description ?? ''),
          owner: hubOwner,
        });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, data: res.data });
      }
      case 'delete-reference': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const guard = await ensureRefOwnership(id);
        if (guard) return guard;
        const res = await deleteReference({ id });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'list-sources': {
        const refId = String(body.referenceId ?? '');
        if (!refId) return jsonResponse(400, { error: 'referenceId 필수' });
        const guard = await ensureRefOwnership(refId);
        if (guard) return guard;
        const res = await listSources({ referenceId: refId });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, data: res.data ?? [] });
      }
      case 'get-source': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const guard = await ensureSourceOwnership(id);
        if (guard) return guard;
        const res = await getSource({ id });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, data: res.data });
      }
      case 'delete-source': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const guard = await ensureSourceOwnership(id);
        if (guard) return guard;
        const res = await deleteSource({ id });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'upload-text-source': {
        const refId = String(body.referenceId ?? '');
        if (!refId) return jsonResponse(400, { error: 'referenceId 필수' });
        const guard = await ensureRefOwnership(refId);
        if (guard) return guard;
        const res = await uploadSource({
          referenceId: refId,
          name: String(body.name ?? ''),
          sourceType: 'text',
          inlineText: String(body.inlineText ?? ''),
        });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, data: res.data });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
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

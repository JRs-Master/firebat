import { NextRequest, NextResponse } from 'next/server';
import {
  searchEntities,
  saveEntity,
  getEntity,
  deleteEntity,
  getTimeline,
  saveFact,
  searchFacts,
} from '../../../../../lib/api-gen/entity';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/entities — 익명 hub 방문자의 Recall (entity / fact / timeline) dispatcher.
 *
 * 인증 = X-Api-Token + X-Session-Id. owner 자동 `hub:<instance.id>` 강제.
 * ops: list / search / save / get / delete / timeline / save-fact / search-facts.
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
  // visitor 별 격리 — `hub:<instance_id>:<session_id>` 형태.
  const hubOwner = `hub:${instance.id}:${sessionId}`;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  // entity 의 owner 가 본 hub 와 일치하는지 가드 (id 직접 접근 시). res.data 는 parsed object.
  const ensureEntityOwnership = async (id: number): Promise<NextResponse | null> => {
    const res = await getEntity({ id: BigInt(id) });
    if (!res.ok || !res.data) {
      return jsonResponse(404, { error: 'entity 를 찾을 수 없습니다.' });
    }
    const parsed = res.data as { owner?: string } | null;
    if (parsed?.owner !== hubOwner) {
      return jsonResponse(403, { error: '이 entity 에 접근할 권한이 없습니다.' });
    }
    return null;
  };

  try {
    switch (op) {
      case 'search': {
        const opts = {
          query: body.query ?? '',
          type: body.type ?? undefined,
          limit: body.limit ?? 100,
          owner: hubOwner,
        };
        const res = await searchEntities({ optsJson: JSON.stringify(opts) } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, entities: (res.data as unknown[]) ?? [] });
      }
      case 'save': {
        if (!body.name || !body.type) return jsonResponse(400, { error: 'name + type 필수' });
        const res = await saveEntity({
          name: String(body.name),
          entityType: String(body.type),
          aliases: Array.isArray(body.aliases) ? body.aliases : [],
          metadataJson: body.metadata ? JSON.stringify(body.metadata) : undefined,
          owner: hubOwner,
        } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, id: res.data?.id, created: res.data?.created });
      }
      case 'get': {
        const id = Number(body.id);
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const guard = await ensureEntityOwnership(id);
        if (guard) return guard;
        const res = await getEntity({ id: BigInt(id) });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, entity: res.data ?? null });
      }
      case 'delete': {
        const id = Number(body.id);
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const guard = await ensureEntityOwnership(id);
        if (guard) return guard;
        const res = await deleteEntity({ id: BigInt(id) });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'timeline': {
        const id = Number(body.entityId);
        if (!id) return jsonResponse(400, { error: 'entityId 필수' });
        const guard = await ensureEntityOwnership(id);
        if (guard) return guard;
        const res = await getTimeline({
          entityId: BigInt(id),
          limit: body.limit ? BigInt(body.limit) : BigInt(50),
          owner: hubOwner,
        } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, facts: (res.data as unknown[]) ?? [] });
      }
      case 'save-fact': {
        const eid = Number(body.entityId);
        if (!eid || !body.content) return jsonResponse(400, { error: 'entityId + content 필수' });
        const guard = await ensureEntityOwnership(eid);
        if (guard) return guard;
        const res = await saveFact({
          entityId: BigInt(eid),
          content: String(body.content),
          factType: body.factType ?? undefined,
          occurredAt: body.occurredAt ? BigInt(body.occurredAt) : undefined,
          tags: Array.isArray(body.tags) ? body.tags : [],
        } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, id: res.data?.id, skipped: res.data?.skipped });
      }
      case 'search-facts': {
        const opts = {
          query: body.query ?? '',
          limit: body.limit ?? 100,
          owner: hubOwner,
        };
        const res = await searchFacts({ optsJson: JSON.stringify(opts) } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, facts: (res.data as unknown[]) ?? [] });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-entities', 'op 실패', { op, error: err });
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

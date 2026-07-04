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
import { searchEvents, deleteEvent } from '../../../../../lib/api-gen/episodic';
import { getMemoryStats } from '../../../../../lib/api-gen/consolidation';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
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
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;
  const hubOwner = principal.owner;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  // owner scoping 은 Rust core(EntityService)가 강제한다 — id-op 에 owner=hubOwner 전달 시
  // owner 불일치 entity 는 get=null / delete·update·timeline·save-fact=권한거부. 프론트 가드 폐기.

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
        // 엔티티 = 이름+별칭 정체성. type 은 휴면(선택) — 이름만 필수.
        if (!body.name) return jsonResponse(400, { error: 'name 필수' });
        const res = await saveEntity({
          name: String(body.name),
          entityType: typeof body.type === 'string' ? body.type : '',
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
        const res = await getEntity({ id: BigInt(id), owner: hubOwner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, entity: res.data ?? null });
      }
      case 'delete': {
        const id = Number(body.id);
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await deleteEntity({ id: BigInt(id), owner: hubOwner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'timeline': {
        const id = Number(body.entityId);
        if (!id) return jsonResponse(400, { error: 'entityId 필수' });
        const res = await getTimeline({
          entityId: BigInt(id),
          limit: body.limit ? BigInt(body.limit) : BigInt(50),
          owner: hubOwner,
          includeInactive: true, // tenant UI reviews staged/superseded groups like admin
        } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, facts: (res.data as unknown[]) ?? [] });
      }
      case 'save-fact': {
        const eid = Number(body.entityId);
        if (!eid || !body.content) return jsonResponse(400, { error: 'entityId + content 필수' });
        const res = await saveFact({
          entityId: BigInt(eid),
          content: String(body.content),
          explicit: true, // human-typed via the tenant add-fact form
          factType: body.factType ?? undefined,
          occurredAt: body.occurredAt ? BigInt(body.occurredAt) : undefined,
          tags: Array.isArray(body.tags) ? body.tags : [],
          owner: hubOwner,
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
      case 'events': {
        // Event (episodic) query, owner-scoped. With entityId, events for that entity; otherwise recent events.
        // search_events filters strictly with WHERE e.owner=? (cross-tenant safe).
        const opts = {
          query: body.query ?? '',
          type: body.type ?? undefined,
          entityId: body.entityId ? Number(body.entityId) : undefined,
          limit: body.limit ?? 100,
          owner: hubOwner,
          includeInactive: true, // tenant UI shows staged rows grouped, like admin
        };
        const res = await searchEvents({ optsJson: JSON.stringify(opts) } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, events: (res.data as unknown[]) ?? [] });
      }
      case 'delete-event': {
        const id = Number(body.id);
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        // Pass owner: Rust deletes only when event.owner matches (mismatch = not-found / denied).
        const res = await deleteEvent({ id: BigInt(id), owner: hubOwner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'stats': {
        // Recall stats (entities/facts/events), owner-scoped. Same flat-count shape for admin and hub.
        const res = await getMemoryStats({ owner: hubOwner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, ...(res.data as any) });
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

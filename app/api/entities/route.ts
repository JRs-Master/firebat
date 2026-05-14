/**
 * Entities API — 메모리 시스템 Entity tier (Phase 1).
 *
 * GET /api/entities                        — list / search (query, type, nameLike, limit)
 * POST /api/entities                       — create (name, type, aliases?, metadata?)
 * GET /api/entities/{id}                   — single entity + factCount
 * PATCH /api/entities/{id}                 — update entity
 * DELETE /api/entities/{id}                — delete entity (cascade facts)
 * GET /api/entities/{id}/timeline          — entity 의 fact timeline
 * POST /api/entities/{id}/facts            — fact 추가
 * GET /api/entity-facts                    — fact 횡단 검색 (별도 route)
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchEntities, saveEntity } from '../../../lib/api-gen/entity';
import { withAuth } from '../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req: NextRequest) => {
  const url = new URL(req.url);
  const query = url.searchParams.get('query') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;
  const nameLike = url.searchParams.get('nameLike') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
  const orderBy = (url.searchParams.get('orderBy') as 'lastUpdated' | 'firstSeen' | 'factCount' | 'name') ?? undefined;
  const res = await searchEntities({ optsJson: JSON.stringify({ query, type, nameLike, limit, orderBy }) } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, entities: (res.data as any) ?? [] });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body?.name || !body?.type) return NextResponse.json({ success: false, error: 'name + type 필수' }, { status: 400 });
  const aliases = Array.isArray(body.aliases) ? body.aliases.filter((s: any) => typeof s === 'string') : [];
  const metadataJson = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? JSON.stringify(body.metadata)
    : undefined;
  const res = await saveEntity({
    name: body.name,
    entityType: body.type,
    aliases,
    metadataJson,
  } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, id: res.data?.id, created: res.data?.created });
});

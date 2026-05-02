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
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const url = new URL(req.url);
  const query = url.searchParams.get('query') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;
  const nameLike = url.searchParams.get('nameLike') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
  const orderBy = (url.searchParams.get('orderBy') as 'lastUpdated' | 'firstSeen' | 'factCount' | 'name') ?? undefined;
  const res = await getCore().searchEntities({ query, type, nameLike, limit, orderBy });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, entities: res.data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.name || !body?.type) return NextResponse.json({ success: false, error: 'name + type 필수' }, { status: 400 });
  const res = await getCore().saveEntity({
    name: body.name,
    type: body.type,
    aliases: Array.isArray(body.aliases) ? body.aliases.filter((s: any) => typeof s === 'string') : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : undefined,
  });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, id: res.data?.id, created: res.data?.created });
}

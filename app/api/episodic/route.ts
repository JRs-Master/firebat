/**
 * Episodic API — 메모리 시스템 Episodic tier (Phase 2).
 *
 * /api/events 는 SSE stream 용 — Episodic 메모리 events 는 별도 namespace `episodic` 사용.
 *
 * GET /api/episodic   — search (query/type/who/occurredAfter/occurredBefore/entityId/limit)
 *                       또는 list recent (필터 모두 비어있으면 listRecentEvents)
 * POST /api/episodic  — create (type/title/description/who/context/occurredAt/entityIds/ttlDays)
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
  const who = url.searchParams.get('who') ?? undefined;
  const entityIdRaw = url.searchParams.get('entityId');
  const entityId = entityIdRaw ? parseInt(entityIdRaw, 10) : undefined;
  const occurredAfterRaw = url.searchParams.get('occurredAfter');
  const occurredBeforeRaw = url.searchParams.get('occurredBefore');
  const occurredAfter = occurredAfterRaw ? new Date(occurredAfterRaw).getTime() : undefined;
  const occurredBefore = occurredBeforeRaw ? new Date(occurredBeforeRaw).getTime() : undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 50)) : 50;
  const hasFilter = query || type || who || entityId !== undefined || occurredAfter !== undefined || occurredBefore !== undefined;
  const res = hasFilter
    ? await getCore().searchEvents({
        query, type, who, entityId,
        occurredAfter: Number.isFinite(occurredAfter as number) ? occurredAfter : undefined,
        occurredBefore: Number.isFinite(occurredBefore as number) ? occurredBefore : undefined,
        limit,
      })
    : await getCore().listRecentEvents({ limit });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, events: res.data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.type || !body?.title) return NextResponse.json({ success: false, error: 'type + title 필수' }, { status: 400 });
  let occurredAtMs: number | undefined;
  if (body.occurredAt) {
    const t = new Date(body.occurredAt).getTime();
    if (Number.isFinite(t)) occurredAtMs = t;
  }
  const res = await getCore().saveEvent({
    type: String(body.type),
    title: String(body.title),
    description: typeof body.description === 'string' ? body.description : undefined,
    who: typeof body.who === 'string' ? body.who : undefined,
    context: body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? body.context : undefined,
    occurredAt: occurredAtMs,
    entityIds: Array.isArray(body.entityIds) ? body.entityIds.filter((n: any) => Number.isInteger(n)) : undefined,
    ttlDays: typeof body.ttlDays === 'number' && body.ttlDays > 0 ? body.ttlDays : undefined,
  });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, id: res.data?.id });
}

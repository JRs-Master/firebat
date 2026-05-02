/**
 * GET /api/entities/{id}/timeline — Entity 의 fact timeline.
 *   ?limit=N&orderBy=occurredAt|createdAt
 * POST /api/entities/{id}/timeline — fact 추가.
 *   body: { content, factType?, occurredAt?, tags?, ttlDays? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../../lib/auth-guard';

export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ id: string }> }

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 100)) : 100;
  const orderBy = (url.searchParams.get('orderBy') as 'occurredAt' | 'createdAt') ?? undefined;
  const res = await getCore().getEntityTimeline(id, { limit, orderBy });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, facts: res.data ?? [] });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.content) return NextResponse.json({ success: false, error: 'content 필수' }, { status: 400 });
  let occurredAtMs: number | undefined;
  if (body.occurredAt) {
    const t = new Date(body.occurredAt).getTime();
    if (Number.isFinite(t)) occurredAtMs = t;
  }
  const res = await getCore().saveEntityFact({
    entityId: id,
    content: body.content,
    factType: typeof body.factType === 'string' ? body.factType : undefined,
    occurredAt: occurredAtMs,
    tags: Array.isArray(body.tags) ? body.tags.filter((s: any) => typeof s === 'string') : undefined,
    ttlDays: typeof body.ttlDays === 'number' && body.ttlDays > 0 ? body.ttlDays : undefined,
  });
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, factId: res.data?.id });
}

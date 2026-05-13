/**
 * 단건 event API.
 * GET /api/episodic/{id}    — 조회 (entityIds 포함)
 * PATCH /api/episodic/{id}  — 수정 (entityIds 설정하면 link 전체 교체)
 * DELETE /api/episodic/{id} — 삭제 (cascade event_entities)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ id: string }> }

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const GET = withAuth(async (_req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await getCore().getEvent(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, event: res.data });
});

export const PATCH = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const patch: { type?: string; title?: string; description?: string; who?: string; context?: Record<string, unknown>; occurredAt?: number; entityIds?: number[]; ttlDays?: number } = {};
  if (typeof body?.type === 'string') patch.type = body.type;
  if (typeof body?.title === 'string') patch.title = body.title;
  if (typeof body?.description === 'string') patch.description = body.description;
  if (typeof body?.who === 'string') patch.who = body.who;
  if (body?.context && typeof body.context === 'object' && !Array.isArray(body.context)) patch.context = body.context;
  if (body?.occurredAt) {
    const t = new Date(body.occurredAt).getTime();
    if (Number.isFinite(t)) patch.occurredAt = t;
  }
  if (Array.isArray(body?.entityIds)) patch.entityIds = body.entityIds.filter((n: any) => Number.isInteger(n));
  if (typeof body?.ttlDays === 'number' && body.ttlDays > 0) patch.ttlDays = body.ttlDays;
  const res = await getCore().updateEvent(id, patch);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (_req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await getCore().deleteEvent(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
});

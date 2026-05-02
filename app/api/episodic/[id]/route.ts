/**
 * 단건 event API.
 * GET /api/episodic/{id}    — 조회 (entityIds 포함)
 * PATCH /api/episodic/{id}  — 수정 (entityIds 박으면 link 전체 교체)
 * DELETE /api/episodic/{id} — 삭제 (cascade event_entities)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

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
  const res = await getCore().getEvent(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, event: res.data });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 }); }
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
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await getCore().deleteEvent(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
}

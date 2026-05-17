/**
 * 단건 event API.
 * GET /api/episodic/{id}    — 조회 (entityIds 포함)
 * PATCH /api/episodic/{id}  — 수정 (entityIds 설정하면 link 전체 교체)
 * DELETE /api/episodic/{id} — 삭제 (cascade event_entities)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getEvent, updateEvent, deleteEvent } from '../../../../lib/api-gen/episodic';
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
  const res = await getEvent({ id: BigInt(id) });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, event: res.data });
});

export const PATCH = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const patch: {
    eventType?: string;
    title?: string;
    description?: string;
    who?: string;
    contextJson?: string;
    occurredAt?: bigint;
    entityIdsJson?: string;
    ttlDays?: bigint;
  } = {};
  if (typeof body?.type === 'string') patch.eventType = body.type;
  if (typeof body?.title === 'string') patch.title = body.title;
  if (typeof body?.description === 'string') patch.description = body.description;
  if (typeof body?.who === 'string') patch.who = body.who;
  if (body?.context && typeof body.context === 'object' && !Array.isArray(body.context)) {
    patch.contextJson = JSON.stringify(body.context);
  }
  if (body?.occurredAt) {
    const t = new Date(body.occurredAt).getTime();
    if (Number.isFinite(t)) patch.occurredAt = BigInt(t);
  }
  if (Array.isArray(body?.entityIds)) {
    patch.entityIdsJson = JSON.stringify(body.entityIds.filter((n: any) => Number.isInteger(n)));
  }
  if (typeof body?.ttlDays === 'number' && body.ttlDays > 0) patch.ttlDays = BigInt(body.ttlDays);
  const res = await updateEvent({ id: BigInt(id), ...patch } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (_req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await deleteEvent({ id: BigInt(id) });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

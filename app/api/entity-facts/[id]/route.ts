/**
 * 단건 fact API.
 * GET /api/entity-facts/{id}    — 조회
 * PATCH /api/entity-facts/{id}  — 수정
 * DELETE /api/entity-facts/{id} — 삭제
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
  const res = await getCore().getEntityFact(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, fact: res.data });
});

export const PATCH = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const patch: { content?: string; factType?: string; occurredAt?: number; tags?: string[]; ttlDays?: number } = {};
  if (typeof body?.content === 'string') patch.content = body.content;
  if (typeof body?.factType === 'string') patch.factType = body.factType;
  if (body?.occurredAt) {
    const t = new Date(body.occurredAt).getTime();
    if (Number.isFinite(t)) patch.occurredAt = t;
  }
  if (Array.isArray(body?.tags)) patch.tags = body.tags.filter((s: any) => typeof s === 'string');
  if (typeof body?.ttlDays === 'number' && body.ttlDays > 0) patch.ttlDays = body.ttlDays;
  const res = await getCore().updateEntityFact(id, patch);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (_req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await getCore().deleteEntityFact(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
});

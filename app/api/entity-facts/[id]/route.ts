/**
 * 단건 fact API.
 * GET /api/entity-facts/{id}    — 조회
 * PATCH /api/entity-facts/{id}  — 수정
 * DELETE /api/entity-facts/{id} — 삭제
 */
import { NextRequest, NextResponse } from 'next/server';
import { getEntityFact, updateEntityFact, deleteEntityFact } from '../../../../lib/api-gen/entity';
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
  const res = await getEntityFact({ value: BigInt(id) } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, fact: res.data });
});

export const PATCH = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const patch: { content?: string; factType?: string; occurredAt?: bigint; tagsJson?: string; ttlDays?: bigint } = {};
  if (typeof body?.content === 'string') patch.content = body.content;
  if (typeof body?.factType === 'string') patch.factType = body.factType;
  if (body?.occurredAt) {
    const t = new Date(body.occurredAt).getTime();
    if (Number.isFinite(t)) patch.occurredAt = BigInt(t);
  }
  if (Array.isArray(body?.tags)) patch.tagsJson = JSON.stringify(body.tags.filter((s: any) => typeof s === 'string'));
  if (typeof body?.ttlDays === 'number' && body.ttlDays > 0) patch.ttlDays = BigInt(body.ttlDays);
  const res = await updateEntityFact({ id: BigInt(id), ...patch } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (_req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await deleteEntityFact({ value: BigInt(id) } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

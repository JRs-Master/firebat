/**
 * Entity 단건 API.
 * GET /api/entities/{id}    — 단건 조회 (factCount 포함)
 * PATCH /api/entities/{id}  — 수정
 * DELETE /api/entities/{id} — 삭제 (cascade facts)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getEntity, updateEntity, deleteEntity } from '../../../../lib/api-gen/entity';
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
  const res = await getEntity({ value: BigInt(id) } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, entity: res.data });
});

export const PATCH = withAuth(async (req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const patch: { name?: string; entityType?: string; aliasesJson?: string; metadataJson?: string } = {};
  if (typeof body?.name === 'string') patch.name = body.name;
  if (typeof body?.type === 'string') patch.entityType = body.type;
  if (Array.isArray(body?.aliases)) patch.aliasesJson = JSON.stringify(body.aliases.filter((s: any) => typeof s === 'string'));
  if (body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) patch.metadataJson = JSON.stringify(body.metadata);
  const res = await updateEntity({ id: BigInt(id), ...patch } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (_req: NextRequest, { params }: Ctx) => {
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await deleteEntity({ value: BigInt(id) } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

/**
 * Entity 단건 API.
 * GET /api/entities/{id}    — 단건 조회 (factCount 포함)
 * PATCH /api/entities/{id}  — 수정
 * DELETE /api/entities/{id} — 삭제 (cascade facts)
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
  const res = await getCore().getEntity(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, entity: res.data });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 }); }
  const patch: { name?: string; type?: string; aliases?: string[]; metadata?: Record<string, unknown> } = {};
  if (typeof body?.name === 'string') patch.name = body.name;
  if (typeof body?.type === 'string') patch.type = body.type;
  if (Array.isArray(body?.aliases)) patch.aliases = body.aliases.filter((s: any) => typeof s === 'string');
  if (body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) patch.metadata = body.metadata;
  const res = await getCore().updateEntity(id, patch);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await getCore().deleteEntity(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
}

/**
 * 단건 fact API.
 * GET /api/entity-facts/{id}    — 조회
 * PATCH /api/entity-facts/{id}  — 수정
 * DELETE /api/entity-facts/{id} — 삭제
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
  const res = await getCore().getEntityFact(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  if (!res.data) return NextResponse.json({ success: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ success: true, fact: res.data });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'invalid JSON' }, { status: 400 }); }
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
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const id = parseId((await params).id);
  if (id == null) return NextResponse.json({ success: false, error: 'invalid id' }, { status: 400 });
  const res = await getCore().deleteEntityFact(id);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
}

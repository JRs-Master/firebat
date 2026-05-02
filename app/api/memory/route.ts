/**
 * /api/memory — Firebat AI 자율 메모리 CRUD (어드민 전용).
 *
 * GET — 메모리 파일 목록 (4 카테고리, 각 항목 name·description·content)
 * POST — { category, name, description, content } 저장 (인덱스 자동 갱신)
 * DELETE — ?name=xxx 삭제 (인덱스 자동 갱신)
 *
 * AI 자율 호출 (memory_save / memory_delete 도구) 와 별개로 사용자 직접 편집용.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const res = await core.listMemoryFiles();
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true, items: res.data });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json();
  const { category, name, description, content } = body || {};
  if (!category || !['user', 'feedback', 'project', 'reference'].includes(category)) {
    return NextResponse.json({ success: false, error: 'category 필수 (user/feedback/project/reference)' }, { status: 400 });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ success: false, error: 'name 필수' }, { status: 400 });
  }
  if (!description || typeof description !== 'string') {
    return NextResponse.json({ success: false, error: 'description 필수' }, { status: 400 });
  }
  if (typeof content !== 'string') {
    return NextResponse.json({ success: false, error: 'content 필수' }, { status: 400 });
  }
  const core = getCore();
  const res = await core.saveMemoryFile(category, name.trim(), description, content);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: 'name 필요' }, { status: 400 });
  const core = getCore();
  const res = await core.deleteMemoryFile(name);
  if (!res.success) return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  return NextResponse.json({ success: true });
}

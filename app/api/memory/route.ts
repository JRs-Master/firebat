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
import { listMemoryFiles, saveMemoryFile, deleteMemoryFile } from '../../../lib/api-gen/memory';
import { withAuth } from '../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const res = await listMemoryFiles();
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, items: res.data });
});

export const POST = withAuth(async (req: NextRequest) => {
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
  // MemorySaveFileRequest { name, content } — proxy 는 1·2번째 positional 인자만 사용했음.
  // 옛 호출 형태 `(category, name, description, content)` → `{name: category, content: name.trim()}` 매핑 보존.
  const res = await saveMemoryFile({ name: category, content: name.trim() } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (req: NextRequest) => {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: 'name 필요' }, { status: 400 });
  const res = await deleteMemoryFile({ value: name } as any);
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

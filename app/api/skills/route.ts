/**
 * /api/skills — Skill (케이스 매뉴얼) CRUD (어드민 전용).
 *
 * GET — 스킬 목록 (system∪user 병합, 각 항목 slug·name·kind·description·source·overrides_system)
 *       ?slug=xxx 면 단건(content 포함, user override 우선 → system base 폴백) — Monaco 편집 load.
 * POST — { slug, name?, kind?, description?, content } 저장 (user/skills = override, 인덱스 자동 갱신)
 * DELETE — ?slug=xxx 삭제 (user/skills — system 을 가리던 override 삭제 = system base 복원)
 *
 * AI 자율 호출(skill_* 도구)과 별개로 사용자 직접 편집용. 본문(markdown)은 FileEditor 로 편집.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listFiles, readFile, saveFile, deleteFile } from '../../../lib/api-gen/skill';
import { withAuth } from '../../../lib/with-api-error';

const KINDS = ['design', 'tool-usage', 'procedure', 'persona', 'policy'];

export const GET = withAuth(async (req: NextRequest) => {
  const slug = req.nextUrl.searchParams.get('slug');
  if (slug) {
    const res = await readFile({ slug });
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    return NextResponse.json({ success: true, item: res.data });
  }
  const res = await listFiles({});
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, items: res.data });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const { slug, name, kind, description, content } = body || {};
  if (!slug || typeof slug !== 'string' || !slug.trim()) {
    return NextResponse.json({ success: false, error: 'slug 필수' }, { status: 400 });
  }
  if (kind && !KINDS.includes(kind)) {
    return NextResponse.json({ success: false, error: `kind 는 ${KINDS.join('/')} 중 하나` }, { status: 400 });
  }
  if (typeof content !== 'string') {
    return NextResponse.json({ success: false, error: 'content 필수' }, { status: 400 });
  }
  const res = await saveFile({
    slug: slug.trim(),
    name: (name && String(name).trim()) || slug.trim(),
    kind: kind || 'procedure',
    description: description || '',
    content,
  });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (req: NextRequest) => {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return NextResponse.json({ success: false, error: 'slug 필요' }, { status: 400 });
  const res = await deleteFile({ slug });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true });
});

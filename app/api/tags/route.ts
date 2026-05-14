/**
 * 태그 API (CMS Phase 8a Step A).
 *
 * GET /api/tags — 모든 public+published 페이지의 head.keywords 합집합 + 사용 빈도 + 매칭 slugs.
 * 인증 필수 (어드민 UI 가 사용).
 */
import { NextResponse } from 'next/server';
import { listAllTags } from '../../../lib/api-gen/page';
import { withAuth } from '../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async () => {
  const res = await listAllTags();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, tags: res.data?.tags ?? [] });
});

/**
 * 사이트 내 검색 API.
 *
 * GET /api/search?q=텀&limit=50 — 페이지 title/project/spec 본문 매칭.
 * private 페이지는 DB 레벨에서 제외 (검색 누출 방지). password 페이지는 포함 (클릭 시 게이트).
 * 인증 불필요 (사용자 페이지 접근, 공개 리소스).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(100, parseInt(limitRaw, 10) || 50)) : 50;
  const trimmed = q.trim();
  if (!trimmed || trimmed.length < 2) {
    // 너무 짧은 쿼리 — 빈 결과 (DB 부하 방지).
    return NextResponse.json({ success: true, query: trimmed, results: [] });
  }
  const res = await getCore().searchPages(trimmed, limit);
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error ?? 'search failed' }, { status: 500 });
  }
  return NextResponse.json({ success: true, query: trimmed, results: res.data ?? [] });
}

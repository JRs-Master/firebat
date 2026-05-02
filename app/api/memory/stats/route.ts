/**
 * Memory stats API (Phase 6.2 dashboard).
 *
 * GET /api/memory/stats → entities/facts/events 통계 + byType 분포.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  try {
    const stats = await getCore().getMemoryStats();
    return NextResponse.json({ success: true, ...stats });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? 'stats 조회 실패' }, { status: 500 });
  }
}

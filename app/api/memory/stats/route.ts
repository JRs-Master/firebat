/**
 * Memory stats API (Phase 6.2 dashboard).
 *
 * GET /api/memory/stats → entities/facts/events 통계 + byType 분포.
 */
import { NextResponse } from 'next/server';
import { getMemoryStats } from '../../../../lib/api-gen/consolidation';
import { withAuth } from '../../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async () => {
  const res = await getMemoryStats({}); // no owner = admin scope
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, ...(res.data as any) });
});

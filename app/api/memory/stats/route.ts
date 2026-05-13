/**
 * Memory stats API (Phase 6.2 dashboard).
 *
 * GET /api/memory/stats → entities/facts/events 통계 + byType 분포.
 */
import { NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async () => {
  const stats = await getCore().getMemoryStats();
  return NextResponse.json({ success: true, ...stats });
});

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { rejectPending } from '../../../../lib/api-gen/ai';

/**
 * POST /api/plan/reject?planId=xxx
 * 사용자가 거부한 pending tool을 파기.
 */
export const POST = withAuth(async (req: NextRequest) => {
  const planId = req.nextUrl.searchParams.get('planId') || (await req.json().catch(() => ({}))).planId;
  if (!planId) return NextResponse.json({ success: false, error: 'planId required' }, { status: 400 });

  const res = await rejectPending({ value: planId });
  return NextResponse.json({ success: res.ok && res.data === true });
});

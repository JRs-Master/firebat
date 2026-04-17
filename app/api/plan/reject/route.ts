import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { rejectPending } from '../../../../lib/pending-tools';

/**
 * POST /api/plan/reject?planId=xxx
 * 사용자가 거부한 pending tool을 파기.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const planId = req.nextUrl.searchParams.get('planId') || (await req.json().catch(() => ({}))).planId;
  if (!planId) return NextResponse.json({ success: false, error: 'planId required' }, { status: 400 });

  const ok = rejectPending(planId);
  return NextResponse.json({ success: ok });
}

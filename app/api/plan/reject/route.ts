import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/**
 * POST /api/plan/reject?planId=xxx
 * 사용자가 거부한 pending tool을 파기.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const planId = req.nextUrl.searchParams.get('planId') || (await req.json().catch(() => ({}))).planId;
  if (!planId) return NextResponse.json({ success: false, error: 'planId required' }, { status: 400 });

  const ok = await getCore().rejectPending(planId);
  return NextResponse.json({ success: ok });
}

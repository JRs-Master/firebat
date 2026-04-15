import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

/** GET /api/settings — 시스템 설정 조회 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  return NextResponse.json({
    success: true,
    timezone: core.getTimezone(),
  });
}

/** PATCH /api/settings — 시스템 설정 변경 */
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json();
  const core = getCore();

  if (body.timezone) {
    core.setTimezone(body.timezone);
  }

  return NextResponse.json({ success: true });
}

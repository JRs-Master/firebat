import { NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';

/** GET /api/settings — 시스템 설정 조회 */
export async function GET() {
  const core = getCore();
  return NextResponse.json({
    success: true,
    timezone: core.getTimezone(),
  });
}

/** PATCH /api/settings — 시스템 설정 변경 */
export async function PATCH(req: Request) {
  const body = await req.json();
  const core = getCore();

  if (body.timezone) {
    core.setTimezone(body.timezone);
  }

  return NextResponse.json({ success: true });
}

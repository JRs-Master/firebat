import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';

/** GET /api/settings/modules?name=browser-scrape — 모듈 설정 조회 */
export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });

  const settings = getCore().getModuleSettings(name);
  return NextResponse.json({ success: true, settings });
}

/** PATCH /api/settings/modules — 모듈 설정 저장 */
export async function PATCH(req: NextRequest) {
  const { name, settings } = await req.json();
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });

  const ok = getCore().setModuleSettings(name, settings ?? {});
  return NextResponse.json({ success: ok });
}

import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/** GET /api/settings/modules?name=browser-scrape — 모듈 설정 조회 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });

  const core = getCore();
  const [settings, config] = await Promise.all([
    core.getModuleSettings(name),
    core.getModuleConfig(name),
  ]);
  return NextResponse.json({ success: true, settings, config });
}

/** PATCH /api/settings/modules — 모듈 설정 저장 */
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { name, settings } = await req.json();
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });

  const ok = getCore().setModuleSettings(name, settings ?? {});
  return NextResponse.json({ success: ok });
}

/** POST /api/settings/modules — 모듈 활성화/비활성화 토글 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { name, enabled } = await req.json();
  if (!name || typeof enabled !== 'boolean') {
    return NextResponse.json({ success: false, error: 'name(string), enabled(boolean) 필요' }, { status: 400 });
  }

  const ok = getCore().setModuleEnabled(name, enabled);
  return NextResponse.json({ success: ok, enabled });
}

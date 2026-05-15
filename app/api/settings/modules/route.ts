import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getModuleSettings, getModuleConfig, setModuleSettings, setModuleEnabled } from '../../../../lib/api-gen/module';

/** GET /api/settings/modules?name=browser-scrape — 모듈 설정 조회 */
export const GET = withAuth(async (req: NextRequest) => {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });

  const [settingsRes, configRes] = await Promise.all([
    getModuleSettings({ name }),
    getModuleConfig({ name }),
  ]);
  return NextResponse.json({
    success: true,
    settings: settingsRes.ok ? settingsRes.data : null,
    config: configRes.ok ? configRes.data : null,
  });
});

/** PATCH /api/settings/modules — 모듈 설정 저장 */
export const PATCH = withAuth(async (req: NextRequest) => {
  const { name, settings } = await req.json();
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });

  const res = await setModuleSettings({ name, settingsJson: JSON.stringify(settings ?? {}) });
  return NextResponse.json({ success: res.ok });
});

/** POST /api/settings/modules — 모듈 활성화/비활성화 토글 */
export const POST = withAuth(async (req: NextRequest) => {
  const { name, enabled } = await req.json();
  if (!name || typeof enabled !== 'boolean') {
    return NextResponse.json({ success: false, error: 'name(string), enabled(boolean) 필요' }, { status: 400 });
  }

  const res = await setModuleEnabled({ name, enabled });
  return NextResponse.json({ success: res.ok, enabled });
});

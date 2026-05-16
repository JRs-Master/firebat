import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getModuleSettings, getModuleConfig, getModuleLang, setModuleSettings, setModuleEnabled } from '../../../../lib/api-gen/module';

/** GET /api/settings/modules?name=browser-scrape&lang=ko — 모듈 설정 + config + lang i18n 동시 조회.
 *  2026-05-16: lang/{lang}.json 분리 패턴 도입 — config.settings_fields[].i18n inline 영역 폐기,
 *  settings.{field_key}.{label/description/...} 의 separate file lookup. */
export const GET = withAuth(async (req: NextRequest) => {
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ success: false, error: '모듈 이름 필요' }, { status: 400 });
  // lang 안전 — 'ko' / 'en' 만 허용. 미지정 시 Rust 가 'en' fallback.
  const langParam = req.nextUrl.searchParams.get('lang') ?? '';
  const lang = langParam === 'ko' || langParam === 'en' ? langParam : 'en';

  const [settingsRes, configRes, langRes] = await Promise.all([
    getModuleSettings({ name }),
    getModuleConfig({ name }),
    getModuleLang({ name, lang }),
  ]);
  return NextResponse.json({
    success: true,
    settings: settingsRes.ok ? settingsRes.data : null,
    config: configRes.ok ? configRes.data : null,
    lang: langRes.ok ? langRes.data : null,
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

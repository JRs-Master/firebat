import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';

/** GET /api/capabilities — capability 목록 조회 (각 capability별 provider 수 포함) */
export async function GET() {
  const core = getCore();
  const list = await core.listCapabilitiesWithProviders();
  return NextResponse.json({ success: true, capabilities: list });
}

/** GET /api/capabilities?id=web-scrape — 특정 capability의 provider 목록 + 설정 */
export async function POST(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ success: false, error: 'capability id 필요' }, { status: 400 });

  const core = getCore();
  const providers = await core.getCapabilityProviders(id);
  const settings = core.getCapabilitySettings(id);
  const caps = core.listCapabilities();
  const def = caps[id];

  return NextResponse.json({
    success: true,
    capability: { id, label: def?.label ?? id, description: def?.description ?? '' },
    providers,
    settings,
  });
}

/** PATCH /api/capabilities — capability 설정 변경 (모드, 우선순위 등) */
export async function PATCH(req: NextRequest) {
  const { id, settings, label, description } = await req.json();
  if (!id) return NextResponse.json({ success: false, error: 'capability id 필요' }, { status: 400 });

  const core = getCore();

  // label/description 편집 (동적 등록)
  if (label || description) {
    const caps = core.listCapabilities();
    const existing = caps[id];
    core.registerCapability(id, label ?? existing?.label ?? id, description ?? existing?.description ?? '');
  }

  // 모드/providers 설정 변경
  if (settings) {
    core.setCapabilitySettings(id, settings);
  }

  return NextResponse.json({ success: true });
}

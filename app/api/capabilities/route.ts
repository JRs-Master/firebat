import { NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { withApiError } from '../../../lib/with-api-error';
import { ApiError } from '../../../lib/api-error';

/** GET /api/capabilities — capability 목록 조회 (각 capability별 provider 수 포함) */
export const GET = withApiError(async (req) => {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const list = await getCore().listCapabilitiesWithProviders();
  return NextResponse.json({ success: true, capabilities: list });
});

/** POST /api/capabilities — 특정 capability의 provider 목록 + 설정 */
export const POST = withApiError(async (req) => {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id } = await req.json();
  if (!id) throw new ApiError(400, 'capability id 필요');

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
});

/** PATCH /api/capabilities — capability 설정 변경 (모드, 우선순위 등) */
export const PATCH = withApiError(async (req) => {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const { id, settings, label, description } = await req.json();
  if (!id) throw new ApiError(400, 'capability id 필요');

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
});

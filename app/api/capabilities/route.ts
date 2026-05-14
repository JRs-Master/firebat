import { NextResponse } from 'next/server';
import { withAuth } from '../../../lib/with-api-error';
import { ApiError } from '../../../lib/api-error';
import {
  listCapabilities, listCapabilitiesWithProviders,
  getCapabilityProviders, getCapabilitySettings, setCapabilitySettings,
  registerCapability,
} from '../../../lib/api-gen/capability';

/** GET /api/capabilities — capability 목록 조회 (각 capability별 provider 수 포함) */
export const GET = withAuth(async () => {
  const res = await listCapabilitiesWithProviders();
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, capabilities: res.data });
});

/** POST /api/capabilities — 특정 capability의 provider 목록 + 설정 */
export const POST = withAuth(async (req) => {
  const { id } = await req.json();
  if (!id) throw new ApiError(400, 'capability id 필요');

  const providersRes = await getCapabilityProviders({ value: id });
  const settingsRes = await getCapabilitySettings({ value: id });
  const capsRes = await listCapabilities();
  if (!providersRes.ok) return NextResponse.json({ success: false, error: providersRes.message }, { status: 500 });
  if (!settingsRes.ok) return NextResponse.json({ success: false, error: settingsRes.message }, { status: 500 });
  if (!capsRes.ok) return NextResponse.json({ success: false, error: capsRes.message }, { status: 500 });
  const caps = capsRes.data as Record<string, { label?: string; description?: string }> | null;
  const def = caps?.[id];

  return NextResponse.json({
    success: true,
    capability: { id, label: def?.label ?? id, description: def?.description ?? '' },
    providers: providersRes.data,
    settings: settingsRes.data,
  });
});

/** PATCH /api/capabilities — capability 설정 변경 (모드, 우선순위 등) */
export const PATCH = withAuth(async (req) => {
  const { id, settings, label, description } = await req.json();
  if (!id) throw new ApiError(400, 'capability id 필요');

  // label/description 편집 (동적 등록)
  if (label || description) {
    const capsRes = await listCapabilities();
    const caps = capsRes.ok ? (capsRes.data as Record<string, { label?: string; description?: string }> | null) : null;
    const existing = caps?.[id];
    await registerCapability({
      id,
      label: label ?? existing?.label ?? id,
      description: description ?? existing?.description ?? '',
    });
  }

  // 모드/providers 설정 변경
  if (settings) {
    await setCapabilitySettings({ capId: id, providers: settings?.providers ?? [] });
  }

  return NextResponse.json({ success: true });
});

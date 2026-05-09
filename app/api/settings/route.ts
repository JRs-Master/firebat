import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

/** GET /api/settings — 시스템 설정 조회 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const [
    routerEnabledRaw, timezone, aiModel, aiThinkingLevel,
    aiAssistantModel, aiAssistantModels, userPrompt, lastModelByCategory,
    imageModel, imageModels, imageDefaultSize, imageDefaultQuality,
    anthropicCacheEnabled, subAgentEnabled, adminCreds,
  ] = await Promise.all([
    core.getGeminiKey('system:ai-router:enabled'),
    core.getTimezone(),
    core.getAiModel(),
    core.getAiThinkingLevel(),
    core.getAiAssistantModel(),
    core.getAvailableAiAssistantModels(),
    core.getUserPrompt(),
    core.getLastModelByCategory(),
    core.getImageModel(),
    core.getAvailableImageModels(),
    core.getImageDefaultSize(),
    core.getImageDefaultQuality(),
    core.getAnthropicCacheEnabled(),
    core.isSubAgentEnabled(),
    core.getAdminCredentials(),
  ]);
  // 첫 부팅 admin/admin 디폴트 검출 — boolean 만 노출 (평문 password 응답 X).
  const isDefaultAdmin =
    adminCreds && adminCreds.id === 'admin' && adminCreds.password === 'admin';
  return NextResponse.json({
    success: true,
    timezone,
    aiModel,
    aiThinkingLevel,
    aiRouterEnabled: routerEnabledRaw === 'true' || routerEnabledRaw === '1',
    aiAssistantModel,
    aiAssistantModels,
    userPrompt,
    lastModelByCategory,
    imageModel,
    imageModels,
    imageDefaultSize,
    imageDefaultQuality,
    anthropicCacheEnabled,
    subAgentEnabled,
    isDefaultAdmin,
  });
}

/** PATCH /api/settings — 시스템 설정 변경 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json();
  const core = getCore();

  if (body.timezone) {
    await core.setTimezone(body.timezone);
  }
  if (body.aiModel) {
    await core.setAiModel(body.aiModel);
  }
  if (body.aiThinkingLevel) {
    await core.setAiThinkingLevel(body.aiThinkingLevel);
  }
  if (typeof body.aiRouterEnabled === 'boolean') {
    await core.setGeminiKey('system:ai-router:enabled', body.aiRouterEnabled ? 'true' : 'false');
  }
  if (typeof body.aiAssistantModel === 'string' && body.aiAssistantModel) {
    await core.setAiAssistantModel(body.aiAssistantModel);
  }
  if (typeof body.userPrompt === 'string') {
    await core.setUserPrompt(body.userPrompt);
  }
  if (body.lastModelByCategory && typeof body.lastModelByCategory === 'object') {
    await core.setLastModelByCategory(body.lastModelByCategory as Record<string, string>);
  }
  if (typeof body.imageModel === 'string' && body.imageModel) {
    await core.setImageModel(body.imageModel);
  }
  if ('imageDefaultSize' in body) {
    const v = body.imageDefaultSize;
    await core.setImageDefaultSize(typeof v === 'string' && v ? v : null);
  }
  if ('imageDefaultQuality' in body) {
    const v = body.imageDefaultQuality;
    await core.setImageDefaultQuality(typeof v === 'string' && v ? v : null);
  }
  if (typeof body.anthropicCacheEnabled === 'boolean') {
    await core.setAnthropicCacheEnabled(body.anthropicCacheEnabled);
  }
  if (typeof body.subAgentEnabled === 'boolean') {
    await core.setSubAgentEnabled(body.subAgentEnabled);
  }

  return NextResponse.json({ success: true });
}

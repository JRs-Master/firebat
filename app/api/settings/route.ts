import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { withAuth } from '../../../lib/with-api-error';
import { VK_SYSTEM_AI_ROUTER_ENABLED, VK_SYSTEM_UI_LANG } from '../../../lib/proto-gen/vault-keys';

/** GET /api/settings — 시스템 설정 조회 */
export const GET = withAuth(async (_req: NextRequest) => {
  const core = getCore();
  const [
    routerEnabledRaw, timezone, aiModel, aiThinkingLevel,
    aiAssistantModel, aiAssistantModels, aiModels, userPrompt, lastModelByCategory,
    imageModel, imageModels, imageDefaultSize, imageDefaultQuality,
    anthropicCacheEnabled, subAgentEnabled, uiLangRaw,
  ] = await Promise.all([
    core.getGeminiKey(VK_SYSTEM_AI_ROUTER_ENABLED),
    core.getTimezone(),
    core.getAiModel(),
    core.getAiThinkingLevel(),
    core.getAiAssistantModel(),
    core.getAvailableAiAssistantModels(),
    core.getAvailableAiModels(),       // Step B (2026-05-10) — single source carousel
    core.getUserPrompt(),
    core.getLastModelByCategory(),
    core.getImageModel(),
    core.getAvailableImageModels(),
    core.getImageDefaultSize(),
    core.getImageDefaultQuality(),
    core.getAnthropicCacheEnabled(),
    core.isSubAgentEnabled(),
    core.getGeminiKey(VK_SYSTEM_UI_LANG),
  ]);
  // RustCoreProxy 의 autoUnwrapProtoEnvelope 통해 BoolRequest/StringRequest 자동 unwrap.
  // frontend 는 raw boolean / string 직접 수신.
  const interfaceLang = uiLangRaw === 'en' ? 'en' : 'ko';
  return NextResponse.json({
    success: true,
    timezone,
    aiModel,
    aiThinkingLevel,
    aiRouterEnabled: routerEnabledRaw === 'true' || routerEnabledRaw === '1',
    aiAssistantModel,
    aiAssistantModels,
    aiModels,                            // Rust single source carousel
    userPrompt,
    lastModelByCategory,
    imageModel,
    imageModels,
    imageDefaultSize,
    imageDefaultQuality,
    anthropicCacheEnabled,
    subAgentEnabled,
    interfaceLang,
  });
});

/** PATCH /api/settings — 시스템 설정 변경 */
export const PATCH = withAuth(async (req: NextRequest) => {
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
    await core.setGeminiKey(VK_SYSTEM_AI_ROUTER_ENABLED, body.aiRouterEnabled ? 'true' : 'false');
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
  if (body.interfaceLang === 'ko' || body.interfaceLang === 'en') {
    // 어드민 UI 언어 vault 저장 — i18n hook 의 LangProvider 가 fetch 시 활용.
    await core.setGeminiKey(VK_SYSTEM_UI_LANG, body.interfaceLang);
  }

  return NextResponse.json({ success: true });
});

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../lib/with-api-error';
import { VK_SYSTEM_AI_ROUTER_ENABLED, VK_SYSTEM_UI_LANG } from '../../../lib/proto-gen/vault-keys';
import { getGeminiKey, setGeminiKey } from '../../../lib/api-gen/secret';
import {
  getTimezone, setTimezone,
  getAiModel, setAiModel,
  getAiThinkingLevel, setAiThinkingLevel,
  getAiAssistantModel, setAiAssistantModel,
  getAvailableAiAssistantModels,
  getAvailableAiModels,
  getUserPrompt, setUserPrompt,
  getLastModelByCategory, setLastModelByCategory,
  getAnthropicCacheEnabled, setAnthropicCacheEnabled,
} from '../../../lib/api-gen/settings';
import {
  getImageModel, setImageModel,
  getAvailableImageModels,
  getImageDefaultSize, setImageDefaultSize,
  getImageDefaultQuality, setImageDefaultQuality,
} from '../../../lib/api-gen/media';
import { isSubAgentEnabled, setSubAgentEnabled } from '../../../lib/api-gen/ai';

/** GET /api/settings — 시스템 설정 조회 */
export const GET = withAuth(async (_req: NextRequest) => {
  const [
    routerEnabledRes, timezoneRes, aiModelRes, aiThinkingLevelRes,
    aiAssistantModelRes, aiAssistantModelsRes, aiModelsRes, userPromptRes, lastModelByCategoryRes,
    imageModelRes, imageModelsRes, imageDefaultSizeRes, imageDefaultQualityRes,
    anthropicCacheEnabledRes, subAgentEnabledRes, uiLangRes,
  ] = await Promise.all([
    getGeminiKey({ value: VK_SYSTEM_AI_ROUTER_ENABLED }),
    getTimezone(),
    getAiModel(),
    getAiThinkingLevel(),
    getAiAssistantModel(),
    getAvailableAiAssistantModels(),
    getAvailableAiModels(),
    getUserPrompt(),
    getLastModelByCategory(),
    getImageModel(),
    getAvailableImageModels(),
    getImageDefaultSize(),
    getImageDefaultQuality(),
    getAnthropicCacheEnabled(),
    isSubAgentEnabled(),
    getGeminiKey({ value: VK_SYSTEM_UI_LANG }),
  ]);

  const routerEnabledRaw = routerEnabledRes.ok ? routerEnabledRes.data : null;
  const uiLangRaw = uiLangRes.ok ? uiLangRes.data : null;
  const interfaceLang = uiLangRaw === 'en' ? 'en' : 'ko';
  return NextResponse.json({
    success: true,
    timezone: timezoneRes.ok ? timezoneRes.data : '',
    aiModel: aiModelRes.ok ? aiModelRes.data : '',
    aiThinkingLevel: aiThinkingLevelRes.ok ? aiThinkingLevelRes.data : '',
    aiRouterEnabled: routerEnabledRaw === 'true' || routerEnabledRaw === '1',
    aiAssistantModel: aiAssistantModelRes.ok ? aiAssistantModelRes.data : '',
    aiAssistantModels: aiAssistantModelsRes.ok ? aiAssistantModelsRes.data : null,
    aiModels: aiModelsRes.ok ? aiModelsRes.data : null,
    userPrompt: userPromptRes.ok ? userPromptRes.data : '',
    lastModelByCategory: lastModelByCategoryRes.ok ? lastModelByCategoryRes.data : '',
    imageModel: imageModelRes.ok ? imageModelRes.data : '',
    imageModels: imageModelsRes.ok ? imageModelsRes.data : null,
    imageDefaultSize: imageDefaultSizeRes.ok ? imageDefaultSizeRes.data : null,
    imageDefaultQuality: imageDefaultQualityRes.ok ? imageDefaultQualityRes.data : null,
    anthropicCacheEnabled: anthropicCacheEnabledRes.ok ? anthropicCacheEnabledRes.data : false,
    subAgentEnabled: subAgentEnabledRes.ok ? subAgentEnabledRes.data : false,
    interfaceLang,
  });
});

/** PATCH /api/settings — 시스템 설정 변경 */
export const PATCH = withAuth(async (req: NextRequest) => {
  const body = await req.json();

  if (body.timezone) {
    await setTimezone({ value: body.timezone });
  }
  if (body.aiModel) {
    await setAiModel({ value: body.aiModel });
  }
  if (body.aiThinkingLevel) {
    await setAiThinkingLevel({ value: body.aiThinkingLevel });
  }
  if (typeof body.aiRouterEnabled === 'boolean') {
    await setGeminiKey({ key: VK_SYSTEM_AI_ROUTER_ENABLED, value: body.aiRouterEnabled ? 'true' : 'false' });
  }
  if (typeof body.aiAssistantModel === 'string' && body.aiAssistantModel) {
    await setAiAssistantModel({ value: body.aiAssistantModel });
  }
  if (typeof body.userPrompt === 'string') {
    await setUserPrompt({ value: body.userPrompt });
  }
  if (body.lastModelByCategory && typeof body.lastModelByCategory === 'object') {
    await setLastModelByCategory({ byCategoryJson: JSON.stringify(body.lastModelByCategory ?? {}) });
  }
  if (typeof body.imageModel === 'string' && body.imageModel) {
    await setImageModel({ value: body.imageModel });
  }
  if ('imageDefaultSize' in body) {
    const v = body.imageDefaultSize;
    await setImageDefaultSize({ value: typeof v === 'string' && v ? v : '' });
  }
  if ('imageDefaultQuality' in body) {
    const v = body.imageDefaultQuality;
    await setImageDefaultQuality({ value: typeof v === 'string' && v ? v : '' });
  }
  if (typeof body.anthropicCacheEnabled === 'boolean') {
    await setAnthropicCacheEnabled({ value: body.anthropicCacheEnabled });
  }
  if (typeof body.subAgentEnabled === 'boolean') {
    await setSubAgentEnabled({ value: body.subAgentEnabled });
  }
  if (body.interfaceLang === 'ko' || body.interfaceLang === 'en') {
    // 어드민 UI 언어 vault 저장 — i18n hook 의 LangProvider 가 fetch 시 활용.
    await setGeminiKey({ key: VK_SYSTEM_UI_LANG, value: body.interfaceLang });
  }

  return NextResponse.json({ success: true });
});

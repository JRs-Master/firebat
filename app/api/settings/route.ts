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
    ttsProviderRes, ttsModelRes, ttsVoiceRes, ttsAlignRes,
  ] = await Promise.all([
    getGeminiKey({ key: VK_SYSTEM_AI_ROUTER_ENABLED }),
    getTimezone(),
    getAiModel(),
    getAiThinkingLevel(),
    getAiAssistantModel(),
    getAvailableAiAssistantModels(),
    getAvailableAiModels(),
    getUserPrompt({}),
    getLastModelByCategory(),
    getImageModel(),
    getAvailableImageModels(),
    getImageDefaultSize(),
    getImageDefaultQuality(),
    getAnthropicCacheEnabled(),
    isSubAgentEnabled(),
    getGeminiKey({ key: VK_SYSTEM_UI_LANG }),
    getGeminiKey({ key: 'system:tts:provider' }),
    getGeminiKey({ key: 'system:tts:model' }),
    getGeminiKey({ key: 'system:tts:voice' }),
    getGeminiKey({ key: 'system:tts:align_provider' }),
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
    ttsProvider: ttsProviderRes.ok ? (ttsProviderRes.data || '') : '',
    ttsModel: ttsModelRes.ok ? (ttsModelRes.data || '') : '',
    ttsVoice: ttsVoiceRes.ok ? (ttsVoiceRes.data || '') : '',
    ttsAlignProvider: ttsAlignRes.ok ? (ttsAlignRes.data || '') : '',
  });
});

/** PATCH /api/settings — 시스템 설정 변경 */
export const PATCH = withAuth(async (req: NextRequest) => {
  const body = await req.json();

  if (body.timezone) {
    await setTimezone({ timezone: body.timezone });
  }
  if (body.aiModel) {
    await setAiModel({ model: body.aiModel });
  }
  if (body.aiThinkingLevel) {
    await setAiThinkingLevel({ level: body.aiThinkingLevel });
  }
  if (typeof body.aiRouterEnabled === 'boolean') {
    await setGeminiKey({ key: VK_SYSTEM_AI_ROUTER_ENABLED, value: body.aiRouterEnabled ? 'true' : 'false' });
  }
  if (typeof body.aiAssistantModel === 'string' && body.aiAssistantModel) {
    await setAiAssistantModel({ model: body.aiAssistantModel });
  }
  if (typeof body.userPrompt === 'string') {
    await setUserPrompt({ prompt: body.userPrompt });
  }
  if (body.lastModelByCategory && typeof body.lastModelByCategory === 'object') {
    await setLastModelByCategory({ byCategoryJson: JSON.stringify(body.lastModelByCategory ?? {}) });
  }
  if (typeof body.imageModel === 'string' && body.imageModel) {
    await setImageModel({ model: body.imageModel });
  }
  if ('imageDefaultSize' in body) {
    const v = body.imageDefaultSize;
    await setImageDefaultSize({ size: typeof v === 'string' && v ? v : '' });
  }
  if ('imageDefaultQuality' in body) {
    const v = body.imageDefaultQuality;
    await setImageDefaultQuality({ quality: typeof v === 'string' && v ? v : '' });
  }
  if (typeof body.anthropicCacheEnabled === 'boolean') {
    await setAnthropicCacheEnabled({ enabled: body.anthropicCacheEnabled });
  }
  if (typeof body.subAgentEnabled === 'boolean') {
    await setSubAgentEnabled({ enabled: body.subAgentEnabled });
  }
  if (body.interfaceLang === 'ko' || body.interfaceLang === 'en') {
    // 어드민 UI 언어 vault 저장 — i18n hook 의 LangProvider 가 fetch 시 활용.
    await setGeminiKey({ key: VK_SYSTEM_UI_LANG, value: body.interfaceLang });
  }
  if (typeof body.ttsProvider === 'string') {
    await setGeminiKey({ key: 'system:tts:provider', value: body.ttsProvider });
  }
  if (typeof body.ttsModel === 'string') {
    await setGeminiKey({ key: 'system:tts:model', value: body.ttsModel });
  }
  if (typeof body.ttsVoice === 'string') {
    await setGeminiKey({ key: 'system:tts:voice', value: body.ttsVoice });
  }
  if (typeof body.ttsAlignProvider === 'string') {
    await setGeminiKey({ key: 'system:tts:align_provider', value: body.ttsAlignProvider });
  }

  return NextResponse.json({ success: true });
});

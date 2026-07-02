/**
 * Shared settings I/O — owner-parameterized so admin (`/api/settings`) and hub tenant
 * (`/api/hub/[slug]/settings`) use ONE assembly/persist path, not parallel implementations.
 *
 * owner === undefined → admin (global) scope. owner set → a hub tenant:
 *   - load: reads that owner's per-tenant fields (userPrompt today), the rest are the shared
 *     admin globals so the same full shape comes back (tabs that open later need no change).
 *   - save: persists ONLY the per-tenant fields; admin-global fields are read-only to a tenant
 *     (their vault/model config is admin-shared until per-tenant login lands, Phase 4).
 *
 * To make a field per-tenant later: add it to the `owner` branch of saveSettings (and, if it is
 * not already global-readable, to loadSettings) — no route or frontend change needed.
 */
import { VK_SYSTEM_AI_ROUTER_ENABLED, VK_SYSTEM_UI_LANG } from './proto-gen/vault-keys';
import { getGeminiKey, setGeminiKey } from './api-gen/secret';
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
} from './api-gen/settings';
import {
  getImageModel, setImageModel,
  getAvailableImageModels,
  getImageDefaultSize, setImageDefaultSize,
  getImageDefaultQuality, setImageDefaultQuality,
} from './api-gen/media';
import { isSubAgentEnabled, setSubAgentEnabled } from './api-gen/ai';

/** Full settings snapshot. userPrompt is owner-scoped; the rest are admin-global. */
export async function loadSettings(owner?: string) {
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
    getUserPrompt(owner ? { owner } : {}),
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
  return {
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
  };
}

/**
 * Persist a settings patch. With an owner (hub tenant) only per-tenant fields are written;
 * admin-global fields in the body are ignored (a tenant cannot mutate shared config).
 */
export async function saveSettings(body: Record<string, any>, owner?: string) {
  // ── per-tenant fields (also written by admin) ──
  if (typeof body.userPrompt === 'string') {
    await setUserPrompt(owner ? { prompt: body.userPrompt, owner } : { prompt: body.userPrompt });
  }
  // A hub tenant can only change its per-tenant fields; the rest are admin-shared (read-only).
  if (owner) return;

  // ── admin-global fields ──
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
    // Admin UI language vault key — the i18n LangProvider reads it on fetch.
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
}

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
import {
  VK_SYSTEM_AI_ROUTER_ENABLED, VK_SYSTEM_UI_LANG,
  VK_SYSTEM_EMBED_CATALOG_PROVIDER, VK_SYSTEM_LIBRARY_PARSE_PROVIDER, VK_SYSTEM_RETENTION_ENABLED,
  VK_SYSTEM_RETENTION_DAYS,
  VK_SYSTEM_MEMORY_AUTO_SAVE,
} from './proto-gen/vault-keys';
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
    embedProviderRes, parseProviderRes, retentionEnabledRes,
    retentionDaysRes,
    memoryAutoSaveRes,
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
    getGeminiKey({ key: VK_SYSTEM_EMBED_CATALOG_PROVIDER }),
    getGeminiKey({ key: VK_SYSTEM_LIBRARY_PARSE_PROVIDER }),
    getGeminiKey({ key: VK_SYSTEM_RETENTION_ENABLED }),
    getGeminiKey({ key: VK_SYSTEM_RETENTION_DAYS }),
    getGeminiKey({ key: VK_SYSTEM_MEMORY_AUTO_SAVE }),
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
    embedCatalogProvider: embedProviderRes.ok && embedProviderRes.data === 'solar' ? 'solar' : 'local',
    libraryParseProvider: parseProviderRes.ok && ['solar', 'gemini'].includes(parseProviderRes.data || '')
      ? parseProviderRes.data : 'none',
    // Polarity: unset = ON (retention is the safe default) — `=== 'true'` here would render
    // a fresh install as OFF, the opposite of the backend gate (`v != "false"`).
    retentionEnabled: !(retentionEnabledRes.ok && retentionEnabledRes.data === 'false'),
    // 휴지통 보존 일수 — 기본 30일 (백엔드 clamp 1~365 미러).
    retentionDays: (() => {
      const n = retentionDaysRes.ok ? parseInt(retentionDaysRes.data || '', 10) : NaN;
      return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30;
    })(),
    // 메모리(교훈) 자동 등록 — 미설정 = 리콜 토글 상속 (분리 전 동작 불변).
    memoryAutoSave: memoryAutoSaveRes.ok && memoryAutoSaveRes.data
      ? memoryAutoSaveRes.data === 'true' || memoryAutoSaveRes.data === '1'
      : routerEnabledRaw === 'true' || routerEnabledRaw === '1',
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
  if (typeof body.memoryAutoSave === 'boolean') {
    await setGeminiKey({ key: VK_SYSTEM_MEMORY_AUTO_SAVE, value: body.memoryAutoSave ? 'true' : 'false' });
  }
  if (typeof body.retentionDays === 'number' && Number.isFinite(body.retentionDays)) {
    const d = Math.min(365, Math.max(1, Math.round(body.retentionDays)));
    await setGeminiKey({ key: VK_SYSTEM_RETENTION_DAYS, value: String(d) });
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
  // ── assistant tab (worker axis) — toggles/selects, persisted via the Save button batch ──
  if (body.embedCatalogProvider === 'local' || body.embedCatalogProvider === 'solar') {
    await setGeminiKey({ key: VK_SYSTEM_EMBED_CATALOG_PROVIDER, value: body.embedCatalogProvider });
  }
  if (['none', 'solar', 'gemini'].includes(body.libraryParseProvider)) {
    await setGeminiKey({ key: VK_SYSTEM_LIBRARY_PARSE_PROVIDER, value: body.libraryParseProvider });
  }
  if (typeof body.retentionEnabled === 'boolean') {
    await setGeminiKey({ key: VK_SYSTEM_RETENTION_ENABLED, value: body.retentionEnabled ? 'true' : 'false' });
  }
}

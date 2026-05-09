import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { unwrapString, unwrapBool } from '../../../lib/proto-unwrap';

/** GET /api/settings — 시스템 설정 조회 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const [
    routerEnabledRaw, timezone, aiModel, aiThinkingLevel,
    aiAssistantModel, aiAssistantModels, userPrompt, lastModelByCategory,
    imageModel, imageModels, imageDefaultSize, imageDefaultQuality,
    anthropicCacheEnabled, subAgentEnabled, uiLangRaw,
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
    core.getGeminiKey('system:ui-lang'),
  ]);
  // proto wrap envelope unwrap — `{value: 'Asia/Seoul'}` → `'Asia/Seoul'`
  // (옛 buggy: timezone 객체 그대로 응답 시 frontend select 가 string 옵션과 매칭 못 해
  //  default 첫 옵션 (Pacific/Midway) 표시. aiThinkingLevel / userPrompt 등도 동일 패턴)
  const tz = unwrapString(timezone, 'Asia/Seoul');
  const thinking = unwrapString(aiThinkingLevel, 'medium');
  const prompt = unwrapString(userPrompt, '');
  const routerEnabledStr = unwrapString(routerEnabledRaw, '');
  const cacheEnabled = unwrapBool(anthropicCacheEnabled, false);
  const subAgent = unwrapBool(subAgentEnabled, false);
  const uiLang = unwrapString(uiLangRaw, '');
  const interfaceLang = uiLang === 'en' ? 'en' : 'ko';
  return NextResponse.json({
    success: true,
    timezone: tz,
    aiModel,
    aiThinkingLevel: thinking,
    aiRouterEnabled: routerEnabledStr === 'true' || routerEnabledStr === '1',
    aiAssistantModel,
    aiAssistantModels,
    userPrompt: prompt,
    lastModelByCategory,
    imageModel,
    imageModels,
    imageDefaultSize,
    imageDefaultQuality,
    anthropicCacheEnabled: cacheEnabled,
    subAgentEnabled: subAgent,
    interfaceLang,
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
  if (body.interfaceLang === 'ko' || body.interfaceLang === 'en') {
    // 어드민 UI 언어 vault 저장 — i18n hook 의 LangProvider 가 fetch 시 활용.
    await core.setGeminiKey('system:ui-lang', body.interfaceLang);
  }

  return NextResponse.json({ success: true });
}

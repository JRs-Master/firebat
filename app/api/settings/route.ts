import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';

/** GET /api/settings — 시스템 설정 조회 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const routerEnabledRaw = core.getGeminiKey('system:ai-router:enabled');
  return NextResponse.json({
    success: true,
    timezone: core.getTimezone(),
    aiModel: core.getAiModel(),
    aiThinkingLevel: core.getAiThinkingLevel(),
    aiRouterEnabled: routerEnabledRaw === 'true' || routerEnabledRaw === '1',
    aiAssistantModel: core.getAiAssistantModel(),
    aiAssistantModels: core.getAvailableAiAssistantModels(),
    userPrompt: core.getUserPrompt(),
  });
}

/** PATCH /api/settings — 시스템 설정 변경 */
export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json();
  const core = getCore();

  if (body.timezone) {
    core.setTimezone(body.timezone);
  }
  if (body.aiModel) {
    core.setAiModel(body.aiModel);
  }
  if (body.aiThinkingLevel) {
    core.setAiThinkingLevel(body.aiThinkingLevel);
  }
  if (typeof body.aiRouterEnabled === 'boolean') {
    core.setGeminiKey('system:ai-router:enabled', body.aiRouterEnabled ? 'true' : 'false');
  }
  if (typeof body.aiAssistantModel === 'string' && body.aiAssistantModel) {
    core.setAiAssistantModel(body.aiAssistantModel);
  }
  if (typeof body.userPrompt === 'string') {
    core.setUserPrompt(body.userPrompt);
  }

  return NextResponse.json({ success: true });
}

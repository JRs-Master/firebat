import { NextRequest, NextResponse } from 'next/server';
import { getUserPrompt, setUserPrompt } from '../../../../../lib/api-gen/settings';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/settings — hub 테넌트 설정 dispatcher (프롬프트 = 개인 지시사항).
 *
 * 인증 = X-Api-Token + X-Session-Id → owner `hub:<inst>:<sid>` 자동 강제. Rust SettingsService 가
 * owner 별 user-prompt 키로 격리. ops: get-prompt / set-prompt. (봇 페르소나 system_prompt 는
 * HubInstanceDetail 별개 — 여기는 테넌트 개인 지시사항 userPrompt.)
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;
  const owner = principal.owner;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'get-prompt': {
        const res = await getUserPrompt({ owner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, userPrompt: res.data ?? '' });
      }
      case 'set-prompt': {
        const res = await setUserPrompt({ prompt: String(body.prompt ?? ''), owner } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: res.data === true });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-settings', 'op 실패', { op, error: err });
    return jsonResponse(500, { error: (err as Error)?.message ?? '서버 오류' });
  }
}

function jsonResponse(status: number, body: unknown) {
  return NextResponse.json(body, { status });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

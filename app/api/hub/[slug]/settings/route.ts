import { NextRequest, NextResponse } from 'next/server';
import { loadSettings, saveSettings } from '../../../../../lib/settings-io';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/settings: owner-scoped settings dispatcher for a hub tenant.
 *
 * Auth = X-Api-Token + X-Session-Id, forcing owner `hub:<inst>:<sid>` automatically. Uses the same
 * lib/settings-io loadSettings/saveSettings as admin `/api/settings`, only owner differs — so the
 * full settings shape is returned/accepted and load/save converge with admin (tabs that open later
 * need no route change). A tenant reads the shared admin globals but persists only its per-tenant
 * fields (userPrompt today); the rest are read-only until per-tenant login (Phase 4).
 * ops: get-settings / save-settings.
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
      case 'get-settings': {
        return NextResponse.json(await loadSettings(owner));
      }
      case 'save-settings': {
        await saveSettings(body, owner);
        return NextResponse.json({ success: true });
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

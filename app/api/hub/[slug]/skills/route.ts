import { NextRequest, NextResponse } from 'next/server';
import {
  listFiles,
  readFile,
  saveFile,
  deleteFile,
} from '../../../../../lib/api-gen/skill';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/skills
 *
 * Anonymous hub visitor's Skills dispatcher. Mirrors admin /api/skills + forces the
 * owner to `<instance.id>:<sessionId>` (per-session, like templates). The sidebar is
 * reused in hub, so skills (a sidebar panel) are managed here per session.
 *
 * Auth: X-Api-Token + X-Session-Id. owner: session-scoped (visitor-supplied owner ignored).
 *
 * ops: list / get / save / delete.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

const KINDS = ['design', 'tool-usage', 'procedure', 'persona', 'policy'];

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;
  const hubOwner = principal.owner;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'list': {
        const res = await listFiles({ owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, items: res.data });
      }
      case 'get': {
        const sslug = String(body.slug ?? '');
        if (!sslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await readFile({ slug: sslug, owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, item: res.data });
      }
      case 'save': {
        const sslug = String(body.slug ?? '');
        if (!sslug) return jsonResponse(400, { error: 'slug 필수' });
        const kind = String(body.kind ?? 'procedure');
        if (kind && !KINDS.includes(kind)) {
          return jsonResponse(400, { error: `kind 는 ${KINDS.join('/')} 중 하나` });
        }
        const content = typeof body.content === 'string' ? body.content : '';
        const res = await saveFile({
          slug: sslug,
          name: String(body.name ?? sslug).trim() || sslug,
          kind,
          description: String(body.description ?? ''),
          content,
          owner: hubOwner,
        });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'delete': {
        const sslug = String(body.slug ?? '');
        if (!sslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await deleteFile({ slug: sslug, owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-skills', 'op 실패', { op, error: err });
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

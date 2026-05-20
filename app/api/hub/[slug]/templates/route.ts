import { NextRequest, NextResponse } from 'next/server';
import {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
} from '../../../../../lib/api-gen/template';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/templates
 *
 * 익명 hub 방문자의 Templates dispatcher. admin /api/templates 와 동등 RPC 매핑 +
 * owner 자동 `<instance.id>` 강제. 방문자 자료 = `user/hub/<instance.id>/templates/`.
 *
 * 인증: X-Api-Token + X-Session-Id. owner: instance.id 강제 (방문자가 args.owner 보내도 무시).
 *
 * ops: list / get / save / delete.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';

  if (!apiToken) return jsonResponse(401, { error: 'X-Api-Token 헤더가 필요합니다.' });
  if (!sessionId) return jsonResponse(400, { error: 'X-Session-Id 헤더가 필요합니다.' });

  const authRes = await authenticate({ slug, apiToken, origin, selfHost });
  if (!authRes.ok) {
    const msg = authRes.message ?? '인증 실패';
    if (msg.includes('UNAUTHORIZED_ORIGIN:')) {
      return jsonResponse(403, { error: '허용되지 않은 도메인입니다.' });
    }
    return jsonResponse(401, { error: msg });
  }
  const instance = authRes.data?.instance;
  if (!instance) return jsonResponse(500, { error: 'instance 조회 실패' });
  const hubOwner = instance.id;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'list': {
        const res = await listTemplates({ owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, templates: res.data });
      }
      case 'get': {
        const tslug = String(body.slug ?? '');
        if (!tslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await getTemplate({ slug: tslug, owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, template: res.data });
      }
      case 'save': {
        const tslug = String(body.slug ?? '');
        const config = body.config ?? {};
        if (!tslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await saveTemplate({
          slug: tslug,
          configJson: JSON.stringify(config),
          owner: hubOwner,
        });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'delete': {
        const tslug = String(body.slug ?? '');
        if (!tslug) return jsonResponse(400, { error: 'slug 필수' });
        const res = await deleteTemplate({ slug: tslug, owner: hubOwner });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-templates', 'op 실패', { op, error: err });
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

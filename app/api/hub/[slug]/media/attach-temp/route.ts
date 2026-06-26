import { NextRequest, NextResponse } from 'next/server';
import { saveTempAttachment } from '../../../../../../lib/api-gen/media';
import { resolvePrincipal, isPrincipalError } from '../../../../../../lib/principal';
import { logger } from '../../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/media/attach-temp
 *
 * 익명 hub 방문자의 채팅 첨부 이미지 임시 저장. admin /api/media/attach-temp 가 admin auth
 * 강제라 hub visitor 가 호출 시 401 → 첨부 실패 root cause. 본 endpoint 가 X-Api-Token +
 * X-Session-Id 검증 후 동일 RPC 호출.
 *
 * Body: { dataUrl: 'data:image/png;base64,...' }
 * 응답: { success: true, data: { slug, url } }
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonError(400, 'JSON body 필요');
  }
  const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
  if (!dataUrl.startsWith('data:')) {
    return jsonError(400, 'dataUrl 가 data URL 형식이 아닙니다.');
  }

  try {
    const result = await saveTempAttachment({ dataUrl } as any);
    if (!result.ok) {
      return jsonError(500, result.message);
    }
    return NextResponse.json({ success: true, data: result.data }, { headers: corsHeaders() });
  } catch (err) {
    logger.debug('hub-media-attach', 'attach-temp 실패', { error: err });
    return jsonError(500, (err as Error)?.message ?? '서버 오류');
  }
}

function jsonError(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Type',
  };
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

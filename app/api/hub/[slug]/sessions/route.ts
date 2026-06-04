import { NextRequest, NextResponse } from 'next/server';
import {
  authenticate,
  ensureConversation,
  createConversation,
  listConversations,
  listDeletedConversations,
  getConversation,
  deleteConversation,
  restoreConversation,
  permanentDeleteConversation,
  updateConversationTitle,
  listMessages,
} from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/sessions
 *
 * 익명 hub 방문자가 자기 세션 CRUD 할 수 있게 만든 dispatcher. admin auth 우회 (withAuth X).
 * 인증 = X-Api-Token + X-Session-Id header. instance.api_token 매칭 + sessionId 기반
 * 권한 가드 (다른 사용자 sessionId 접근 차단).
 *
 * Body: `{ op: 'list-conversations' | 'create-conversation' | 'get-conversation' |
 *          'delete-conversation' | 'update-conversation-title' | 'list-messages',
 *          id?: string, title?: string }`
 *
 * admin dispatcher (/api/hub/[slug]/route.ts) 와 별개 — 본 영역 = anonymous + sessionId scope 가드.
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

  // 인증 — slug + apiToken + origin/self_host 검증. UNAUTHORIZED_ORIGIN sentinel 이면 403.
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

  let body: { op?: string; id?: string; title?: string } = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = body.op ?? '';

  // 대화 ownership(instance_id + session_id 매칭)은 Rust core(HubService)가 강제 — 각 RPC 에 instanceId/sessionId
  // 전달 시 불일치/부재면 권한 거부. 프론트 가드 폐기.
  try {
    switch (op) {
      case 'list-conversations': {
        const res = await listConversations({ instanceId: instance.id, sessionId });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, conversations: res.data ?? [] });
      }
      case 'ensure-conversation': {
        const res = await ensureConversation({ instanceId: instance.id, sessionId });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, conversationId: res.data });
      }
      case 'create-conversation': {
        const res = await createConversation({ instanceId: instance.id, sessionId });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, conversationId: res.data });
      }
      case 'get-conversation': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await getConversation({ id, instanceId: instance.id, sessionId } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, conversation: res.data });
      }
      case 'delete-conversation': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await deleteConversation({ id, instanceId: instance.id, sessionId } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'list-deleted-conversations': {
        const res = await listDeletedConversations({ instanceId: instance.id, sessionId });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, conversations: res.data ?? [] });
      }
      case 'restore-conversation': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await restoreConversation({ id, instanceId: instance.id, sessionId } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'permanent-delete-conversation': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await permanentDeleteConversation({ id, instanceId: instance.id, sessionId } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'update-conversation-title': {
        const id = String(body.id ?? '');
        const title = String(body.title ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await updateConversationTitle({ id, title, instanceId: instance.id, sessionId } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
      }
      case 'list-messages': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'id 필수' });
        const res = await listMessages({ conversationId: id, instanceId: instance.id, sessionId } as any);
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true, messages: res.data ?? [] });
      }
      default:
        return jsonResponse(400, { error: `지원되지 않는 op: ${op}` });
    }
  } catch (err) {
    logger.debug('hub-sessions', 'op 실패', { op, error: err });
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

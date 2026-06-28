import { NextRequest, NextResponse } from 'next/server';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import {
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
  saveMessage,
} from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * POST /api/hub/[slug]/sessions
 *
 * Dispatcher letting an anonymous hub visitor manage their own session conversations. Bypasses admin
 * auth (no withAuth). Auth = X-Api-Token + X-Session-Id headers: instance.api_token match + sessionId
 * scope guard (blocks access to another visitor's sessionId).
 *
 * Body: `{ op: 'list-conversations' | 'ensure-conversation' | 'create-conversation' | 'get-conversation' |
 *          'delete-conversation' | 'list-deleted-conversations' | 'restore-conversation' |
 *          'permanent-delete-conversation' | 'update-conversation-title' | 'list-messages' | 'save-message',
 *          id?: string, title?: string, message?: unknown }`
 *
 * Separate from the admin dispatcher (/api/hub/[slug]/route.ts) — this one is anonymous + sessionId-scoped.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return principal;
  // instance.id / sessionId passed as RPC args (not owner-keyed) → kept separate for call-site compatibility.
  const instance = principal.hubInstance!;
  const sessionId = principal.sessionId!;

  let body: { op?: string; id?: string; title?: string; message?: unknown } = {};
  try { body = await req.json(); }
  catch { return jsonResponse(400, { error: 'JSON body 필요' }); }

  const op = body.op ?? '';

  // Conversation ownership (instance_id + session_id match) is enforced by Rust core (HubService):
  // each RPC gets instanceId/sessionId and denies on mismatch/absence. No frontend guard.
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
      case 'save-message': {
        // Re-save an existing message (approve/reject status etc.) — owner verified by Rust core (ensure_conv_owner).
        const id = String(body.id ?? '');
        if (!id || !body.message) return jsonResponse(400, { error: 'id·message 필수' });
        const res = await saveMessage({
          conversationId: id,
          instanceId: instance.id,
          sessionId,
          messageJson: JSON.stringify(body.message),
        });
        if (!res.ok) return jsonResponse(500, { error: res.message });
        return NextResponse.json({ success: true });
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

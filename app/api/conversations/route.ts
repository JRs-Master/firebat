import { NextRequest, NextResponse } from 'next/server';
import {
  getConversation,
  listConversations,
  saveConversation,
  saveMessage,
  deleteConversation,
  isConversationDeleted,
} from '../../../lib/api-gen/conversation';
import { withAuth } from '../../../lib/with-api-error';
import { safeJsonParse, normalizeTimestamps } from '../../../lib/util';

/**
 * /api/conversations — admin conversation history CRUD (multi-device sync).
 */

// normalizeTimestamps — proto i64 → number (createdAt / updatedAt). See lib/util/normalize.ts.

/** GET — full list, or single conversation when ?id=xxx. */
export const GET = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const res = await getConversation({ owner: 'admin', id });
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.message }, { status: 404 });
    }
    // Rust ConversationRecordPb.messages_json (string) → frontend messages array (empty when absent).
    const raw = res.data as Record<string, unknown> | undefined;
    const messagesJson = raw?.messagesJson as string | undefined;
    const messages = safeJsonParse<unknown[]>(messagesJson, []);
    return NextResponse.json({
      success: true,
      conversation: normalizeTimestamps({ ...(raw ?? {}), messages }),
    });
  }
  const res = await listConversations({ owner: 'admin' });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  const items = ((res.data ?? []) as unknown) as Array<Record<string, unknown>>;
  return NextResponse.json({
    success: true,
    conversations: items.map(item => normalizeTimestamps(item)),
  });
});

/** POST — save/update a conversation (upsert). Deleted (tombstoned) conversations are rejected with 409. */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const { id, title, messages, createdAt } = body as { id?: string; title?: string; messages?: unknown[]; createdAt?: number };
  if (!id || !title || !Array.isArray(messages)) {
    return NextResponse.json({ success: false, error: 'id, title, messages 필수' }, { status: 400 });
  }
  // tombstone check — prevent a stale POST from one device resurrecting a conversation deleted on another.
  const isDeleted = await isConversationDeleted({ owner: 'admin', id });
  if (isDeleted.ok && isDeleted.data) {
    return NextResponse.json({ success: false, error: 'deleted', deleted: true }, { status: 409 });
  }
  const res = await saveConversation({
    owner: 'admin',
    id,
    title,
    messagesJson: JSON.stringify(messages ?? []),
    createdAt: createdAt !== undefined ? BigInt(createdAt) : undefined,
  } as any);
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});

/** PATCH — re-save a single message (client-state: approve/reject etc.). Upserts only the changed message
 *  instead of the whole conversation. Symmetric with hub /api/hub/[slug]/sessions save-message —
 *  both go through ConversationManager.append(owner). */
export const PATCH = withAuth(async (req: NextRequest) => {
  const { id, message } = (await req.json()) as { id?: string; message?: unknown };
  if (!id || !message) {
    return NextResponse.json({ success: false, error: 'id, message 필수' }, { status: 400 });
  }
  const res = await saveMessage({ owner: 'admin', conversationId: id, messageJson: JSON.stringify(message) });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});

/** DELETE — delete by ?id=xxx. */
export const DELETE = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await deleteConversation({ owner: 'admin', id });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});

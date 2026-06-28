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
 * /api/conversations — 관리자 대화 히스토리 CRUD (다기기 동기화)
 */

// normalizeTimestamps — proto i64 → number 변환 (createdAt / updatedAt). lib/util/normalize.ts 통합.

/** GET — 전체 목록 또는 ?id=xxx 단건 */
export const GET = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const res = await getConversation({ owner: 'admin', id });
    if (!res.ok) {
      return NextResponse.json({ success: false, error: res.message }, { status: 404 });
    }
    // Rust ConversationRecordPb 의 messages_json (string) 필드 → frontend messages array 로 변환.
    // 미존재 시 빈 배열.
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

/** POST — 대화 저장/갱신 (upsert). 삭제된 대화(tombstone) 는 409 로 거부. */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const { id, title, messages, createdAt } = body as { id?: string; title?: string; messages?: unknown[]; createdAt?: number };
  if (!id || !title || !Array.isArray(messages)) {
    return NextResponse.json({ success: false, error: 'id, title, messages 필수' }, { status: 400 });
  }
  // tombstone 체크 — 한 기기에서 삭제한 대화를 다른 기기의 stale POST 가 되살리는 것 방지
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

/** PATCH — 단건 메시지 재저장(승인/거부 등 client-state). 전체 conv 재저장 대신 바뀐 메시지 1건만 upsert.
 *  hub /api/hub/[slug]/sessions 의 save-message 와 대칭 — 둘 다 ConversationManager.append(owner) 단일 경로. */
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

/** DELETE — ?id=xxx 삭제 */
export const DELETE = withAuth(async (req: NextRequest) => {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await deleteConversation({ owner: 'admin', id });
  return res.ok
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.message }, { status: 500 });
});

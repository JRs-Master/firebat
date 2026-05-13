import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../lib/auth-guard';
import { safeJsonParse, normalizeTimestamps } from '../../../lib/util';

/**
 * /api/conversations — 관리자 대화 히스토리 CRUD (다기기 동기화)
 */
async function assertAdmin(req: NextRequest) {
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;
  return auth;
}

// normalizeTimestamps — proto i64 → number 변환 (createdAt / updatedAt). lib/util/normalize.ts 통합.

/** GET — 전체 목록 또는 ?id=xxx 단건 */
export async function GET(req: NextRequest) {
  const auth = await assertAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const id = req.nextUrl.searchParams.get('id');
  const core = getCore();
  if (id) {
    const res = await core.getConversation('admin', id);
    if (!res.success) {
      return NextResponse.json({ success: false, error: res.error }, { status: 404 });
    }
    // Rust ConversationRecordPb 의 messages_json (string) 필드 → frontend messages array 로 변환.
    // proto-loader `keepCase: false` 라 camelCase (messagesJson) 만 응답. 미존재 시 빈 배열.
    const raw = res.data as Record<string, unknown> | undefined;
    const messagesJson = raw?.messagesJson as string | undefined;
    const messages = safeJsonParse<unknown[]>(messagesJson, []);
    return NextResponse.json({
      success: true,
      conversation: normalizeTimestamps({ ...(raw ?? {}), messages }),
    });
  }
  const res = await core.listConversations('admin');
  if (!res.success) {
    return NextResponse.json({ success: false, error: res.error }, { status: 500 });
  }
  const items = (res.data ?? []) as Array<Record<string, unknown>>;
  return NextResponse.json({
    success: true,
    conversations: items.map(item => normalizeTimestamps(item)),
  });
}

/** POST — 대화 저장/갱신 (upsert). 삭제된 대화(tombstone) 는 409 로 거부. */
export async function POST(req: NextRequest) {
  const auth = await assertAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await req.json();
    const { id, title, messages, createdAt } = body as { id?: string; title?: string; messages?: unknown[]; createdAt?: number };
    if (!id || !title || !Array.isArray(messages)) {
      return NextResponse.json({ success: false, error: 'id, title, messages 필수' }, { status: 400 });
    }
    const core = getCore();
    // tombstone 체크 — 한 기기에서 삭제한 대화를 다른 기기의 stale POST 가 되살리는 것 방지
    if (await core.isConversationDeleted('admin', id)) {
      return NextResponse.json({ success: false, error: 'deleted', deleted: true }, { status: 409 });
    }
    const res = await core.saveConversation('admin', id, title, messages, createdAt);
    return res.success
      ? NextResponse.json({ success: true })
      : NextResponse.json({ success: false, error: res.error }, { status: 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/** DELETE — ?id=xxx 삭제 */
export async function DELETE(req: NextRequest) {
  const auth = await assertAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ success: false, error: 'id 필수' }, { status: 400 });
  const res = await getCore().deleteConversation('admin', id);
  return res.success
    ? NextResponse.json({ success: true })
    : NextResponse.json({ success: false, error: res.error }, { status: 500 });
}

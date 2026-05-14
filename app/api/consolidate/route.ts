/**
 * Consolidate API — Phase 4. 대화 → LLM 후처리 → entity/fact/event 자동 추출.
 *
 * POST /api/consolidate { conversationId, owner? }
 *   → { extractedCounts, savedCounts, skipped, costUsd }
 *
 * 어드민 "이 대화 정리하기" 버튼이 호출. AI 도구 (consolidate_conversation) 도 같은 경로.
 */
import { NextRequest, NextResponse } from 'next/server';
import { consolidate } from '../../../lib/api-gen/consolidation';
import { withAuth } from '../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body?.conversationId) {
    return NextResponse.json({ success: false, error: 'conversationId 필수' }, { status: 400 });
  }
  const res = await consolidate({
    conversationId: String(body.conversationId),
    owner: typeof body.owner === 'string' ? body.owner : 'admin',
  } as any);
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  const outcome = (res.data ?? {}) as { extracted?: unknown; saved?: unknown; skipped?: unknown; costUsd?: unknown };
  return NextResponse.json({
    success: true,
    extracted: outcome.extracted,
    saved: outcome.saved,
    skipped: outcome.skipped,
    costUsd: outcome.costUsd,
  });
});

/**
 * Consolidate API — Phase 4. 대화 → LLM 후처리 → entity/fact/event 자동 추출.
 *
 * POST /api/consolidate { conversationId, owner? }
 *   → { extractedCounts, savedCounts, skipped, costUsd }
 *
 * 어드민 "이 대화 정리하기" 버튼이 호출. AI 도구 (consolidate_conversation) 도 같은 경로.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { withAuth } from '../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => null);
  if (!body?.conversationId) {
    return NextResponse.json({ success: false, error: 'conversationId 필수' }, { status: 400 });
  }
  const outcome = await getCore().consolidateConversation({
    owner: typeof body.owner === 'string' ? body.owner : 'admin',
    convId: String(body.conversationId),
  });
  return NextResponse.json({
    success: true,
    extracted: outcome.extracted,
    saved: outcome.saved,
    skipped: outcome.skipped,
    costUsd: outcome.costUsd,
  });
});

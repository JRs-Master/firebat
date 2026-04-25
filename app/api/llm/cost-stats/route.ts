import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

/** GET /api/llm/cost-stats?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&model=...
 *  LLM 호출 비용 통계 — 일별·모델별 누적. 어드민 통계 탭 + 모니터링 용도.
 *  필터:
 *    - fromDate / toDate: ISO 일자 (사용자 timezone 기준)
 *    - model: 특정 모델만
 *  응답: { totalCalls, totalInputTokens, totalOutputTokens, totalCostUsd, records: [...] }
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const url = req.nextUrl;
  const fromDate = url.searchParams.get('fromDate') ?? undefined;
  const toDate = url.searchParams.get('toDate') ?? undefined;
  const model = url.searchParams.get('model') ?? undefined;

  const stats = getCore().getLlmCostStats({
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
    ...(model ? { model } : {}),
  });
  return NextResponse.json({ success: true, data: stats });
}

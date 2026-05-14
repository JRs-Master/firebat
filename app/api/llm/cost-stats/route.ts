import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getLlmCostStats } from '../../../../lib/api-gen/cost';

/** GET /api/llm/cost-stats?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&model=...
 *  LLM 호출 비용 통계 — 일별·모델별 누적. 어드민 통계 탭 + 모니터링 용도.
 *  필터:
 *    - fromDate / toDate: ISO 일자 (사용자 timezone 기준) → since/until unix ms 변환
 *    - model: 특정 모델만
 *  응답: { totalCalls, totalInputTokens, totalOutputTokens, totalCostUsd, records: [...] }
 */
export const GET = withAuth(async (req: NextRequest) => {
  const url = req.nextUrl;
  const fromDate = url.searchParams.get('fromDate') ?? undefined;
  const toDate = url.searchParams.get('toDate') ?? undefined;
  const model = url.searchParams.get('model') ?? undefined;

  const sinceMs = fromDate ? Date.parse(fromDate) : NaN;
  const untilMs = toDate ? Date.parse(toDate) : NaN;

  const res = await getLlmCostStats({
    ...(Number.isFinite(sinceMs) ? { since: BigInt(sinceMs) } : {}),
    ...(Number.isFinite(untilMs) ? { until: BigInt(untilMs) } : {}),
    ...(model ? { model } : {}),
  });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, data: res.data });
});

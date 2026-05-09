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
  const auth = await requireAuth(req);
  if (isAuthError(auth)) return auth;

  const url = req.nextUrl;
  const fromDate = url.searchParams.get('fromDate') ?? undefined;
  const toDate = url.searchParams.get('toDate') ?? undefined;
  const model = url.searchParams.get('model') ?? undefined;

  const raw = await getCore().getLlmCostStats({
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
    ...(model ? { model } : {}),
  }) as Record<string, unknown>;

  // Rust LlmCostStatsSummary (serde snake_case 박힘) → frontend camelCase 매핑.
  // 옛 TS API 와 frontend 호환 보존 — Rust 측 #[serde(rename_all="camelCase")] 박는 대신
  // route 박힘 변환 박아 frontend / Rust binary 재배포 0.
  const num = (v: unknown) => typeof v === 'number' ? v : 0;
  const data = {
    totalCalls: num(raw.call_count ?? raw.callCount),
    totalInputTokens: num(raw.total_input_tokens ?? raw.totalInputTokens),
    totalOutputTokens: num(raw.total_output_tokens ?? raw.totalOutputTokens),
    totalCachedTokens: num(raw.total_cached_tokens ?? raw.totalCachedTokens),
    totalCostUsd: num(raw.total_cost_usd ?? raw.totalCostUsd),
    // records 박힘 — Rust port 시 누락. graceful 빈 배열 (CostTabContent 박힘 records 의존 폐기 박혀있음).
    records: Array.isArray(raw.records) ? raw.records : [],
  };
  return NextResponse.json({ success: true, data });
}

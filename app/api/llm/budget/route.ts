/**
 * /api/llm/budget — LLM 비용 한도 GET/POST.
 *
 * GET: { dailyUsd, monthlyUsd, alertAtPercent, dailySpent, monthlySpent }
 * POST: body { dailyUsd, monthlyUsd, alertAtPercent } 저장
 *
 * 0 = 무제한. AiManager 가 매 turn 시작 시 Core.checkCostBudget() 호출 → 초과 시 LLM 호출 차단.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { withAuth } from '../../../../lib/with-api-error';

export const GET = withAuth(async () => {
  const core = getCore();
  const budget = await core.getCostBudget();
  const check = await core.checkCostBudget();
  return NextResponse.json({
    success: true,
    data: {
      ...budget,
      dailySpentUsd: check.dailyUsd,
      monthlySpentUsd: check.monthlyUsd,
      dailySpentCalls: check.dailyCalls,
      monthlySpentCalls: check.monthlyCalls,
    },
  });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  await getCore().setCostBudget({
    dailyUsd: Number(body?.dailyUsd) || 0,
    monthlyUsd: Number(body?.monthlyUsd) || 0,
    dailyCalls: Number(body?.dailyCalls) || 0,
    monthlyCalls: Number(body?.monthlyCalls) || 0,
    alertAtPercent: Number(body?.alertAtPercent) || 80,
  });
  return NextResponse.json({ success: true });
});

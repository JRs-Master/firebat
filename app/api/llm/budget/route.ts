/**
 * /api/llm/budget — LLM 비용 한도 GET/POST.
 *
 * GET: { dailyUsd, monthlyUsd, alertAtPercent, dailySpent, monthlySpent }
 * POST: body { dailyUsd, monthlyUsd, alertAtPercent } 저장
 *
 * 0 = 무제한. AiManager 가 매 turn 시작 시 Core.checkCostBudget() 호출 → 초과 시 LLM 호출 차단.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getCostBudget, setCostBudget, checkCostBudget } from '../../../../lib/api-gen/cost';

export const GET = withAuth(async () => {
  const budgetRes = await getCostBudget();
  const checkRes = await checkCostBudget();
  if (!budgetRes.ok) {
    return NextResponse.json({ success: false, error: budgetRes.message }, { status: 500 });
  }
  if (!checkRes.ok) {
    return NextResponse.json({ success: false, error: checkRes.message }, { status: 500 });
  }
  const budget = budgetRes.data;
  const check = checkRes.data;
  return NextResponse.json({
    success: true,
    data: {
      ...budget,
      dailySpentUsd: check.dailyUsedUsd,
      monthlySpentUsd: check.monthlyUsedUsd,
      dailySpentCalls: Number(check.dailyCalls ?? 0n),
      monthlySpentCalls: Number(check.monthlyCalls ?? 0n),
    },
  });
});

export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const res = await setCostBudget({
    dailyUsd: Number(body?.dailyUsd) || 0,
    monthlyUsd: Number(body?.monthlyUsd) || 0,
    dailyCalls: BigInt(Number(body?.dailyCalls) || 0),
    monthlyCalls: BigInt(Number(body?.monthlyCalls) || 0),
    alertAtPercent: BigInt(Number(body?.alertAtPercent) || 80),
  });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
});

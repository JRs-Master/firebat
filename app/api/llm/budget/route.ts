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
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const core = getCore();
  const budget = await core.getCostBudget();
  const check = await core.checkCostBudget();
  return NextResponse.json({
    success: true,
    data: {
      ...budget,
      dailySpent: check.dailyUsd,
      monthlySpent: check.monthlyUsd,
    },
  });
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;
  const body = await req.json();
  const dailyUsd = Number(body?.dailyUsd) || 0;
  const monthlyUsd = Number(body?.monthlyUsd) || 0;
  const alertAtPercent = Number(body?.alertAtPercent) || 80;
  const core = getCore();
  await core.setCostBudget({ dailyUsd, monthlyUsd, alertAtPercent });
  return NextResponse.json({ success: true });
}

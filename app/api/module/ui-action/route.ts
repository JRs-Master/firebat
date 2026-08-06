import { NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { ApiError } from '../../../../lib/api-error';
import { runUiAction } from '../../../../lib/api-gen/module';

/**
 * POST /api/module/ui-action
 *
 * A screen action a person confirmed — the module's `uiOnly` set (liquidation, write-off,
 * position corrections). No model can reach these on any surface; this route is the only door,
 * and admin auth plus the warning dialog the caller already showed is the authorisation.
 *
 * Thin on purpose: Core owns the round trip (module decides → broker calls → ledger records), so
 * the ordering loop never lives in the browser.
 */
export const POST = withAuth(async (req) => {
  const { module: moduleName, action, args } = await req.json();
  if (!moduleName || typeof moduleName !== 'string') {
    throw new ApiError(400, '모듈 이름이 필요합니다.');
  }
  if (!action || typeof action !== 'string') {
    throw new ApiError(400, '실행할 액션이 필요합니다.');
  }
  const res = await runUiAction({
    module: moduleName,
    action,
    argsJson: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  const out = res.data;
  const data = out.dataJson ? JSON.parse(out.dataJson) : undefined;
  return NextResponse.json(
    { success: out.success, data, error: out.error },
    { status: out.success ? 200 : 400 },
  );
});

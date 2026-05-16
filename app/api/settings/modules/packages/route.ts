import { NextRequest, NextResponse } from 'next/server';
import { getPackageStatus, installPackages } from '../../../../../lib/api-gen/module';
import { withAuth } from '../../../../../lib/with-api-error';
import { ApiError } from '../../../../../lib/api-error';

/**
 * GET /api/settings/modules/packages?module=yfinance
 *
 * sysmod 패키지 status — 설정 화면이 polling.
 * 응답: { success, packages: [{ name, status: "installed"|"missing"|"in_progress"|"failed", jobId?, error? }] }
 */
export const GET = withAuth(async (req: NextRequest) => {
  const module = req.nextUrl.searchParams.get('module');
  if (!module) throw new ApiError(400, 'module 파라미터 필요');
  const res = await getPackageStatus({ module });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, packages: res.data ?? [] });
});

/**
 * POST /api/settings/modules/packages — 패키지 install / upgrade.
 *
 * body: { module: string, upgrade?: boolean }
 * 응답: { success, jobIds: string[] } — 새로 시작한 StatusManager job_id 목록.
 *      (이미 설치 / 진행 중 패키지는 빈 배열)
 */
export const POST = withAuth(async (req) => {
  const { module, upgrade } = await req.json();
  if (!module || typeof module !== 'string') throw new ApiError(400, 'module 필요');
  const res = await installPackages({ module, upgrade: Boolean(upgrade) });
  if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  return NextResponse.json({ success: true, jobIds: res.data ?? [] });
});

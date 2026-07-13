/**
 * 로그 조회 / filter API (로그 시스템 Phase 5, 2026-05-21). admin 전용 (withAuth).
 *
 * GET  /api/logs?minLevel=&targetPrefix=&sinceMs=&limit=&contains=  — sqlite ring buffer 조회
 * POST /api/logs  body: { filter }                        — 런타임 EnvFilter reload (SIGHUP 대신)
 *
 * /api/log (단수) 는 별개 — 브라우저 로그 수집 (Phase 2). 본 route 는 admin 조회/제어.
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryLogs, setLogFilter } from '../../../lib/api-gen/log';
import { withAuth } from '../../../lib/with-api-error';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const res = await queryLogs({
    minLevel: sp.get('minLevel') ?? '',
    targetPrefix: sp.get('targetPrefix') ?? '',
    sinceMs: BigInt(Number(sp.get('sinceMs') ?? 0) || 0),
    limit: Number(sp.get('limit') ?? 200) || 200,
    contains: sp.get('contains') ?? '',
  });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  return NextResponse.json({ success: true, entries: res.data ?? [] });
});

export const POST = withAuth(async (req: NextRequest) => {
  const { filter } = await req.json();
  const res = await setLogFilter({ filter: String(filter ?? 'info') });
  if (!res.ok) {
    return NextResponse.json({ success: false, error: res.message }, { status: 500 });
  }
  // setLogFilter 응답 자체 ok/error (filter 파싱 실패 시 ok=false)
  const data = res.data as { ok?: boolean; error?: string } | undefined;
  if (data && data.ok === false) {
    return NextResponse.json({ success: false, error: data.error || 'filter 파싱 실패' }, { status: 400 });
  }
  return NextResponse.json({ success: true });
});

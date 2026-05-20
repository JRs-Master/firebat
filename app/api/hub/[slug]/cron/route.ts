import { NextRequest, NextResponse } from 'next/server';
import { listCron, cancelCron } from '../../../../../lib/api-gen/schedule';
import { authenticate } from '../../../../../lib/api-gen/hub';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/cron — 익명 hub 방문자의 cron 영역 dispatcher.
 *
 * GET    — owner='hub:<instance.id>' 인 cron job 목록 (visitor 가 chat 안 AI 도구로 만든 자기 자료)
 * DELETE ?jobId=... — visitor 자기 cron 만 cancel (owner 매칭 가드)
 *
 * visitor 가 직접 cron 만드는 API 는 X — chat 안 AI 가 자동 owner 주입해 만듦.
 * 인증: X-Api-Token + X-Session-Id.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

async function authHub(req: NextRequest, slug: string): Promise<{ ok: true; instanceId: string } | { ok: false; status: number; error: string }> {
  const apiToken = req.headers.get('x-api-token') ?? '';
  const sessionId = req.headers.get('x-session-id') ?? '';
  const origin = req.headers.get('origin') ?? '';
  const selfHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  if (!apiToken) return { ok: false, status: 401, error: 'X-Api-Token 헤더가 필요합니다.' };
  if (!sessionId) return { ok: false, status: 400, error: 'X-Session-Id 헤더가 필요합니다.' };
  const res = await authenticate({ slug, apiToken, origin, selfHost });
  if (!res.ok) {
    const msg = res.message ?? '인증 실패';
    if (msg.includes('UNAUTHORIZED_ORIGIN:')) return { ok: false, status: 403, error: '허용되지 않은 도메인입니다.' };
    return { ok: false, status: 401, error: msg };
  }
  if (!res.data?.instance) return { ok: false, status: 500, error: 'instance 조회 실패' };
  return { ok: true, instanceId: res.data.instance.id };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  // visitor 별 격리 — owner = `hub:<instance_id>:<session_id>` 매칭.
  const sessionId = req.headers.get('x-session-id') ?? '';
  const expectedOwner = `hub:${auth.instanceId}:${sessionId}`;

  try {
    const jobsRes = await listCron();
    if (!jobsRes.ok) return NextResponse.json({ success: false, error: jobsRes.message }, { status: 500 });
    const jobs = (jobsRes.data ?? []).filter((j: any) => j.owner === expectedOwner);
    return NextResponse.json({ success: true, jobs, logs: [], notifications: [] });
  } catch (err) {
    logger.debug('hub-cron', 'list 실패', { error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  const sessionId = req.headers.get('x-session-id') ?? '';
  const expectedOwner = `hub:${auth.instanceId}:${sessionId}`;

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ success: false, error: 'jobId 필요' }, { status: 400 });

  try {
    // ownership 가드 — list 가져와 본 job 의 owner 매칭 확인.
    const list = await listCron();
    if (!list.ok) return NextResponse.json({ success: false, error: list.message }, { status: 500 });
    const job = (list.data ?? []).find((j: any) => j.jobId === jobId);
    if (!job || (job as any).owner !== expectedOwner) {
      return NextResponse.json({ success: false, error: '이 작업에 접근할 권한이 없습니다.' }, { status: 403 });
    }
    const res = await cancelCron({ jobId });
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.debug('hub-cron', 'cancel 실패', { error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

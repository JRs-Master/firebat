import { NextRequest, NextResponse } from 'next/server';
import { listCron, cancelCron, runNow as runCronNow, updateCron } from '../../../../../lib/api-gen/schedule';
import { resolvePrincipal, isPrincipalError } from '../../../../../lib/principal';
import { logger } from '../../../../../lib/util/logger';

/**
 * /api/hub/[slug]/cron — 익명 hub 방문자의 cron 영역 dispatcher.
 *
 * GET    — owner='hub:<instance.id>:<session.id>' 인 cron job 목록 (visitor 가 chat 안 AI 도구로 만든 자기 자료)
 * DELETE ?jobId=... — visitor 자기 cron 만 cancel (owner 매칭 가드)
 * POST   op='run'   — visitor 자기 cron 만 즉시 실행 (owner 매칭 가드)
 *
 * visitor 가 직접 cron 만드는 API 는 X — chat 안 AI 가 자동 owner 주입해 만듦.
 * 인증: X-Api-Token + X-Session-Id.
 */
export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

async function authHub(
  req: NextRequest,
  slug: string,
): Promise<{ ok: true; instanceId: string } | { ok: false; response: NextResponse }> {
  const principal = await resolvePrincipal(req, slug);
  if (isPrincipalError(principal)) return { ok: false, response: principal };
  return { ok: true, instanceId: principal.hubInstance!.id };
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;
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
  if (!auth.ok) return auth.response;
  const sessionId = req.headers.get('x-session-id') ?? '';
  const expectedOwner = `hub:${auth.instanceId}:${sessionId}`;

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ success: false, error: 'jobId 필요' }, { status: 400 });

  try {
    // owner scoping = Rust core(ScheduleService.cancel_cron → cancel_owned)가 강제 — owner 불일치 시 거부. 프론트 가드 폐기.
    const res = await cancelCron({ jobId, owner: expectedOwner } as any);
    if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.debug('hub-cron', 'cancel 실패', { error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { slug } = await params;
  const auth = await authHub(req, slug);
  if (!auth.ok) return auth.response;
  const sessionId = req.headers.get('x-session-id') ?? '';
  const expectedOwner = `hub:${auth.instanceId}:${sessionId}`;

  let body: Record<string, any> = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'JSON body 필요' }, { status: 400 }); }

  const op = String(body.op ?? '');

  try {
    switch (op) {
      case 'run': {
        const jobId = String(body.jobId ?? '');
        if (!jobId) return NextResponse.json({ success: false, error: 'jobId 가 필요합니다.' }, { status: 400 });
        // owner scoping = Rust core(ScheduleService.runNow → trigger_now_owned)가 강제 — owner 불일치 시 거부.
        const res = await runCronNow({ jobId, owner: expectedOwner } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      case 'update': {
        // 스케줄 편집 — owner scoping = Rust core(ScheduleService.updateCron → update_owned)가 강제(불일치 거부).
        // 잡 owner 자체는 update 가 기존값 보존(편집이 owner 안 바꿈). admin /api/cron PUT 과 동일 인자.
        const { jobId, targetPath, cronTime, runAt, delaySec, startAt, endAt, inputData, pipeline,
          title, description, oneShot, runWhen, retry, notify, executionMode, agentPrompt, showInCalendar } = body;
        if (!jobId) return NextResponse.json({ success: false, error: 'jobId 가 필요합니다.' }, { status: 400 });
        const res = await updateCron({
          jobId,
          targetPath: targetPath || '',
          mode: 'cron',
          cronTime, runAt, delaySec, startAt, endAt,
          inputDataJson: inputData !== undefined ? JSON.stringify(inputData) : undefined,
          pipelineJson: pipeline !== undefined ? JSON.stringify(pipeline) : undefined,
          title, description, oneShot,
          runWhenJson: runWhen !== undefined ? JSON.stringify(runWhen) : undefined,
          retryJson: retry !== undefined ? JSON.stringify(retry) : undefined,
          notifyJson: notify !== undefined ? JSON.stringify(notify) : undefined,
          executionMode, agentPrompt, showInCalendar,
          owner: expectedOwner,
        } as any);
        if (!res.ok) return NextResponse.json({ success: false, error: res.message }, { status: 500 });
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ success: false, error: `지원되지 않는 op: ${op}` }, { status: 400 });
    }
  } catch (err) {
    logger.debug('hub-cron', 'op 실패', { op, error: err });
    return NextResponse.json({ success: false, error: (err as Error)?.message ?? '서버 오류' }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Token, X-Session-Id',
      'Access-Control-Max-Age': '86400',
    },
  });
}

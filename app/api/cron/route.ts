import { NextRequest, NextResponse } from 'next/server';
import {
  runNow,
  listCron,
  getLogs,
  consumeNotifications,
  clearLogs,
  cancelCron,
  updateCron,
} from '../../../lib/api-gen/schedule';
import { withAuth } from '../../../lib/with-api-error';

/** POST /api/cron?action=run&jobId=xxx — 기존 cron 잡 즉시 1회 트리거 */
export const POST = withAuth(async (req: NextRequest) => {
  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'run') return NextResponse.json({ error: '지원하지 않는 action — ?action=run 만 허용' }, { status: 400 });
  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId 필요' }, { status: 400 });
  // fire-and-forget — 긴 LLM 호출 대기 안 함. 클라이언트는 cron-logs SSE 또는 폴링으로 결과 확인
  void runNow({ jobId });
  return NextResponse.json({ success: true, message: '잡 트리거됨. cron-logs 에서 결과 확인.' });
});

/** GET /api/cron — 크론 잡 목록 + 실행 로그 + 페이지 열기 알림 */
export const GET = withAuth(async (req: NextRequest) => {
  const jobsRes = await listCron();
  if (!jobsRes.ok) {
    return NextResponse.json({ error: jobsRes.message }, { status: 500 });
  }
  const logsRes = await getLogs({ limit: 50n });
  if (!logsRes.ok) {
    return NextResponse.json({ error: logsRes.message }, { status: 500 });
  }

  // ?notify=poll → 알림 소비 (조회 후 삭제)
  let notifications: unknown[] = [];
  if (req.nextUrl.searchParams.get('notify') === 'poll') {
    const notifRes = await consumeNotifications();
    if (!notifRes.ok) {
      return NextResponse.json({ error: notifRes.message }, { status: 500 });
    }
    notifications = notifRes.data ?? [];
  }

  return NextResponse.json({
    jobs: jobsRes.data ?? [],
    logs: logsRes.data ?? [],
    notifications,
  });
});

/** DELETE /api/cron?jobId=xxx — 크론 잡 해제, DELETE /api/cron?logs=clear — 로그 전체 삭제 */
export const DELETE = withAuth(async (req: NextRequest) => {
  if (req.nextUrl.searchParams.get('logs') === 'clear') {
    const res = await clearLogs();
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId 필요' }, { status: 400 });

  const res = await cancelCron({ jobId });
  if (!res.ok) {
    const status = res.code === 'NOT_FOUND' ? 404 : 500;
    return NextResponse.json({ error: res.message }, { status });
  }
  return NextResponse.json({ success: true });
});

/** PUT /api/cron — 크론 잡 수정 (해제 후 재등록) */
export const PUT = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const {
    jobId, targetPath, cronTime, runAt, delaySec, startAt, endAt, inputData, pipeline,
    title, description, oneShot, runWhen, retry, notify, executionMode, agentPrompt,
  } = body;
  if (!jobId) {
    return NextResponse.json({ error: 'jobId 필수' }, { status: 400 });
  }

  const res = await updateCron({
    jobId,
    targetPath: targetPath || '',
    mode: 'cron',
    cronTime,
    runAt,
    delaySec,
    startAt,
    endAt,
    inputDataJson: inputData !== undefined ? JSON.stringify(inputData) : undefined,
    pipelineJson: pipeline !== undefined ? JSON.stringify(pipeline) : undefined,
    title,
    description,
    oneShot,
    runWhenJson: runWhen !== undefined ? JSON.stringify(runWhen) : undefined,
    retryJson: retry !== undefined ? JSON.stringify(retry) : undefined,
    notifyJson: notify !== undefined ? JSON.stringify(notify) : undefined,
    executionMode,
    agentPrompt,
  });
  if (!res.ok) {
    const status = res.code === 'INVALID_ARGUMENT' ? 400 : 500;
    return NextResponse.json({ error: res.message }, { status });
  }
  return NextResponse.json({ success: true });
});

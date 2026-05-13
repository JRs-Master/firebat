import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';
import { withAuth } from '../../../lib/with-api-error';

/** POST /api/cron?action=run&jobId=xxx — 기존 cron 잡 즉시 1회 트리거 */
export const POST = withAuth(async (req: NextRequest) => {
  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'run') return NextResponse.json({ error: '지원하지 않는 action — ?action=run 만 허용' }, { status: 400 });
  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId 필요' }, { status: 400 });
  const core = getCore();
  // fire-and-forget — 긴 LLM 호출 대기 안 함. 클라이언트는 cron-logs SSE 또는 폴링으로 결과 확인
  void core.runCronJobNow(jobId);
  return NextResponse.json({ success: true, message: '잡 트리거됨. cron-logs 에서 결과 확인.' });
});

/** GET /api/cron — 크론 잡 목록 + 실행 로그 + 페이지 열기 알림 */
export const GET = withAuth(async (req: NextRequest) => {
  const core = getCore();
  const jobs = await core.listCronJobs();
  const logs = await core.getCronLogs(50);

  // ?notify=poll → 알림 소비 (조회 후 삭제)
  const notifications = req.nextUrl.searchParams.get('notify') === 'poll'
    ? await core.consumeCronNotifications()
    : [];

  return NextResponse.json({ jobs, logs, notifications });
});

/** DELETE /api/cron?jobId=xxx — 크론 잡 해제, DELETE /api/cron?logs=clear — 로그 전체 삭제 */
export const DELETE = withAuth(async (req: NextRequest) => {
  const core = getCore();

  if (req.nextUrl.searchParams.get('logs') === 'clear') {
    await core.clearCronLogs();
    return NextResponse.json({ success: true });
  }

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId 필요' }, { status: 400 });

  const result = await core.cancelCronJob(jobId);
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ success: true });
});

/** PUT /api/cron — 크론 잡 수정 (해제 후 재등록) */
export const PUT = withAuth(async (req: NextRequest) => {
  const body = await req.json();
  const { jobId, targetPath, cronTime, runAt, delaySec, startAt, endAt, inputData, pipeline, title, description, oneShot, runWhen, retry, notify, executionMode, agentPrompt } = body;
  if (!jobId) {
    return NextResponse.json({ error: 'jobId 필수' }, { status: 400 });
  }

  const core = getCore();
  const result = await core.updateCronJob(jobId, targetPath || '', {
    cronTime, runAt, delaySec, startAt, endAt, inputData, pipeline, title, description, oneShot,
    runWhen, retry, notify, executionMode, agentPrompt,
  });
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ success: true });
});

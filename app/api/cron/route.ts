import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../lib/singleton';

/** GET /api/cron — 크론 잡 목록 + 실행 로그 + 페이지 열기 알림 */
export async function GET(req: NextRequest) {
  const core = getCore();
  const jobs = core.listCronJobs();
  const logs = core.getCronLogs(50);

  // ?notify=poll → 알림 소비 (조회 후 삭제)
  const notifications = req.nextUrl.searchParams.get('notify') === 'poll'
    ? core.consumeCronNotifications()
    : [];

  return NextResponse.json({ jobs, logs, notifications });
}

/** DELETE /api/cron?jobId=xxx — 크론 잡 해제, DELETE /api/cron?logs=clear — 로그 전체 삭제 */
export async function DELETE(req: NextRequest) {
  const core = getCore();

  if (req.nextUrl.searchParams.get('logs') === 'clear') {
    core.clearCronLogs();
    return NextResponse.json({ success: true });
  }

  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId 필요' }, { status: 400 });

  const result = await core.cancelCronJob(jobId);
  if (!result.success) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ success: true });
}

/** PUT /api/cron — 크론 잡 수정 (해제 후 재등록) */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { jobId, targetPath, cronTime, runAt, delaySec, startAt, endAt, inputData } = body;
    if (!jobId || !targetPath) {
      return NextResponse.json({ error: 'jobId, targetPath 필수' }, { status: 400 });
    }

    const core = getCore();
    const result = await core.updateCronJob(jobId, targetPath, { cronTime, runAt, delaySec, startAt, endAt, inputData });
    if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { consumePending } from '../../../../lib/pending-tools';

/**
 * POST /api/plan/commit?planId=xxx
 * 사용자가 승인한 pending tool을 실제로 실행.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  const planId = req.nextUrl.searchParams.get('planId') || (await req.json().catch(() => ({}))).planId;
  if (!planId) return NextResponse.json({ success: false, error: 'planId required' }, { status: 400 });

  const pending = consumePending(planId);
  if (!pending) return NextResponse.json({ success: false, error: 'Plan not found or expired' }, { status: 404 });

  const core = getCore();
  try {
    let result: { success: boolean; data?: unknown; error?: string };
    const args = pending.args;

    switch (pending.name) {
      case 'write_file': {
        const { path, content } = args as { path: string; content: string };
        const r = await core.writeFile(path, content);
        result = r.success ? { success: true } : { success: false, error: r.error };
        break;
      }
      case 'save_page': {
        const { slug, spec } = args as { slug: string; spec: Record<string, unknown> };
        const r = await core.savePage(slug, JSON.stringify(spec));
        result = r.success ? { success: true, data: { slug, url: `/${slug}` } } : { success: false, error: r.error };
        break;
      }
      case 'delete_file': {
        const { path } = args as { path: string };
        const r = await core.deleteFile(path);
        result = r.success ? { success: true } : { success: false, error: r.error };
        break;
      }
      case 'delete_page': {
        const { slug } = args as { slug: string };
        const r = await core.deletePage(slug);
        result = r.success ? { success: true } : { success: false, error: r.error };
        break;
      }
      case 'schedule_task': {
        const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const r = await core.scheduleCronJob(jobId, (args.targetPath as string) ?? '', {
          cronTime: args.cronTime as string | undefined,
          runAt: args.runAt as string | undefined,
          delaySec: args.delaySec as number | undefined,
          startAt: args.startAt as string | undefined,
          endAt: args.endAt as string | undefined,
          inputData: args.inputData as Record<string, unknown> | undefined,
          pipeline: args.pipeline as unknown[] as import('../../../../core/ports').PipelineStep[] | undefined,
          title: args.title as string | undefined,
          oneShot: args.oneShot as boolean | undefined,
        });
        result = r.success ? { success: true, data: { jobId } } : { success: false, error: r.error };
        break;
      }
      default:
        result = { success: false, error: `지원하지 않는 도구: ${pending.name}` };
    }

    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

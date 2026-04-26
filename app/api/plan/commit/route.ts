import { NextRequest, NextResponse } from 'next/server';
import { getCore } from '../../../../lib/singleton';
import { requireAuth, isAuthError } from '../../../../lib/auth-guard';
import { consumePending, getPending } from '../../../../lib/pending-tools';

/**
 * POST /api/plan/commit?planId=xxx
 * 사용자가 승인한 pending tool을 실제로 실행.
 * 선택 파라미터:
 *  - action=now (schedule_task용): 예약 시간 무시하고 즉시 실행
 *  - action=reschedule + body.runAt (schedule_task용): 새 시간으로 재예약
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (isAuthError(auth)) return auth;

  // body는 한번만 읽을 수 있으므로 먼저 파싱
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const planId = req.nextUrl.searchParams.get('planId') || (body.planId as string | undefined);
  const action = req.nextUrl.searchParams.get('action') || (body.action as string | undefined) || '';
  const overrideRunAt = (body.runAt as string | undefined) || undefined;
  if (!planId) return NextResponse.json({ success: false, error: 'planId required' }, { status: 400 });

  // 성공 전까지는 consume하지 않음 — 실패 시 재시도 가능
  const pending = getPending(planId);
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
        // spec 타입 검사 제거 — Core.savePage 가 canonicalJson 으로 정규화 (string/object 모두 허용)
        // allowOverwrite=false (기본) 면 slug 충돌 시 자동 -N 접미사 → 기존 페이지 보존
        const { slug, spec, allowOverwrite } = args as { slug: string; spec: Record<string, unknown> | string; allowOverwrite?: boolean };
        const r = await core.savePage(slug, spec, { allowOverwrite: !!allowOverwrite });
        if (!r.success) { result = { success: false, error: r.error }; break; }
        const actualSlug = r.data?.slug ?? slug;
        const renamed = !!r.data?.renamed;
        result = {
          success: true,
          data: {
            slug: actualSlug,
            url: `/${actualSlug}`,
            ...(renamed ? { renamed: true, note: `기존 "${slug}" 보존 → "${actualSlug}" 로 저장` } : {}),
          },
        };
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
        // action 파라미터로 과거 runAt 상황 처리
        let effRunAt = args.runAt as string | undefined;
        let effDelaySec = args.delaySec as number | undefined;
        if (action === 'now') {
          // 즉시 실행: runAt 무시, delaySec 1초
          effRunAt = undefined;
          effDelaySec = 1;
        } else if (action === 'reschedule' && overrideRunAt) {
          // 새 시간으로 재예약
          effRunAt = overrideRunAt;
          effDelaySec = undefined;
        }

        const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const r = await core.scheduleCronJob(jobId, (args.targetPath as string) ?? '', {
          cronTime: args.cronTime as string | undefined,
          runAt: effRunAt,
          delaySec: effDelaySec,
          startAt: args.startAt as string | undefined,
          endAt: args.endAt as string | undefined,
          inputData: args.inputData as Record<string, unknown> | undefined,
          pipeline: args.pipeline as unknown[] as import('../../../../core/ports').PipelineStep[] | undefined,
          title: args.title as string | undefined,
          oneShot: args.oneShot as boolean | undefined,
          runWhen: args.runWhen as import('../../../../core/ports').CronRunWhen | undefined,
          retry: args.retry as import('../../../../core/ports').CronRetry | undefined,
          notify: args.notify as import('../../../../core/ports').CronNotify | undefined,
        });
        // 과거 시각 에러면 consume 하지 않고 사용자에게 선택지 반환
        if (!r.success && r.error?.includes('과거 시각')) {
          return NextResponse.json({
            success: false,
            code: 'PAST_RUNAT',
            error: r.error,
            originalRunAt: args.runAt,
          });
        }
        result = r.success ? { success: true, data: { jobId } } : { success: false, error: r.error };
        break;
      }
      default:
        result = { success: false, error: `지원하지 않는 도구: ${pending.name}` };
    }

    // 성공 시에만 pending 소비 (실패 시 재시도 가능)
    if (result.success) consumePending(planId);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

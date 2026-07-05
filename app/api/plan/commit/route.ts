import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '../../../../lib/with-api-error';
import { getPending, consumePending } from '../../../../lib/api-gen/ai';
import { writeFile, deleteFile } from '../../../../lib/api-gen/storage';
import { savePage, deletePage } from '../../../../lib/api-gen/page';
import { scheduleCronJob, cancelCronJob } from '../../../../lib/api-gen/schedule';
import { run as runModuleRpc } from '../../../../lib/api-gen/module';

/**
 * POST /api/plan/commit?planId=xxx
 * 사용자가 승인한 pending tool을 실제로 실행.
 * 선택 파라미터:
 *  - action=now (schedule_task용): 예약 시간 무시하고 즉시 실행
 *  - action=reschedule + body.runAt (schedule_task용): 새 시간으로 재예약
 */
export const POST = withAuth(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const planId = req.nextUrl.searchParams.get('planId') || (body.planId as string | undefined);
  const action = req.nextUrl.searchParams.get('action') || (body.action as string | undefined) || '';
  const overrideRunAt = (body.runAt as string | undefined) || undefined;
  if (!planId) return NextResponse.json({ success: false, error: 'planId required' }, { status: 400 });

  // 성공 전까지는 consume하지 않음 — 실패 시 재시도 가능
  const pendingRes = await getPending({ planId });
  if (!pendingRes.ok || !pendingRes.data) {
    return NextResponse.json({ success: false, error: 'Plan not found or expired' }, { status: 404 });
  }
  const pending = pendingRes.data as { args?: unknown };

  try {
    let result: { success: boolean; data?: unknown; error?: string };
    // 2026-05-14 A1-full Step 2b: pending.args 가 typed PendingActionArgs tagged enum.
    // discriminator `name` 이 args 안에 있음 (옛 top-level pending.name 폐기).
    const args = pending.args as unknown as Record<string, unknown> & { name: string };

    switch (args.name) {
      case 'run_module': {
        // Approval-gated module action (requiresApproval — real-money orders etc): replay the
        // model's input verbatim through the normal module path.
        const moduleName = args.module as string;
        const input = (args.input as Record<string, unknown>) ?? {};
        const r = await runModuleRpc({ module: moduleName, dataJson: JSON.stringify(input) } as any);
        if (!r.ok) { result = { success: false, error: r.message }; break; }
        const out = r.data as any;
        result = out?.success
          ? { success: true, data: out?.data ?? null }
          : { success: false, error: out?.error || 'module 실행 실패' };
        break;
      }
      case 'write_file': {
        const path = args.path as string;
        const content = args.content as string;
        const r = await writeFile({ path, content });
        result = r.ok ? { success: true } : { success: false, error: r.message };
        break;
      }
      case 'save_page': {
        // spec 타입 검사 제거 — Core.savePage 가 canonicalJson 으로 정규화 (string/object 모두 허용)
        // allowOverwrite=false (기본) 면 slug 충돌 시 자동 -N 접미사 → 기존 페이지 보존
        const slug = args.slug as string;
        const spec = args.spec as Record<string, unknown> | string;
        const specStr = typeof spec === 'string' ? spec : JSON.stringify(spec);
        const r = await savePage({ slug, spec: specStr });
        if (!r.ok) { result = { success: false, error: r.message }; break; }
        const actualSlug = r.data?.slug ?? slug;
        const renamed = actualSlug !== slug;
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
        const path = args.path as string;
        const r = await deleteFile({ path: path });
        result = r.ok ? { success: true } : { success: false, error: r.message };
        break;
      }
      case 'delete_page': {
        const slug = args.slug as string;
        const r = await deletePage({ slug });
        result = r.ok ? { success: true } : { success: false, error: r.message };
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
        const inputData = args.inputData as Record<string, unknown> | undefined;
        const pipeline = args.pipeline as unknown[] | undefined;
        const runWhen = args.runWhen as unknown;
        const retry = args.retry as unknown;
        const notify = args.notify as unknown;
        const r = await scheduleCronJob({
          jobId,
          targetPath: (args.targetPath as string) ?? '',
          mode: 'cron',
          cronTime: args.cronTime as string | undefined,
          runAt: effRunAt,
          delaySec: effDelaySec !== undefined ? BigInt(effDelaySec) : undefined,
          startAt: args.startAt as string | undefined,
          endAt: args.endAt as string | undefined,
          inputDataJson: inputData !== undefined ? JSON.stringify(inputData) : undefined,
          pipelineJson: pipeline !== undefined ? JSON.stringify(pipeline) : undefined,
          title: args.title as string | undefined,
          oneShot: args.oneShot as boolean | undefined,
          runWhenJson: runWhen !== undefined ? JSON.stringify(runWhen) : undefined,
          retryJson: retry !== undefined ? JSON.stringify(retry) : undefined,
          notifyJson: notify !== undefined ? JSON.stringify(notify) : undefined,
          executionMode: args.executionMode as string | undefined,
          agentPrompt: args.agentPrompt as string | undefined,
        });
        // 과거 시각 에러면 consume 하지 않고 사용자에게 선택지 반환
        if (!r.ok && r.message?.includes('과거 시각')) {
          return NextResponse.json({
            success: false,
            code: 'PAST_RUNAT',
            error: r.message,
            originalRunAt: args.runAt,
          });
        }
        result = r.ok ? { success: true, data: { jobId } } : { success: false, error: r.message };
        break;
      }
      case 'cancel_task': {
        const jobId = args.jobId as string;
        const r = await cancelCronJob({ jobId });
        result = r.ok ? { success: true } : { success: false, error: r.message };
        break;
      }
      default:
        result = { success: false, error: `지원하지 않는 도구: ${args.name}` };
    }

    // 성공 시에만 pending 소비 (실패 시 재시도 가능)
    if (result.success) await consumePending({ planId });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
});

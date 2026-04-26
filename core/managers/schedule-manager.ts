import type { FirebatCore } from '../index';
import type { ICronPort, ILogPort, CronScheduleOptions, CronTriggerInfo, CronJobResult, CronRunWhen, CronNotify } from '../ports';
import type { InfraResult } from '../types';
import { resolveFieldPath } from '../utils/path-resolve';
// SSE emit 은 Core 가 담당 — Manager 는 더 이상 eventBus import 불필요

/**
 * Schedule Manager — 크론/예약 CRUD
 *
 * 스케줄링만 담당. 파이프라인 실행은 TaskManager에 위임.
 *
 * 인프라: ICronPort, ILogPort
 * Core 참조: 트리거 시 TaskManager/sandbox 호출
 */
export class ScheduleManager {
  constructor(
    private readonly core: FirebatCore,
    private readonly cron: ICronPort,
    private readonly log: ILogPort,
  ) {
    // 비동기 트리거 콜백도 Core facade 경유 — BIBLE 일관성 (예외 0건)
    this.cron.onTrigger(async (info) => this.core.handleCronTrigger(info));
  }

  // ── 크론 CRUD ──

  async schedule(jobId: string, targetPath: string, opts: CronScheduleOptions): Promise<InfraResult<void>> {
    // targetPath 또는 pipeline 중 하나는 반드시 있어야 함 (빈 스케줄 등록 방지)
    const hasPath = typeof targetPath === 'string' && targetPath.trim() !== '';
    const hasPipeline = Array.isArray(opts.pipeline) && opts.pipeline.length > 0;
    if (!hasPath && !hasPipeline) {
      return { success: false, error: 'schedule_task: targetPath 또는 pipeline 중 하나는 반드시 지정하세요.' };
    }
    // 파이프라인 사전 검증 — TaskManager에 위임
    if (hasPipeline) {
      const err = this.core.validatePipeline(opts.pipeline!);
      if (err) return { success: false, error: err };
    }
    return this.cron.schedule(jobId, targetPath, opts);
  }

  async cancel(jobId: string): Promise<InfraResult<void>> {
    return this.cron.cancel(jobId);
  }

  async update(jobId: string, targetPath: string, opts: CronScheduleOptions): Promise<InfraResult<void>> {
    await this.cron.cancel(jobId);
    return this.cron.schedule(jobId, targetPath, opts);
  }

  list() {
    return this.cron.list();
  }

  getLogs(limit?: number) {
    return this.cron.getLogs(limit);
  }

  clearLogs() {
    this.cron.clearLogs();
  }

  consumeNotifications(): { jobId: string; url: string; triggeredAt: string }[] {
    return this.cron.consumeNotifications();
  }

  // ── 트리거 핸들러 (Core 가 호출, SSE emit 은 Core 가 담당) ──

  async handleTrigger(info: CronTriggerInfo): Promise<CronJobResult> {
    const start = Date.now();

    // ── 1. runWhen 체크 — 미충족 시 정상 종료 (skip) ──
    // 일반 메커니즘: 어떤 조건도 sysmod 호출 결과 + condition 평가로 표현. 휴장일·잔고·부재 모드 등 enumerate X.
    if (info.runWhen) {
      const checkRes = await this.evaluateRunWhen(info.runWhen, info.jobId);
      if (!checkRes.met) {
        this.log.info(`[Cron] runWhen 미충족 → skip: ${info.jobId} (${checkRes.reason})`);
        return {
          jobId: info.jobId, targetPath: info.targetPath, trigger: info.trigger,
          success: true, // skip 은 정상 종료
          durationMs: Date.now() - start,
          output: { skipped: true, reason: checkRes.reason },
        };
      }
    }

    // ── 2. 본 실행 (retry 정책 적용) ──
    const retryCount = Math.max(0, Math.min(5, info.retry?.count ?? 0));
    const retryDelay = info.retry?.delayMs ?? 30000;
    let result: CronJobResult | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      if (attempt > 0) {
        this.log.warn(`[Cron] retry ${attempt}/${retryCount}: ${info.jobId} (${retryDelay}ms 대기)`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
      result = await this.runOnce(info, start);
      if (result.success) break; // 성공 시 retry 종료
    }
    // result 는 위 loop 에서 반드시 채워짐 (attempt=0 부터 실행)
    const finalResult = result!;

    // ── 3. 알림 hook — pipeline 외부 처리 (실패하면 fire-and-forget catch) ──
    if (info.notify) this.fireNotify(info.notify, info, finalResult).catch((e) => {
      this.log.error(`[Cron] notify 발송 실패: ${info.jobId} — ${e.message}`);
    });

    // ── 4. oneShot 자동 취소 ──
    const conditionMet = (finalResult.output as { conditionMet?: boolean } | undefined)?.conditionMet !== false;
    if (finalResult.success && conditionMet && info.oneShot) {
      this.log.info(`[Cron] oneShot 성공 → 자동 취소: ${info.jobId}`);
      await this.cron.cancel(info.jobId);
    }

    return finalResult;
  }

  /** 단일 실행 — pipeline 또는 단일 path 모듈/URL. retry loop 가 호출. */
  private async runOnce(info: CronTriggerInfo, start: number): Promise<CronJobResult> {
    let success = false;
    let error: string | undefined;
    let output: Record<string, unknown> | undefined;
    let stepsTotal: number | undefined;
    let stepsExecuted: number | undefined;

    try {
      // ── agent 모드 — Function Calling 사이클로 위임 ──
      if (info.executionMode === 'agent') {
        const prompt = info.agentPrompt?.trim() || info.title || `Cron job ${info.jobId} 실행`;
        this.log.info(`[Cron] agent 실행: ${info.jobId} (${info.trigger}) — prompt 길이 ${prompt.length}`);
        const res = await this.core.runAgentJob(info.jobId, prompt, info.title);
        success = res.success;
        if (!res.success) error = res.error;
        const actions = res.executedActions ?? [];
        const blockCount = Array.isArray(res.blocks) ? res.blocks.length : 0;
        output = {
          mode: 'agent',
          ...(actions.length > 0 ? { executedActions: actions } : {}),
          ...(blockCount > 0 ? { blockCount } : {}),
          ...(res.reply ? { replyPreview: res.reply.slice(0, 200) } : {}),
        };
      } else if (info.pipeline && info.pipeline.length > 0) {
        stepsTotal = info.pipeline.length;
        this.log.info(`[Cron] 파이프라인 실행: ${info.jobId} (${stepsTotal}단계, ${info.trigger})`);
        let lastDoneIdx = -1;
        const pipeResult = await this.core.runTask(info.pipeline, (idx, status) => {
          if (status === 'done') lastDoneIdx = Math.max(lastDoneIdx, idx);
        });
        stepsExecuted = lastDoneIdx + 1;
        success = pipeResult.success;
        if (!pipeResult.success) error = pipeResult.error;
        output = this.summarizeFinalOutput(info.pipeline, pipeResult.data);
      } else if (info.targetPath.startsWith('/')) {
        this.log.info(`[Cron] 잡 실행: ${info.jobId} → ${info.targetPath} (${info.trigger})`);
        this.cron.appendNotify({ jobId: info.jobId, url: info.targetPath, triggeredAt: new Date().toISOString() });
        success = true;
        output = { notified: info.targetPath };
      } else {
        this.log.info(`[Cron] 잡 실행: ${info.jobId} → ${info.targetPath} (${info.trigger})`);
        const data = info.inputData !== undefined ? info.inputData : { trigger: info.trigger, jobId: info.jobId };
        const res = await this.core.sandboxExecute(info.targetPath, data);
        success = res.success;
        if (!res.success) error = res.error;
        if (res.success) output = { module: info.targetPath };
      }
    } catch (e: any) {
      error = e.message;
    }

    const durationMs = Date.now() - start;
    const outSummary = output ? ` output=${JSON.stringify(output).slice(0, 100)}` : '';
    const stepSummary = stepsTotal != null ? ` steps=${stepsExecuted ?? '?'}/${stepsTotal}` : '';
    this.log[success ? 'info' : 'error'](`[Cron] 잡 ${success ? '완료' : '실패'}: ${info.jobId} (${durationMs}ms)${stepSummary}${outSummary}${error ? ` — ${error}` : ''}`);

    return {
      jobId: info.jobId, targetPath: info.targetPath, trigger: info.trigger,
      success, durationMs, error,
      ...(output ? { output } : {}),
      ...(stepsExecuted != null ? { stepsExecuted } : {}),
      ...(stepsTotal != null ? { stepsTotal } : {}),
    };
  }

  /** runWhen 조건 평가 — sysmod 호출 + condition 비교. 일반 메커니즘. */
  private async evaluateRunWhen(runWhen: CronRunWhen, jobId: string): Promise<{ met: boolean; reason: string }> {
    try {
      const target = await this.core.resolveCallTarget(runWhen.check.sysmod);
      const path = target?.kind === 'execute' ? target.path : `system/modules/${runWhen.check.sysmod}/index.mjs`;
      const inputData = { action: runWhen.check.action, ...(runWhen.check.inputData ?? {}) };
      const res = await this.core.sandboxExecute(path, inputData);
      if (!res.success) return { met: false, reason: `runWhen check 실행 실패: ${res.error}` };

      // 모듈 결과 unwrap — { success, data } wrapper 면 내부 data 사용
      let result: unknown = res.data;
      if (result && typeof result === 'object' && 'success' in result && 'data' in result) {
        result = (result as { data: unknown }).data;
      }

      // field 경로 평가 — '$result.foo' 또는 'foo' 모두 지원, array index OK ($prev.output[0].opnd_yn)
      const fieldPath = runWhen.field.replace(/^\$result\./, '').replace(/^\$prev\./, '');
      const actualValue = resolveFieldPath(result, fieldPath);
      const met = this.evalCondition(actualValue, runWhen.op, runWhen.value);
      const reason = `${runWhen.field} ${runWhen.op} ${runWhen.value ?? ''} → 실제=${JSON.stringify(actualValue)} = ${met}`;
      return { met, reason };
    } catch (e: any) {
      this.log.warn(`[Cron] runWhen 평가 예외: ${jobId} — ${e.message}`);
      return { met: false, reason: `runWhen 평가 예외: ${e.message}` };
    }
  }

  /** 알림 hook 발동 — sysmod 호출. fire-and-forget 으로 본 결과에 영향 X. */
  private async fireNotify(notify: CronNotify, info: CronTriggerInfo, result: CronJobResult): Promise<void> {
    const cfg = result.success ? notify.onSuccess : notify.onError;
    if (!cfg) return;

    const target = await this.core.resolveCallTarget(cfg.sysmod);
    const path = target?.kind === 'execute' ? target.path : `system/modules/${cfg.sysmod}/index.mjs`;

    // template 치환 — {title} {jobId} {error} {duration|durationMs} {output} 일반 placeholder
    const title = info.title ?? info.jobId;
    const tpl = cfg.template ?? (result.success
      ? `✓ ${title} 완료 ({durationMs}ms)`
      : `❌ ${title} 실패: {error}`);
    const text = tpl
      .replace(/\{title\}/g, title)
      .replace(/\{jobId\}/g, info.jobId)
      .replace(/\{error\}/g, result.error ?? '')
      .replace(/\{duration(Ms)?\}/g, String(result.durationMs))
      .replace(/\{output\}/g, result.output ? JSON.stringify(result.output).slice(0, 200) : '');

    const inputData: Record<string, unknown> = { action: 'send-message', text };
    if (cfg.chatId) inputData.chatId = cfg.chatId;
    await this.core.sandboxExecute(path, inputData);
  }

  /** condition 평가 — TaskManager.evaluateCondition 과 같은 동작 (재사용 어려워 inline) */
  private evalCondition(actual: unknown, op: string, expected?: string): boolean {
    if (op === 'exists') return actual !== undefined && actual !== null;
    if (op === 'not_exists') return actual === undefined || actual === null;
    const aStr = String(actual ?? '');
    const eStr = String(expected ?? '');
    const aNum = Number(aStr);
    const eNum = Number(eStr);
    const bothNum = !isNaN(aNum) && !isNaN(eNum);
    switch (op) {
      case '==': return aStr === eStr || (bothNum && aNum === eNum);
      case '!=': return aStr !== eStr && !(bothNum && aNum === eNum);
      case '<':  return bothNum ? aNum <  eNum : aStr <  eStr;
      case '<=': return bothNum ? aNum <= eNum : aStr <= eStr;
      case '>':  return bothNum ? aNum >  eNum : aStr >  eStr;
      case '>=': return bothNum ? aNum >= eNum : aStr >= eStr;
      case 'includes':     return aStr.includes(eStr);
      case 'not_includes': return !aStr.includes(eStr);
      default: return false;
    }
  }

  /** 마지막 step 결과를 의미있는 output 요약으로 변환.
   *  silent failure 추적: cron 잡이 "성공" 했어도 output 가 텍스트뿐이면 → save_page 안 한 의심.
   *  - SAVE_PAGE 마지막: { savedSlug, renamed }
   *  - LLM_TRANSFORM 마지막: { textPreview, length, warning: 'no terminal save_page' }
   *  - EXECUTE 마지막: 모듈 출력 핵심 필드 (예: { url, title } 등)
   *  - CONDITION 미충족: { conditionMet: false }
   */
  private summarizeFinalOutput(pipeline: import('../ports').PipelineStep[], data: unknown): Record<string, unknown> | undefined {
    if (data == null) return undefined;
    const lastStep = pipeline[pipeline.length - 1];
    const lastType = lastStep?.type;

    if (lastType === 'SAVE_PAGE' && data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      return { savedSlug: d.slug, renamed: !!d.renamed };
    }
    if (lastType === 'LLM_TRANSFORM' && typeof data === 'string') {
      return {
        textPreview: data.slice(0, 200),
        length: data.length,
        warning: 'pipeline ends with LLM_TRANSFORM — no actual save_page/sysmod execution. Was this intended?',
      };
    }
    if (lastType === 'CONDITION' && data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (d.conditionMet === false) return { conditionMet: false };
    }
    if (typeof data === 'object' && data !== null) {
      // 일반 EXECUTE/MCP_CALL 결과 → 처음 3개 필드만 추출 (전체는 너무 큼)
      const d = data as Record<string, unknown>;
      const keys = Object.keys(d).slice(0, 5);
      const summary: Record<string, unknown> = {};
      for (const k of keys) {
        const v = d[k];
        summary[k] = typeof v === 'string' ? v.slice(0, 100) : v;
      }
      return summary;
    }
    if (typeof data === 'string') return { text: data.slice(0, 200), length: data.length };
    return { value: data };
  }
}

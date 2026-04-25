import type { FirebatCore } from '../index';
import type { ICronPort, ILogPort, CronScheduleOptions, CronTriggerInfo, CronJobResult } from '../ports';
import type { InfraResult } from '../types';
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
    let success = false;
    let error: string | undefined;
    let conditionMet = true; // CONDITION 스텝 결과 — 조건 미충족 시 false (oneShot 재시도 대기 표시)
    let output: Record<string, unknown> | undefined;
    let stepsTotal: number | undefined;
    let stepsExecuted: number | undefined;

    try {
      if (info.pipeline && info.pipeline.length > 0) {
        stepsTotal = info.pipeline.length;
        // 파이프라인 실행 → TaskManager에 위임
        this.log.info(`[Cron] 파이프라인 실행: ${info.jobId} (${stepsTotal}단계, ${info.trigger})`);
        // 진행도 추적용 콜백 — 마지막 'done' 의 index+1 = stepsExecuted
        let lastDoneIdx = -1;
        const pipeResult = await this.core.runTask(info.pipeline, (idx, status) => {
          if (status === 'done') lastDoneIdx = Math.max(lastDoneIdx, idx);
        });
        stepsExecuted = lastDoneIdx + 1;
        success = pipeResult.success;
        if (!pipeResult.success) error = pipeResult.error;
        // CONDITION 단계에서 미충족이면 data.conditionMet === false
        const d = pipeResult.data as Record<string, unknown> | undefined;
        if (d && d.conditionMet === false) conditionMet = false;
        // 마지막 step 결과 → output 요약 (silent failure 추적 가시화)
        output = this.summarizeFinalOutput(info.pipeline, pipeResult.data);
      } else if (info.targetPath.startsWith('/')) {
        // 페이지 URL → 알림 파일에 기록
        this.log.info(`[Cron] 잡 실행: ${info.jobId} → ${info.targetPath} (${info.trigger})`);
        this.cron.appendNotify({ jobId: info.jobId, url: info.targetPath, triggeredAt: new Date().toISOString() });
        success = true;
        output = { notified: info.targetPath };
      } else {
        // 모듈 실행 — Core 경유 (크로스 도메인)
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

    // oneShot: 조건 충족 + 전체 성공 시 자동 취소 (가격 알림 등 조건부 1회 패턴)
    // CONDITION이 미충족이면 conditionMet=false로 폴링 계속
    if (success && conditionMet && info.oneShot) {
      this.log.info(`[Cron] oneShot 성공 → 자동 취소: ${info.jobId}`);
      await this.cron.cancel(info.jobId);
    }

    // SSE emit 은 Core.handleCronTrigger 에서 담당 (BIBLE 일관성)
    return {
      jobId: info.jobId, targetPath: info.targetPath, trigger: info.trigger,
      success, durationMs, error,
      ...(output ? { output } : {}),
      ...(stepsExecuted != null ? { stepsExecuted } : {}),
      ...(stepsTotal != null ? { stepsTotal } : {}),
    };
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

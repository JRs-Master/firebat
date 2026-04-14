import type { FirebatCore } from '../index';
import type { ICronPort, ILogPort, CronScheduleOptions, CronTriggerInfo, CronJobResult } from '../ports';
import type { InfraResult } from '../types';
import { eventBus } from '../../lib/events';

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
    this.cron.onTrigger(async (info) => this.handleTrigger(info));
  }

  // ── 크론 CRUD ──

  async schedule(jobId: string, targetPath: string, opts: CronScheduleOptions): Promise<InfraResult<void>> {
    // 파이프라인 사전 검증 — TaskManager에 위임
    if (opts.pipeline && opts.pipeline.length > 0) {
      const err = this.core.validatePipeline(opts.pipeline);
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
    return (this.cron as any).getLogs?.(limit) ?? [];
  }

  clearLogs() {
    (this.cron as any).clearLogs?.();
  }

  consumeNotifications(): { jobId: string; url: string; triggeredAt: string }[] {
    return (this.cron as any).consumeNotifications?.() ?? [];
  }

  // ── 트리거 핸들러 ──

  private async handleTrigger(info: CronTriggerInfo): Promise<CronJobResult> {
    const start = Date.now();
    let success = false;
    let error: string | undefined;

    try {
      if (info.pipeline && info.pipeline.length > 0) {
        // 파이프라인 실행 → TaskManager에 위임
        this.log.info(`[Cron] 파이프라인 실행: ${info.jobId} (${info.pipeline.length}단계, ${info.trigger})`);
        const pipeResult = await this.core.runTask(info.pipeline);
        success = pipeResult.success;
        if (!pipeResult.success) error = pipeResult.error;
      } else if (info.targetPath.startsWith('/')) {
        // 페이지 URL → 알림 파일에 기록
        this.log.info(`[Cron] 잡 실행: ${info.jobId} → ${info.targetPath} (${info.trigger})`);
        (this.cron as any).appendNotify?.({ jobId: info.jobId, url: info.targetPath, triggeredAt: new Date().toISOString() });
        success = true;
      } else {
        // 모듈 실행 — Core 경유 (크로스 도메인)
        this.log.info(`[Cron] 잡 실행: ${info.jobId} → ${info.targetPath} (${info.trigger})`);
        const data = info.inputData !== undefined ? info.inputData : { trigger: info.trigger, jobId: info.jobId };
        const res = await this.core.sandboxExecute(info.targetPath, data);
        success = res.success;
        if (!res.success) error = res.error;
      }
    } catch (e: any) {
      error = e.message;
    }

    const durationMs = Date.now() - start;
    this.log[success ? 'info' : 'error'](`[Cron] 잡 ${success ? '완료' : '실패'}: ${info.jobId} (${durationMs}ms)${error ? ` — ${error}` : ''}`);

    // SSE 이벤트
    eventBus.emit({ type: 'cron:complete', data: { jobId: info.jobId, success, durationMs, error } });
    eventBus.emit({ type: 'sidebar:refresh', data: {} });

    return { jobId: info.jobId, targetPath: info.targetPath, trigger: info.trigger, success, durationMs, error };
  }
}

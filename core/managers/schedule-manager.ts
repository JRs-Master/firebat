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

  // ── 트리거 핸들러 ──

  private async handleTrigger(info: CronTriggerInfo): Promise<CronJobResult> {
    const start = Date.now();
    let success = false;
    let error: string | undefined;
    let conditionMet = true; // CONDITION 스텝 결과 — 조건 미충족 시 false (oneShot 재시도 대기 표시)

    try {
      if (info.pipeline && info.pipeline.length > 0) {
        // 파이프라인 실행 → TaskManager에 위임
        this.log.info(`[Cron] 파이프라인 실행: ${info.jobId} (${info.pipeline.length}단계, ${info.trigger})`);
        const pipeResult = await this.core.runTask(info.pipeline);
        success = pipeResult.success;
        if (!pipeResult.success) error = pipeResult.error;
        // CONDITION 단계에서 미충족이면 data.conditionMet === false
        const d = pipeResult.data as { conditionMet?: boolean } | undefined;
        if (d && d.conditionMet === false) conditionMet = false;
      } else if (info.targetPath.startsWith('/')) {
        // 페이지 URL → 알림 파일에 기록
        this.log.info(`[Cron] 잡 실행: ${info.jobId} → ${info.targetPath} (${info.trigger})`);
        this.cron.appendNotify({ jobId: info.jobId, url: info.targetPath, triggeredAt: new Date().toISOString() });
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

    // oneShot: 조건 충족 + 전체 성공 시 자동 취소 (가격 알림 등 조건부 1회 패턴)
    // CONDITION이 미충족이면 conditionMet=false로 폴링 계속
    if (success && conditionMet && info.oneShot) {
      this.log.info(`[Cron] oneShot 성공 → 자동 취소: ${info.jobId}`);
      await this.cron.cancel(info.jobId);
    }

    // SSE 이벤트
    eventBus.emit({ type: 'cron:complete', data: { jobId: info.jobId, success, durationMs, error } });
    eventBus.emit({ type: 'sidebar:refresh', data: {} });

    return { jobId: info.jobId, targetPath: info.targetPath, trigger: info.trigger, success, durationMs, error };
  }
}

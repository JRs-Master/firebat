import type { FirebatCore } from '../index';
import type { ICronPort, ILlmPort, ILogPort, PipelineStep, CronScheduleOptions, CronTriggerInfo, CronJobResult } from '../ports';
import type { InfraResult } from '../types';
import { eventBus } from '../../lib/events';

/**
 * Schedule Manager — 크론 CRUD + 파이프라인 실행 엔진
 *
 * 인프라: ICronPort, ILogPort
 * Core 참조: 파이프라인 크로스 도메인 호출 (sandbox, network, mcp)
 */
export class ScheduleManager {
  constructor(
    private readonly core: FirebatCore,
    private readonly cron: ICronPort,
    private readonly llm: ILlmPort,
    private readonly log: ILogPort,
  ) {
    this.cron.onTrigger(async (info) => this.handleTrigger(info));
  }

  // ── 크론 CRUD ──

  async schedule(jobId: string, targetPath: string, opts: CronScheduleOptions): Promise<InfraResult<void>> {
    // 파이프라인 사전 검증
    if (opts.pipeline && opts.pipeline.length > 0) {
      const err = this.validatePipeline(opts.pipeline);
      if (err) return { success: false, error: err };
    }
    return this.cron.schedule(jobId, targetPath, opts);
  }

  /** 파이프라인 등록 전 필수 필드 검증 */
  private validatePipeline(steps: PipelineStep[]): string | null {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const n = i + 1;
      switch (s.type) {
        case 'TEST_RUN':
          if (!s.path) return `[Step ${n}] TEST_RUN에 path가 없습니다.`;
          break;
        case 'MCP_CALL':
          if (!s.server) return `[Step ${n}] MCP_CALL에 server가 없습니다.`;
          if (!s.tool) return `[Step ${n}] MCP_CALL에 tool이 없습니다.`;
          break;
        case 'NETWORK_REQUEST':
          if (!s.url) return `[Step ${n}] NETWORK_REQUEST에 url이 없습니다.`;
          break;
        case 'LLM_TRANSFORM':
          if (!s.instruction) return `[Step ${n}] LLM_TRANSFORM에 instruction이 없습니다.`;
          break;
        default:
          return `[Step ${n}] 알 수 없는 단계 타입: ${s.type}`;
      }
    }
    return null;
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
        // 파이프라인 기반 실행
        this.log.info(`[Cron] 파이프라인 실행: ${info.jobId} (${info.pipeline.length}단계, ${info.trigger})`);
        const pipeResult = await this.executePipeline(info.pipeline);
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

  // ── 파이프라인 엔진 ──

  /** 파이프라인 단계별 순차 실행 — 이전 단계 결과를 다음 단계에 자동 전달 */
  async executePipeline(steps: PipelineStep[]): Promise<{ success: boolean; data?: any; error?: string }> {
    let prev: any = undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepInput = this.resolvePipelineInput(step, prev);
      this.log.info(`[Pipeline] Step ${i + 1}/${steps.length}: ${step.type}`);

      try {
        switch (step.type) {
          case 'TEST_RUN': {
            if (!step.path) return { success: false, error: `[Pipeline Step ${i + 1}] TEST_RUN에 path가 없습니다.` };
            const res = await this.core.sandboxExecute(step.path, stepInput);
            if (!res.success) return { success: false, error: `[Pipeline Step ${i + 1}] TEST_RUN 실패: ${res.error}` };
            prev = res.data;
            break;
          }
          case 'MCP_CALL': {
            if (!step.server || !step.tool) return { success: false, error: `[Pipeline Step ${i + 1}] MCP_CALL에 server/tool이 없습니다.` };
            const args = step.inputMap ? this.resolveInputMap(step.inputMap, prev) : (step.arguments ?? {});
            const res = await this.core.callMcpTool(step.server, step.tool, args);
            if (!res.success) return { success: false, error: `[Pipeline Step ${i + 1}] MCP_CALL 실패: ${res.error}` };
            prev = res.data;
            break;
          }
          case 'NETWORK_REQUEST': {
            if (!step.url) return { success: false, error: `[Pipeline Step ${i + 1}] NETWORK_REQUEST에 url이 없습니다.` };
            const res = await this.core.networkFetch(step.url, { method: step.method || 'GET', body: step.body, headers: step.headers });
            if (!res.success) return { success: false, error: `[Pipeline Step ${i + 1}] NETWORK_REQUEST 실패: ${res.error}` };
            prev = res.data;
            break;
          }
          case 'LLM_TRANSFORM': {
            if (!step.instruction) return { success: false, error: `[Pipeline Step ${i + 1}] LLM_TRANSFORM에 instruction이 없습니다.` };
            const inputText = typeof prev === 'string' ? prev : JSON.stringify(prev, null, 2);
            const res = await this.llm.askText(`${step.instruction}\n\n${inputText}`, '요청된 작업을 수행하고 결과만 출력하라. 한국어로 답변.');
            if (!res.success) return { success: false, error: `[Pipeline Step ${i + 1}] LLM_TRANSFORM 실패: ${res.error}` };
            prev = res.data;
            break;
          }
          default:
            return { success: false, error: `[Pipeline Step ${i + 1}] 알 수 없는 단계 타입: ${step.type}` };
        }
      } catch (e: any) {
        return { success: false, error: `[Pipeline Step ${i + 1}] 예외: ${e.message}` };
      }
    }

    return { success: true, data: prev };
  }

  /** $prev 치환이 포함된 inputMap 해석 */
  private resolveInputMap(inputMap: Record<string, any>, prev: any): Record<string, any> {
    return this.resolveValue(inputMap, prev);
  }

  /** 파이프라인 단계의 입력 결정: 고정 inputData > inputMap > prev (모두 $prev 치환 적용) */
  private resolvePipelineInput(step: PipelineStep, prev: any): any {
    if (step.inputData !== undefined) return this.resolveValue(step.inputData, prev);
    if (step.inputMap) return this.resolveInputMap(step.inputMap, prev);
    return prev;
  }

  /** 임의의 값에서 $prev 치환 (string, object 재귀) */
  private resolveValue(val: any, prev: any): any {
    if (typeof val === 'string') {
      if (val === '$prev') return typeof prev === 'string' ? prev : JSON.stringify(prev);
      if (val.includes('$prev')) return val.replace(/\$prev/g, typeof prev === 'string' ? prev : JSON.stringify(prev));
      return val;
    }
    if (Array.isArray(val)) return val.map(v => this.resolveValue(v, prev));
    if (val && typeof val === 'object') {
      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) result[k] = this.resolveValue(v, prev);
      return result;
    }
    return val;
  }
}

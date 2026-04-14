import type { FirebatCore } from '../index';
import type { ILlmPort, ILogPort, PipelineStep } from '../ports';

/**
 * Task Manager — 파이프라인 실행 엔진
 *
 * 복합 작업(A → B → C 체이닝)을 즉시 실행.
 * ScheduleManager는 트리거 시 이 매니저에게 위임.
 *
 * 인프라: ILlmPort (LLM_TRANSFORM), ILogPort
 * Core 참조: 크로스 도메인 호출 (sandbox, network, mcp)
 */
export class TaskManager {
  /** 시스템 모듈 capability 캐시 (path → { capability, providerType, allProviders }) */
  private capabilityCache: Map<string, { capability: string; providerType: string }> | null = null;

  constructor(
    private readonly core: FirebatCore,
    private readonly llm: ILlmPort,
    private readonly log: ILogPort,
  ) {}

  /** 파이프라인 등록/실행 전 필수 필드 검증 */
  validatePipeline(steps: PipelineStep[]): string | null {
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

  /** 파이프라인 단계별 순차 실행 — 이전 단계 결과를 다음 단계에 자동 전달 */
  async executePipeline(steps: PipelineStep[]): Promise<{ success: boolean; data?: any; error?: string }> {
    // 사전 검증
    const err = this.validatePipeline(steps);
    if (err) return { success: false, error: err };

    let prev: any = undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepInput = this.resolvePipelineInput(step, prev);
      this.log.info(`[Pipeline] Step ${i + 1}/${steps.length}: ${step.type}`);

      try {
        switch (step.type) {
          case 'TEST_RUN': {
            const res = await this.core.sandboxExecute(step.path!, stepInput);
            if (!res.success) {
              // 실패 시 같은 capability의 대체 provider로 폴백 시도
              const fallbackRes = await this.tryFallbackProvider(step.path!, stepInput);
              if (fallbackRes) {
                prev = fallbackRes.data;
                break;
              }
              return { success: false, error: `[Pipeline Step ${i + 1}] TEST_RUN 실패: ${res.error}` };
            }
            prev = res.data;
            break;
          }
          case 'MCP_CALL': {
            const args = step.inputMap ? this.resolveValue(step.inputMap, prev) : (step.arguments ?? {});
            const res = await this.core.callMcpTool(step.server!, step.tool!, args);
            if (!res.success) return { success: false, error: `[Pipeline Step ${i + 1}] MCP_CALL 실패: ${res.error}` };
            prev = res.data;
            break;
          }
          case 'NETWORK_REQUEST': {
            const res = await this.core.networkFetch(step.url!, { method: step.method || 'GET', body: step.body, headers: step.headers });
            if (!res.success) return { success: false, error: `[Pipeline Step ${i + 1}] NETWORK_REQUEST 실패: ${res.error}` };
            prev = res.data;
            break;
          }
          case 'LLM_TRANSFORM': {
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

  /** TEST_RUN 실패 시 같은 capability의 대체 provider 자동 폴백 */
  private async tryFallbackProvider(failedPath: string, input: any): Promise<{ data: any } | null> {
    const cache = await this.getCapabilityCache();
    const failed = cache.get(failedPath);
    if (!failed?.capability) return null;

    // 같은 capability의 다른 provider 찾기
    const alternatives: string[] = [];
    for (const [path, info] of cache) {
      if (path !== failedPath && info.capability === failed.capability) {
        alternatives.push(path);
      }
    }
    if (alternatives.length === 0) return null;

    for (const altPath of alternatives) {
      this.log.info(`[Pipeline] 폴백 시도: ${failedPath} → ${altPath}`);
      try {
        const res = await this.core.sandboxExecute(altPath, input);
        if (res.success) {
          this.log.info(`[Pipeline] 폴백 성공: ${altPath}`);
          return { data: res.data };
        }
        this.log.warn(`[Pipeline] 폴백 실패: ${altPath} — ${res.error}`);
      } catch (e: any) {
        this.log.warn(`[Pipeline] 폴백 예외: ${altPath} — ${e.message}`);
      }
    }
    return null;
  }

  /** 시스템 모듈 capability 캐시 빌드 (path → capability/providerType) */
  private async getCapabilityCache(): Promise<Map<string, { capability: string; providerType: string }>> {
    if (this.capabilityCache) return this.capabilityCache;

    const cache = new Map<string, { capability: string; providerType: string }>();
    const dirs = await this.core.listDir('system/modules');
    if (!dirs.success || !dirs.data) {
      this.capabilityCache = cache;
      return cache;
    }

    for (const d of dirs.data) {
      if (!d.isDirectory) continue;
      const file = await this.core.readFile(`system/modules/${d.name}/config.json`);
      if (!file.success || !file.data) continue;
      try {
        const m = JSON.parse(file.data);
        if (!m.capability) continue;
        const rt = m.runtime === 'node' ? 'index.mjs' : m.runtime === 'python' ? 'main.py' : 'index.mjs';
        const path = `system/modules/${d.name}/${rt}`;
        cache.set(path, { capability: m.capability, providerType: m.providerType || 'unknown' });
      } catch {}
    }

    this.capabilityCache = cache;
    return cache;
  }

  /** 파이프라인 단계의 입력 결정: 고정 inputData > inputMap > prev (모두 $prev 치환 적용) */
  private resolvePipelineInput(step: PipelineStep, prev: any): any {
    if (step.inputData !== undefined) return this.resolveValue(step.inputData, prev);
    if (step.inputMap) return this.resolveValue(step.inputMap, prev);
    return prev;
  }

  /** 임의의 값에서 $prev 치환 (string, object 재귀) */
  resolveValue(val: any, prev: any): any {
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

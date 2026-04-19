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
        case 'EXECUTE':
          if (!s.path) return `[Step ${n}] EXECUTE에 path가 없습니다.`;
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
        case 'CONDITION':
          if (!s.field) return `[Step ${n}] CONDITION에 field가 없습니다.`;
          if (!s.op) return `[Step ${n}] CONDITION에 op가 없습니다.`;
          break;
        default: {
          const _exhaustive: never = s;
          return `[Step ${n}] 알 수 없는 단계 타입: ${(_exhaustive as PipelineStep).type}`;
        }
      }
    }
    return null;
  }

  /** 파이프라인 단계별 순차 실행 — 이전 단계 결과를 다음 단계에 자동 전달 */
  async executePipeline(steps: PipelineStep[], onPipelineStep?: (index: number, status: 'start' | 'done' | 'error', error?: string) => void): Promise<{ success: boolean; data?: unknown; error?: string }> {
    // 사전 검증
    const err = this.validatePipeline(steps);
    if (err) return { success: false, error: err };

    let prev: unknown = undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const rawInput = this.resolvePipelineInput(step, prev);
      // EXECUTE/MCP_CALL은 Record<string, unknown>이 필요 — 안전하게 변환
      const stepInput: Record<string, unknown> = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
        ? rawInput as Record<string, unknown>
        : rawInput !== undefined ? { data: rawInput } : {};
      const stepDetail = step.type === 'EXECUTE' ? step.path
        : step.type === 'MCP_CALL' ? `${step.server}/${step.tool}`
        : step.type === 'NETWORK_REQUEST' ? step.url
        : step.type === 'LLM_TRANSFORM' ? step.instruction?.slice(0, 60)
        : step.type === 'CONDITION' ? `${step.field} ${step.op} ${step.value ?? ''}`
        : '';
      this.log.info(`[Pipeline] Step ${i + 1}/${steps.length}: ${step.type}${stepDetail ? ` → ${stepDetail}` : ''}`);

      onPipelineStep?.(i, 'start');

      try {
        switch (step.type) {
          case 'EXECUTE': {
            // Capability 모드에 따라 preferred provider로 자동 교체
            const resolvedPath = await this.resolvePreferredProvider(step.path!);
            if (resolvedPath !== step.path) {
              this.log.info(`[Pipeline] Provider 교체: ${step.path} → ${resolvedPath}`);
            }
            const res = await this.core.sandboxExecute(resolvedPath, stepInput);
            if (!res.success) {
              // 실패 시 같은 capability의 대체 provider로 폴백 시도
              const fallbackRes = await this.tryFallbackProvider(resolvedPath, stepInput);
              if (fallbackRes) {
                const fd = fallbackRes.data;
                prev = (fd && typeof fd === 'object' && 'success' in fd && 'data' in fd)
                  ? (fd as Record<string, unknown>).data : fd;
                break;
              }
              onPipelineStep?.(i, 'error', res.error);
              return { success: false, error: `[Pipeline Step ${i + 1}] EXECUTE 실패: ${res.error}` };
            }
            // 모듈 출력이 success: false인 경우 (API 키 누락 등 모듈 레벨 에러)
            if (res.data && typeof res.data === 'object' && 'success' in res.data && res.data.success === false) {
              const moduleErr = (res.data as unknown as Record<string, unknown>).error || JSON.stringify(res.data);
              // 폴백 시도
              const fallbackRes = await this.tryFallbackProvider(resolvedPath, stepInput);
              if (fallbackRes) {
                const fd = fallbackRes.data;
                prev = (fd && typeof fd === 'object' && 'success' in fd && 'data' in fd)
                  ? (fd as Record<string, unknown>).data : fd;
                break;
              }
              onPipelineStep?.(i, 'error', String(moduleErr));
              return { success: false, error: `[Pipeline Step ${i + 1}] 모듈 실행 실패: ${moduleErr}` };
            }
            // 모듈 출력이 {success,data} 래핑된 경우 내부 data만 추출
            prev = (res.data && typeof res.data === 'object' && 'success' in res.data && 'data' in res.data)
              ? res.data.data
              : res.data;

            onPipelineStep?.(i, 'done');
            break;
          }
          case 'MCP_CALL': {
            const args = step.inputMap
              ? this.resolveValue(step.inputMap, prev) as Record<string, unknown>
              : (step.arguments ?? {});
            const res = await this.core.callMcpTool(step.server!, step.tool!, args);
            if (!res.success) { onPipelineStep?.(i, 'error', res.error); return { success: false, error: `[Pipeline Step ${i + 1}] MCP_CALL 실패: ${res.error}` }; }
            prev = res.data;

            onPipelineStep?.(i, 'done');
            break;
          }
          case 'NETWORK_REQUEST': {
            const res = await this.core.networkFetch(step.url!, { method: step.method || 'GET', body: step.body, headers: step.headers });
            if (!res.success) { onPipelineStep?.(i, 'error', res.error); return { success: false, error: `[Pipeline Step ${i + 1}] NETWORK_REQUEST 실패: ${res.error}` }; }
            prev = res.data;

            onPipelineStep?.(i, 'done');
            break;
          }
          case 'LLM_TRANSFORM': {
            const inputText = typeof prev === 'string' ? prev : JSON.stringify(prev, null, 2);
            const res = await this.llm.askText(`${step.instruction}\n\n---\n${inputText}\n---`, `너는 데이터 추출·요약 엔진이다. 아래 구분선(---) 안의 원본만 근거로 응답하라.

절대 규칙:
1) 모든 값(수치·날짜·이름·라벨) 은 원본에 있는 것만 사용. 원본에 없으면 해당 항목 생략 (추측·일반화·보간 금지).
2) 원본 필드의 의미를 임의로 바꾸지 마라. 필드명이 가리키는 의미와 다른 용어로 대체하지 말고, 의미가 불분명하면 원본 필드명을 괄호로 병기.
3) 원본에 시점(날짜·시각·기간) 정보가 있으면 반드시 해당 값 옆에 명시. 언제 기준인지 모호하게 서술 금지.
4) 해석·전망·판단·조언을 추가하지 마라. instruction 이 명시적으로 요청하지 않는 한 원본에 없는 문장 생성 금지.
5) 한국어로 결과만 출력. 도입부·끝말·설명 금지.
6) 원본에 요청 정보가 없으면 "요청하신 정보를 찾을 수 없습니다." 단독 출력.`);
            if (!res.success) { onPipelineStep?.(i, 'error', res.error); return { success: false, error: `[Pipeline Step ${i + 1}] LLM_TRANSFORM 실패: ${res.error}` }; }
            prev = res.data;

            onPipelineStep?.(i, 'done');
            break;
          }
          case 'CONDITION': {
            // $prev에서 field 값 추출
            const fieldVal = this.resolveValue(step.field, prev);
            const met = this.evaluateCondition(fieldVal, step.op, step.value);
            this.log.info(`[Pipeline] CONDITION: ${step.field} ${step.op} ${step.value ?? ''} → ${met}`);

            if (!met) {
              // 조건 미충족 — 에러가 아닌 정상 종료 (나머지 단계 스킵)
              onPipelineStep?.(i, 'done');
              this.log.info(`[Pipeline] 조건 미충족 — 파이프라인 정상 종료 (이후 ${steps.length - i - 1}단계 스킵)`);
              return { success: true, data: { conditionMet: false, field: step.field, op: step.op, value: step.value, actual: fieldVal } };
            }

            onPipelineStep?.(i, 'done');
            // prev 유지 (CONDITION은 데이터를 변환하지 않음)
            break;
          }
          default: {
            const _exhaustive: never = step;
            const unknownType = (_exhaustive as PipelineStep).type;
            onPipelineStep?.(i, 'error', `알 수 없는 단계 타입: ${unknownType}`);
            return { success: false, error: `[Pipeline Step ${i + 1}] 알 수 없는 단계 타입: ${unknownType}` };
          }
        }
      } catch (e: any) {
        onPipelineStep?.(i, 'error', e.message);
        return { success: false, error: `[Pipeline Step ${i + 1}] 예외: ${e.message}` };
      }
    }

    return { success: true, data: prev };
  }

  /** CONDITION 비교 연산 수행 */
  private evaluateCondition(actual: unknown, op: string, expected?: unknown): boolean {
    // 숫자 비교 가능하면 숫자로 변환
    const numActual = Number(actual);
    const numExpected = Number(expected);
    const bothNumeric = !isNaN(numActual) && !isNaN(numExpected) && actual !== '' && actual !== null;

    switch (op) {
      case '==':  return bothNumeric ? numActual === numExpected : String(actual) === String(expected);
      case '!=':  return bothNumeric ? numActual !== numExpected : String(actual) !== String(expected);
      case '<':   return bothNumeric ? numActual < numExpected : false;
      case '<=':  return bothNumeric ? numActual <= numExpected : false;
      case '>':   return bothNumeric ? numActual > numExpected : false;
      case '>=':  return bothNumeric ? numActual >= numExpected : false;
      case 'includes':     return String(actual).includes(String(expected));
      case 'not_includes': return !String(actual).includes(String(expected));
      case 'exists':       return actual !== undefined && actual !== null && actual !== '';
      case 'not_exists':   return actual === undefined || actual === null || actual === '';
      default: return false;
    }
  }

  /** Capability 설정 순서에 따라 preferred provider 경로로 교체 (실행 전) */
  private async resolvePreferredProvider(path: string): Promise<string> {
    const cache = await this.getCapabilityCache();
    const current = cache.get(path);
    if (!current?.capability) return path;

    const settings = this.core.getCapabilitySettings(current.capability);
    if (settings.providers.length === 0) return path; // 순서 미설정이면 그대로

    // 사용자 정의 순서에서 첫 번째로 활성화된 provider 경로 반환
    for (const name of settings.providers) {
      if (!this.core.isModuleEnabled(name)) continue;
      for (const [altPath, info] of cache) {
        if (info.capability === current.capability && altPath !== path) {
          // moduleName 매칭: 경로에서 모듈명 추출
          const pathModName = altPath.split('/').slice(-2, -1)[0];
          if (pathModName === name || info.capability === current.capability) {
            // 첫 번째 우선순위 provider가 현재와 다르면 교체
            if (name !== path.split('/').slice(-2, -1)[0]) {
              const preferred = [...cache.entries()].find(([, i]) => i.capability === current.capability && altPath.includes(name));
              if (preferred) return preferred[0];
            }
          }
        }
      }
    }
    return path;
  }

  /** EXECUTE 실패 시 같은 capability의 대체 provider 자동 폴백 */
  private async tryFallbackProvider(failedPath: string, input: Record<string, unknown>): Promise<{ data: unknown } | null> {
    const cache = await this.getCapabilityCache();
    const failed = cache.get(failedPath);
    if (!failed?.capability) return null;

    // 같은 capability의 다른 provider 찾기 (비활성 모듈 제외)
    const alternatives: { path: string; providerType: string; moduleName: string }[] = [];
    for (const [path, info] of cache) {
      if (path !== failedPath && info.capability === failed.capability) {
        const moduleName = path.split('/').slice(-2, -1)[0];
        if (!this.core.isModuleEnabled(moduleName)) continue;
        alternatives.push({ path, providerType: info.providerType, moduleName });
      }
    }
    if (alternatives.length === 0) return null;

    // 사용자 정의 순서로 정렬
    const settings = this.core.getCapabilitySettings(failed.capability);
    if (settings.providers.length > 0) {
      alternatives.sort((a, b) => {
        const aIdx = settings.providers.indexOf(a.moduleName);
        const bIdx = settings.providers.indexOf(b.moduleName);
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
      });
    }

    for (const alt of alternatives) {
      this.log.info(`[Pipeline] 폴백 시도: ${failedPath} → ${alt.path} (${alt.providerType})`);
      try {
        const res = await this.core.sandboxExecute(alt.path, input);
        if (!res.success) {
          this.log.warn(`[Pipeline] 폴백 실패: ${alt.path} — ${res.error}`);
          continue;
        }
        // 모듈 레벨 실패 체크 (API 키 누락 등)
        if (res.data && typeof res.data === 'object' && 'success' in res.data && res.data.success === false) {
          const moduleErr = (res.data as unknown as Record<string, unknown>).error || '';
          this.log.warn(`[Pipeline] 폴백 모듈 실패: ${alt.path} — ${moduleErr}`);
          continue;
        }
        this.log.info(`[Pipeline] 폴백 성공: ${alt.path}`);
        return { data: res.data };
      } catch (e: any) {
        this.log.warn(`[Pipeline] 폴백 예외: ${alt.path} — ${e.message}`);
      }
    }
    return null;
  }

  /** 모듈 capability 캐시 빌드 — system/modules + user/modules 전체 스캔 */
  private async getCapabilityCache(): Promise<Map<string, { capability: string; providerType: string }>> {
    if (this.capabilityCache) return this.capabilityCache;

    const cache = new Map<string, { capability: string; providerType: string }>();
    const bases = ['system/modules', 'user/modules'];

    for (const base of bases) {
      const dirs = await this.core.listDir(base);
      if (!dirs.success || !dirs.data) continue;

      for (const d of dirs.data) {
        if (!d.isDirectory) continue;
        const file = await this.core.readFile(`${base}/${d.name}/config.json`);
        if (!file.success || !file.data) continue;
        try {
          const m = JSON.parse(file.data);
          if (!m.capability) continue;
          const rt = m.runtime === 'node' ? 'index.mjs' : m.runtime === 'python' ? 'main.py' : 'index.mjs';
          const path = `${base}/${d.name}/${rt}`;
          cache.set(path, { capability: m.capability, providerType: m.providerType || 'unknown' });
        } catch {}
      }
    }

    this.capabilityCache = cache;
    return cache;
  }

  /** 파이프라인 단계의 입력 결정: inputData(고정값) + inputMap($prev 매핑) 병합, 둘 다 $prev 치환 적용.
   *  inputMap이 inputData의 동일 키를 덮어쓴다 (매핑이 우선). */
  private resolvePipelineInput(step: PipelineStep, prev: unknown): Record<string, unknown> | unknown {
    if (step.type === 'CONDITION') return prev; // CONDITION은 입력 변환 없음
    const hasData = step.inputData !== undefined;
    const hasMap = !!step.inputMap;
    if (hasData && hasMap) {
      const fromData = this.resolveValue(step.inputData, prev);
      const fromMap = this.resolveValue(step.inputMap, prev);
      if (fromData && typeof fromData === 'object' && !Array.isArray(fromData) && fromMap && typeof fromMap === 'object' && !Array.isArray(fromMap)) {
        return { ...(fromData as Record<string, unknown>), ...(fromMap as Record<string, unknown>) };
      }
      return fromData; // 객체가 아니면 inputData 우선 유지
    }
    if (hasData) return this.resolveValue(step.inputData, prev);
    if (hasMap) return this.resolveValue(step.inputMap, prev);
    return prev;
  }

  /** 임의의 값에서 $prev / $prev.key 치환 (string, object 재귀) */
  resolveValue(val: unknown, prev: unknown): unknown {
    if (typeof val === 'string') {
      if (val === '$prev') return typeof prev === 'string' ? prev : JSON.stringify(prev);
      // $prev.key 속성 접근 (예: $prev.url, $prev.title)
      const propMatch = val.match(/^\$prev\.(\w+)$/);
      if (propMatch) {
        const key = propMatch[1];
        if (prev && typeof prev === 'object' && key in prev) return (prev as Record<string, unknown>)[key];
        return val; // 속성이 없으면 원본 유지
      }
      // 문자열 내 $prev.key 및 $prev 치환
      if (val.includes('$prev')) {
        let result = val.replace(/\$prev\.(\w+)/g, (_: string, key: string) => {
          if (prev && typeof prev === 'object' && key in prev) return String((prev as Record<string, unknown>)[key]);
          return `$prev.${key}`;
        });
        result = result.replace(/\$prev/g, typeof prev === 'string' ? prev : JSON.stringify(prev));
        return result;
      }
      return val;
    }
    if (Array.isArray(val)) return val.map(v => this.resolveValue(v, prev));
    if (val && typeof val === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) result[k] = this.resolveValue(v, prev);
      return result;
    }
    return val;
  }
}

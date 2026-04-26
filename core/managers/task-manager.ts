import type { FirebatCore } from '../index';
import type { ILlmPort, ILogPort, PipelineStep } from '../ports';
import { resolveFieldPath } from '../utils/path-resolve';
import { evaluateCondition as evaluateConditionUtil } from '../utils/condition';

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
    // LLM_TRANSFORM instruction 안에 도구 호출 패턴이 보이면 거부 — 흔한 설계 실수
    // (사용자가 instruction 에 "1) sysmod_kiwoom 호출 2) save_page" 같은 워크플로우를 적어도
    //  LLM_TRANSFORM 은 askText 만 호출하므로 실제 도구는 안 돌아감)
    const TOOL_HINTS = [
      'sysmod_', 'save_page', 'savePage', 'image_gen', 'imageGen', 'mcp_call', 'mcpCall',
      'schedule_task', 'run_task', 'write_file', 'delete_file', 'render_',
    ];
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
        case 'LLM_TRANSFORM': {
          if (!s.instruction) return `[Step ${n}] LLM_TRANSFORM에 instruction이 없습니다.`;
          // instruction 안에 도구 이름이 포함되어 있으면 단계 분리 안 된 것 — 거부
          const lower = s.instruction.toLowerCase();
          for (const hint of TOOL_HINTS) {
            if (lower.includes(hint.toLowerCase())) {
              return `[Step ${n}] LLM_TRANSFORM instruction 안에 도구명 "${hint}" 이 보입니다. LLM_TRANSFORM 은 텍스트 변환만 가능합니다 — 도구 호출은 별도 EXECUTE/MCP_CALL/SAVE_PAGE step 으로 분리하세요.`;
            }
          }
          break;
        }
        case 'CONDITION':
          if (!s.field) return `[Step ${n}] CONDITION에 field가 없습니다.`;
          if (!s.op) return `[Step ${n}] CONDITION에 op가 없습니다.`;
          break;
        case 'SAVE_PAGE':
          if (!s.slug && !s.inputMap?.slug) {
            return `[Step ${n}] SAVE_PAGE에 slug 가 없습니다 (직접 지정 또는 inputMap.slug 로 매핑 필요).`;
          }
          if (!s.spec && !s.inputMap?.spec) {
            return `[Step ${n}] SAVE_PAGE에 spec 이 없습니다 (직접 지정 또는 inputMap.spec 로 매핑 필요 — 보통 직전 LLM_TRANSFORM 결과를 매핑).`;
          }
          break;
        case 'TOOL_CALL':
          if (!s.tool || typeof s.tool !== 'string' || !s.tool.trim()) {
            return `[Step ${n}] TOOL_CALL에 tool 이름이 없습니다 (예: "image_gen", "search_history").`;
          }
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
  async executePipeline(
    steps: PipelineStep[],
    onPipelineStep?: (index: number, status: 'start' | 'done' | 'error' | 'progress', error?: string, subUpdate?: { progress?: number; message?: string }) => void,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    // 사전 검증
    const err = this.validatePipeline(steps);
    if (err) return { success: false, error: err };

    let prev: unknown = undefined;
    /** 모든 step 결과 누적 — $stepN 참조용. LLM_TRANSFORM 이 inputMap 미명시 시 모든 누적 결과 받음 (다중 EXECUTE 결과 환각 방지). */
    const stepResults: unknown[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const rawInput = this.resolvePipelineInput(step, prev, stepResults);
      // EXECUTE/MCP_CALL은 Record<string, unknown>이 필요 — 안전하게 변환
      const stepInput: Record<string, unknown> = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
        ? rawInput as Record<string, unknown>
        : rawInput !== undefined ? { data: rawInput } : {};
      const stepDetail = step.type === 'EXECUTE' ? step.path
        : step.type === 'MCP_CALL' ? `${step.server}/${step.tool}`
        : step.type === 'NETWORK_REQUEST' ? step.url
        : step.type === 'LLM_TRANSFORM' ? step.instruction?.slice(0, 60)
        : step.type === 'CONDITION' ? `${step.field} ${step.op} ${step.value ?? ''}`
        : step.type === 'TOOL_CALL' ? step.tool
        : '';
      this.log.info(`[Pipeline] Step ${i + 1}/${steps.length}: ${step.type}${stepDetail ? ` → ${stepDetail}` : ''}`);
      // 입력 가시화 (500자) — 어느 종목·파라미터로 호출됐는지 디버깅 가능
      try {
        const inputPreview = JSON.stringify(stepInput).slice(0, 500);
        this.log.info(`[Pipeline] Step ${i + 1} input: ${inputPreview}`);
      } catch {}

      onPipelineStep?.(i, 'start');

      try {
        switch (step.type) {
          case 'EXECUTE': {
            // path 가 full path 가 아니고 bare name (예: 'kakao-talk', 'sysmod_kiwoom') 이면 resolver 로 정규화
            let stepPath = step.path!;
            if (!stepPath.includes('/')) {
              const target = await this.core.resolveCallTarget(stepPath);
              if (target?.kind === 'execute') {
                this.log.info(`[Pipeline] Step ${i + 1} EXECUTE '${stepPath}' → '${target.path}' 자동 정규화`);
                stepPath = target.path;
              }
            }
            // Capability 모드에 따라 preferred provider로 자동 교체
            const resolvedPath = await this.resolvePreferredProvider(stepPath);
            if (resolvedPath !== step.path) {
              this.log.info(`[Pipeline] Provider 교체: ${step.path} → ${resolvedPath}`);
            }
            const res = await this.core.sandboxExecute(resolvedPath, stepInput, {
              // 모듈 stdout 의 [STATUS] 라인 → caller (Core.runTask) 의 wrappedCallback 으로 forward
              // → pipeline status job 의 message·progress 갱신
              onProgress: (update) => onPipelineStep?.(i, 'progress', undefined, update),
            });
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
            try {
              this.log.info(`[Pipeline] Step ${i + 1} output: ${JSON.stringify(prev).slice(0, 500)}`);
            } catch {}

            onPipelineStep?.(i, 'done');
            break;
          }
          case 'MCP_CALL': {
            const args = step.inputMap
              ? this.resolveValue(step.inputMap, prev) as Record<string, unknown>
              : (step.arguments ?? {});
            // 통합 resolver — server 명이 system/user module 과 매칭되면 EXECUTE 로 자동 변환
            const target = await this.core.resolveCallTarget(step.server || '');
            if (target?.kind === 'execute') {
              this.log.info(`[Pipeline] Step ${i + 1} MCP_CALL '${step.server}' → module 자동 변환 → EXECUTE ${target.path}`);
              const inputData = step.inputData
                ? this.resolveValue(step.inputData, prev) as Record<string, unknown>
                : args;
              const exRes = await this.core.sandboxExecute(target.path, inputData);
              if (!exRes.success) { onPipelineStep?.(i, 'error', exRes.error); return { success: false, error: `[Pipeline Step ${i + 1}] EXECUTE (MCP_CALL fallback) 실패: ${exRes.error}` }; }
              const d = exRes.data as Record<string, unknown> | undefined;
              prev = d && 'success' in d && 'data' in d ? d.data : d;
              onPipelineStep?.(i, 'done');
              break;
            }
            // target?.kind === 'mcp' 또는 resolver 가 못 찾으면 기존 MCP 호출 경로
            const serverName = target?.kind === 'mcp' ? target.server : step.server!;
            const res = await this.core.callMcpTool(serverName, step.tool!, args);
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
            // inputMap / inputData 명시되면 그 결과만 사용 (advanced — 특정 step 결과 매핑 가능).
            // 미명시 시 모든 누적 step 결과를 context 로 — 다중 EXECUTE 결과 환각 방지.
            const hasExplicitInput = !!(step.inputMap || step.inputData);
            let inputText: string;
            if (hasExplicitInput) {
              inputText = typeof stepInput === 'string' ? stepInput : JSON.stringify(stepInput, null, 2);
            } else if (stepResults.length === 0) {
              inputText = '(이전 step 결과 없음)';
            } else {
              // 각 step 결과를 라벨링 + 1500자 trim. LLM 토큰 폭증 방지하면서 모든 데이터 노출.
              inputText = stepResults.map((r, idx) => {
                const text = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
                const trimmed = text.length > 1500 ? text.slice(0, 1500) + '...(생략)' : text;
                return `[Step ${idx + 1} 결과]\n${trimmed}`;
              }).join('\n\n');
            }
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
          case 'TOOL_CALL': {
            // 도구 직접 호출 — Function Calling 도구 (image_gen / search_history / search_media / render_*)
            // 를 pipeline 안에서 실행. EXECUTE 가 모듈 (sandbox 코드) 호출이라면 TOOL_CALL 은 도구 (Core 함수) 호출.
            // 사용 시점: cron 자동 발행에서 image_gen 으로 새 이미지 매번 생성 등.
            const toolName = step.tool;
            const result = await this.core.executeTool(toolName, stepInput, {});
            if (result.success === false) {
              const errMsg = (result.error as string) || '도구 호출 실패';
              onPipelineStep?.(i, 'error', errMsg);
              return { success: false, error: `[Pipeline Step ${i + 1}] TOOL_CALL ${toolName} 실패: ${errMsg}` };
            }
            // 결과 가시화 (500자 슬라이스)
            try {
              const outputPreview = JSON.stringify(result).slice(0, 500);
              this.log.info(`[Pipeline] Step ${i + 1} TOOL_CALL ${toolName} output: ${outputPreview}`);
            } catch {}
            // 결과를 다음 step 의 $prev 로 전달. result.success 는 떼서 data 만 — 일반 EXECUTE 와 일관.
            const dataOnly: Record<string, unknown> = { ...result };
            delete dataOnly.success;
            prev = Object.keys(dataOnly).length === 1 && 'data' in dataOnly ? dataOnly.data : dataOnly;
            onPipelineStep?.(i, 'done');
            break;
          }
          case 'SAVE_PAGE': {
            // pipeline 등록 시점에 사용자가 전체 흐름을 승인했으므로 저장 시점 재승인 게이트 우회.
            // slug / spec 은 step 직접 명시 또는 inputData/inputMap 으로 prev 매핑 → stepInput 에 이미 해석됨.
            // step.slug 도 $stepN/$prev 패턴 가능 — resolveValue 통과시켜 동적 slug 지원
            const resolvedStepSlug = step.slug ? this.resolveValue(step.slug, prev, stepResults) as string : undefined;
            const slug = (stepInput.slug as string | undefined) ?? resolvedStepSlug;
            let spec: unknown = stepInput.spec ?? step.spec;
            // spec 이 LLM_TRANSFORM 결과 텍스트(JSON 문자열)인 경우 파싱
            if (typeof spec === 'string') {
              try { spec = JSON.parse(spec); }
              catch {
                // JSON 파싱 실패 — body Html 한 덩어리로 fallback (LLM 이 HTML 본문 생성한 경우)
                spec = { body: [{ type: 'Html', props: { content: spec } }] };
              }
            }
            if (!slug || !spec) {
              const errMsg = `slug 또는 spec 미지정 (slug=${slug}, spec=${spec ? '있음' : '없음'})`;
              onPipelineStep?.(i, 'error', errMsg);
              return { success: false, error: `[Pipeline Step ${i + 1}] SAVE_PAGE 실패: ${errMsg}` };
            }
            const allowOverwrite = !!(step.allowOverwrite ?? stepInput.allowOverwrite);
            const res = await this.core.savePage(slug, spec as Record<string, unknown>, { allowOverwrite });
            if (!res.success) {
              onPipelineStep?.(i, 'error', res.error);
              return { success: false, error: `[Pipeline Step ${i + 1}] SAVE_PAGE 실패: ${res.error}` };
            }
            const actualSlug = res.data?.slug ?? slug;
            this.log.info(`[Pipeline] Step ${i + 1} SAVE_PAGE → slug=${actualSlug} (renamed=${!!res.data?.renamed})`);
            prev = { slug: actualSlug, renamed: !!res.data?.renamed };
            onPipelineStep?.(i, 'done');
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
      // step 결과 누적 — $stepN 참조 + LLM_TRANSFORM 의 누적 context 용
      stepResults.push(prev);
    }

    return { success: true, data: prev };
  }

  /** CONDITION 비교 — `core/utils/condition.ts` 의 단일 source 호출.
   *  schedule-manager.ts 도 동일 헬퍼 사용 (이전엔 inline 중복 구현이라 미묘한 동작 차이 있었음). */
  private evaluateCondition(actual: unknown, op: string, expected?: unknown): boolean {
    return evaluateConditionUtil(actual, op, expected);
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

  /** 파이프라인 단계의 입력 결정: inputData(고정값) + inputMap($prev/$stepN 매핑) 병합, 둘 다 치환 적용.
   *  inputMap이 inputData의 동일 키를 덮어쓴다 (매핑이 우선). */
  private resolvePipelineInput(step: PipelineStep, prev: unknown, stepResults?: unknown[]): Record<string, unknown> | unknown {
    if (step.type === 'CONDITION') return prev; // CONDITION은 입력 변환 없음
    const hasData = step.inputData !== undefined;
    const hasMap = !!step.inputMap;
    if (hasData && hasMap) {
      const fromData = this.resolveValue(step.inputData, prev, stepResults);
      const fromMap = this.resolveValue(step.inputMap, prev, stepResults);
      if (fromData && typeof fromData === 'object' && !Array.isArray(fromData) && fromMap && typeof fromMap === 'object' && !Array.isArray(fromMap)) {
        return { ...(fromData as Record<string, unknown>), ...(fromMap as Record<string, unknown>) };
      }
      return fromData;
    }
    if (hasData) return this.resolveValue(step.inputData, prev, stepResults);
    if (hasMap) return this.resolveValue(step.inputMap, prev, stepResults);
    return prev;
  }

  /** 임의의 값에서 $prev / $prev.key / $stepN / $stepN.key 치환 (string, object 재귀)
   *  stepResults 미전달 시 $stepN 패턴은 원본 유지 (backward compat). */
  resolveValue(val: unknown, prev: unknown, stepResults?: unknown[]): unknown {
    const getStepResult = (idx: number): unknown => {
      if (!stepResults || idx < 0 || idx >= stepResults.length) return undefined;
      return stepResults[idx];
    };
    if (typeof val === 'string') {
      // path 문자 집합 — 단어, 점, 대괄호 인덱스, 음수
      // 예: output[0].opnd_yn, foo.bar, items[-1].id
      const PATH_CHARS = '[\\w.\\[\\]\\-]+';
      // $stepN — 정확 매치 (전체 string 이 단일 reference)
      const stepExact = val.match(/^\$step(\d+)$/);
      if (stepExact) {
        const result = getStepResult(parseInt(stepExact[1], 10));
        if (result === undefined) return val;
        return result; // 객체 그대로 반환 (object accept 하는 inputMap 용)
      }
      // $stepN.path — 정확 매치 (속성 접근, array index 지원)
      const stepProp = val.match(new RegExp(`^\\$step(\\d+)\\.(${PATH_CHARS})$`));
      if (stepProp) {
        const result = getStepResult(parseInt(stepProp[1], 10));
        const path = stepProp[2];
        const v = resolveFieldPath(result, path);
        if (v !== undefined) return v; // 객체·배열·primitive 모두 그대로 반환
        if (typeof result === 'string') return result;
        return val;
      }
      if (val === '$prev') return typeof prev === 'string' ? prev : JSON.stringify(prev);
      // $prev.path 속성 접근 (예: $prev.url, $prev.output[0].opnd_yn)
      const propMatch = val.match(new RegExp(`^\\$prev\\.(${PATH_CHARS})$`));
      if (propMatch) {
        const v = resolveFieldPath(prev, propMatch[1]);
        if (v !== undefined) return v;
        if (typeof prev === 'string') return prev;
        return val;
      }
      // 문자열 내 $prev.path / $prev / $stepN.path / $stepN 치환
      if (val.includes('$prev') || val.includes('$step')) {
        let result = val;
        const toStr = (v: unknown): string => v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
        // $stepN.path 치환
        result = result.replace(new RegExp(`\\$step(\\d+)\\.(${PATH_CHARS})`, 'g'), (_: string, idx: string, path: string) => {
          const r = getStepResult(parseInt(idx, 10));
          const v = resolveFieldPath(r, path);
          if (v !== undefined) return toStr(v);
          if (typeof r === 'string') return r;
          return `$step${idx}.${path}`;
        });
        // $stepN 단독 치환
        result = result.replace(/\$step(\d+)(?!\.[\w\[])/g, (_: string, idx: string) => {
          const r = getStepResult(parseInt(idx, 10));
          if (r === undefined) return `$step${idx}`;
          return typeof r === 'string' ? r : JSON.stringify(r);
        });
        // $prev.path 치환
        result = result.replace(new RegExp(`\\$prev\\.(${PATH_CHARS})`, 'g'), (_: string, path: string) => {
          const v = resolveFieldPath(prev, path);
          if (v !== undefined) return toStr(v);
          if (typeof prev === 'string') return prev;
          return `$prev.${path}`;
        });
        // 단독 $prev 만 치환 — preserve 한 "$prev.missing" 의 $prev 부분 덮어쓰기 방지.
        result = result.replace(/\$prev(?!\.[\w\[])/g, typeof prev === 'string' ? prev : JSON.stringify(prev));
        return result;
      }
      return val;
    }
    if (Array.isArray(val)) return val.map(v => this.resolveValue(v, prev, stepResults));
    if (val && typeof val === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) result[k] = this.resolveValue(v, prev, stepResults);
      return result;
    }
    return val;
  }
}

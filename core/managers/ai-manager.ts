import type { FirebatCore, AiRequestOpts } from '../index';
import type { ILlmPort, ILogPort, LlmCallOpts, LlmChunk, ChatMessage, PageListItem, ToolDefinition, JsonSchema, ToolCall, ToolResult, ToolExchangeEntry } from '../ports';
import { FirebatPlanSchema, FirebatPlan, FirebatAction, CoreResult, type InfraResult } from '../types';

/** Vertex AI Function Calling은 enum 값이 반드시 string이어야 함 — 재귀 변환 */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return schema;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'enum' && Array.isArray(v)) {
      result[k] = v.map(e => String(e));
    } else if (Array.isArray(v)) {
      result[k] = v.map(e => (e && typeof e === 'object' ? sanitizeSchema(e as Record<string, unknown>) : e));
    } else if (v && typeof v === 'object') {
      result[k] = sanitizeSchema(v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * AI Manager — 창작자
 *
 * 역할:
 *   - 파이어뱃 위에서 돌아가는 모듈과 앱을 생성/수정/디버깅한다.
 *   - 시스템 내부(core/, infra/, app/admin/, app/api/)는 절대 건드리지 않는다.
 *
 * 인프라: ILlmPort (자체 도메인), ILogPort (횡단 관심사)
 * Core 참조: 크로스 도메인 호출 (storage, page, cron, vault, mcp 등)
 */
export class AiManager {
  /** sysmod_{name} → 모듈 경로 매핑 (buildToolDefinitions에서 채움) */
  private readonly _sysmodPaths = new Map<string, string>();

  /** 시스템 컨텍스트 캐시 (60초 TTL) */
  private _ctxCache: { text: string; ts: number; isDemo: boolean } | null = null;
  private static readonly CTX_CACHE_TTL = 60_000;

  /** 도구 정의 캐시 (60초 TTL) */
  private _toolsCache: { tools: ToolDefinition[]; ts: number; isDemo: boolean } | null = null;
  private static readonly TOOLS_CACHE_TTL = 60_000;

  constructor(
    private readonly core: FirebatCore,
    private readonly llm: ILlmPort,
    private readonly logger: ILogPort,
  ) {}

  private compressHistory(history: ChatMessage[]): { recentHistory: ChatMessage[]; contextSummary: string } {
    const WINDOW_SIZE = 5;
    if (history.length <= WINDOW_SIZE) return { recentHistory: history, contextSummary: '' };

    const older = history.slice(0, history.length - WINDOW_SIZE);
    const recentHistory = history.slice(history.length - WINDOW_SIZE);
    const contextSummary = `[이전 대화 맥락 (${older.length}개)]\n` +
      older.map(h => {
        const role = h.role === 'user' ? '사용자' : 'AI';
        const raw = typeof h.content === 'string' ? h.content : JSON.stringify(h);
        return `[${role}]: ${raw.slice(0, 120)}${raw.length > 120 ? '...' : ''}`;
      }).join('\n');

    return { recentHistory, contextSummary };
  }

  private async gatherSystemContext(isDemo = false): Promise<string> {
    // 캐시 히트 시 바로 반환 (60초 TTL)
    if (this._ctxCache && this._ctxCache.isDemo === isDemo && (Date.now() - this._ctxCache.ts) < AiManager.CTX_CACHE_TTL) {
      return this._ctxCache.text;
    }
    const lines: string[] = [];
    const userModules = await this.core.listDir('user/modules');
    if (userModules.success && userModules.data) {
      const names = userModules.data.filter(e => e.isDirectory).map(e => e.name);
      lines.push(`[사용자 모듈] ${names.length > 0 ? names.join(', ') : '없음'}`);
    }
    const sysModules = await this.core.listDir('system/modules');
    if (sysModules.success && sysModules.data) {
      const dirs = sysModules.data.filter(e => e.isDirectory);
      if (dirs.length === 0) {
        lines.push(`[시스템 모듈] 없음`);
      } else {
        // 모듈 정보 수집
        const allMods: Array<{ name: string; path: string; capability?: string; providerType?: string; description: string; inputDesc: string; outputDesc: string }> = [];
        for (const d of dirs) {
          const file = await this.core.readFile(`system/modules/${d.name}/config.json`);
          if (file.success && file.data) {
            try {
              const m = JSON.parse(file.data);
              const moduleName = m.name || d.name;
              // 비활성화된 모듈은 시스템 컨텍스트에서 제외
              if (!this.core.isModuleEnabled(moduleName)) continue;
              const rt = m.runtime === 'node' ? 'index.mjs' : m.runtime === 'python' ? 'main.py' : 'index.mjs';
              allMods.push({
                name: moduleName,
                path: `system/modules/${d.name}/${rt}`,
                capability: m.capability,
                providerType: m.providerType,
                description: m.description || '',
                inputDesc: m.input ? Object.entries(m.input).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
                outputDesc: m.output ? Object.entries(m.output).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
              });
            } catch {
              allMods.push({ name: d.name, path: `system/modules/${d.name}`, description: '', inputDesc: '', outputDesc: '' });
            }
          }
        }

        // capability 사용자 정의 순서에 따라 정렬
        const modInfos: string[] = [];
        // 같은 capability 내에서 사용자 정의 순서 적용
        const capProviderOrder = new Map<string, string[]>(); // capability → [moduleName, ...]
        for (const mod of allMods) {
          if (mod.capability && !capProviderOrder.has(mod.capability)) {
            const settings = this.core.getCapabilitySettings(mod.capability);
            capProviderOrder.set(mod.capability, settings.providers);
          }
        }
        // 사용자 순서로 정렬
        allMods.sort((a, b) => {
          if (a.capability && b.capability && a.capability === b.capability) {
            const order = capProviderOrder.get(a.capability) || [];
            if (order.length > 0) {
              const aIdx = order.indexOf(a.name);
              const bIdx = order.indexOf(b.name);
              return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            }
          }
          return 0;
        });
        for (const mod of allMods) {
          const capInfo = mod.capability ? ` [${mod.capability}, ${mod.providerType || 'unknown'}]` : '';
          let line = `  - ${mod.name} (${mod.path})${capInfo}: ${mod.description}`;
          if (mod.inputDesc) line += `\n    입력: {${mod.inputDesc}}`;
          if (mod.outputDesc) line += `\n    출력: {${mod.outputDesc}}`;
          modInfos.push(line);
        }

        lines.push(`[시스템 모듈] sysmod_ 접두사 도구로 직접 호출 (예: sysmod_kiwoom). 또는 execute 도구의 path에 경로 지정.\n${modInfos.join('\n')}`);
      }
    }
    const pages = await this.core.listPages();
    if (pages.success && pages.data) {
      const slugs = pages.data.map((p: PageListItem) => `/${p.slug}`);
      lines.push(`[DB 페이지] ${slugs.length > 0 ? slugs.join(', ') : '없음'}`);
    }
    // 사용자 시크릿 목록 (값은 노출하지 않음)
    const secretKeys = this.core.listUserSecrets();
    lines.push(`[저장된 시크릿] ${secretKeys.length > 0 ? secretKeys.join(', ') : '없음'}`);
    // MCP 외부 도구 목록 (데모 모드에서는 비활성)
    if (!isDemo) {
      const servers = this.core.listMcpServers();
      const enabledServers = servers.filter(s => s.enabled);
      if (enabledServers.length === 0) {
        lines.push(`[MCP 외부 도구] 없음`);
      } else {
        const mcpResult = await this.core.listAllMcpTools();
        if (mcpResult.success && mcpResult.data && mcpResult.data.length > 0) {
          const toolList = mcpResult.data.map(t => `${t.server}/${t.name}: ${t.description}`).join('\n  ');
          lines.push(`[MCP 외부 도구]\n  ${toolList}`);
          // 도구가 나온 서버 vs 등록된 서버 비교 → 연결 실패 서버 표시
          const connectedServers = new Set(mcpResult.data.map(t => t.server));
          const failedServers = enabledServers.filter(s => !connectedServers.has(s.name));
          if (failedServers.length > 0) {
            lines.push(`[MCP 연결 실패] ${failedServers.map(s => s.name).join(', ')} — 서버가 응답하지 않거나 인증이 필요합니다.`);
          }
        } else {
          lines.push(`[MCP 외부 도구] 등록된 서버 ${enabledServers.length}개 (${enabledServers.map(s => s.name).join(', ')}), 연결 실패 — 서버가 응답하지 않거나 인증이 필요합니다.`);
        }
      }
    }
    // Capability 설정 (사용자 정의 provider 순서)
    const capIds = ['web-scrape', 'email-send', 'image-gen', 'translate', 'notification', 'pdf-gen'];
    const capSettings: string[] = [];
    for (const id of capIds) {
      const settings = this.core.getCapabilitySettings(id);
      if (settings.providers.length > 0) {
        capSettings.push(`${id}: [${settings.providers.join(' → ')}]`);
      }
    }
    if (capSettings.length > 0) {
      lines.push(`[Capability 순서] ${capSettings.join(', ')}`);
    }

    const result = lines.join('\n') || '[시스템 상태 조회 실패]';
    this._ctxCache = { text: result, ts: Date.now(), isDemo };
    return result;
  }

  async process(prompt: string, history: ChatMessage[] = [], opts?: AiRequestOpts, maxRetries = 3): Promise<CoreResult> {
    const isDemo = opts?.isDemo ?? false;
    const llmOpts: LlmCallOpts | undefined = opts?.model ? { model: opts.model } : undefined;
    let currentPrompt = prompt;
    let attempt = 0;
    const executedActions: string[] = [];
    let lastError: string | null = null;

    const startTime = Date.now();
    const corrId = Math.random().toString(36).slice(2, 10);
    const modelId = llmOpts?.model ?? this.llm.getModelId();
    const { recentHistory, contextSummary } = this.compressHistory(history);
    const systemContext = await this.gatherSystemContext(isDemo);

    const systemPrompt = this.buildSystemPrompt(systemContext);

    const finalSystemPrompt = contextSummary
      ? systemPrompt + `\n\n${contextSummary}`
      : systemPrompt;

    const cleanJsonString = (raw: string) =>
      raw.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim();

    while (attempt < maxRetries) {
      attempt++;
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Attempt ${attempt}/${maxRetries}`);

      const llmStart = Date.now();
      const llmRes = await this.llm.ask(currentPrompt, finalSystemPrompt, recentHistory, llmOpts);
      const llmMs = Date.now() - llmStart;

      if (!llmRes.success) {
        lastError = `LLM API 실패: ${llmRes.error}`;
        this.logger.error(`[AiManager] [${corrId}] [${modelId}] LLM 실패 (${llmMs}ms): ${llmRes.error}`);
        currentPrompt = `[SYSTEM] LLM 호출 실패: ${llmRes.error}. 동일한 요청을 다시 시도하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      let cleanedData = llmRes.data;
      if (typeof cleanedData === 'string') {
        try { cleanedData = JSON.parse(cleanJsonString(cleanedData)); } catch {}
      }
      // AI가 배열을 반환한 경우 → actions로 감싸서 복구 시도
      if (Array.isArray(cleanedData)) {
        this.logger.warn(`[AiManager] [${corrId}] [${modelId}] Plan이 배열로 반환됨 → 객체로 변환 시도`);
        cleanedData = { thoughts: '', reply: '', actions: cleanedData, suggestions: [] };
      }

      const parseResult = FirebatPlanSchema.safeParse(cleanedData);
      if (!parseResult.success) {
        const errorDetails = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        lastError = errorDetails;
        this.logger.warn(`[AiManager] [${corrId}] [${modelId}] 스키마 실패 (${llmMs}ms): ${errorDetails}`);
        currentPrompt = `[SYSTEM] JSON 스키마 위반: ${errorDetails}. 수정하여 재시도하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      const plan: FirebatPlan = parseResult.data;
      // 필드 누락 방어
      for (const a of plan.actions) {
        if (!a.description) a.description = a.type;
        if (a.type === 'SCHEDULE_TASK' && !a.title) {
          a.title = a.description || 'SCHEDULE_TASK';
        }
      }
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Plan validated (${llmMs}ms). Thoughts: ${plan.thoughts}`);

      let executionError: string | null = null;
      const finalDataList: unknown[] = [];
      executedActions.length = 0;

      for (const action of plan.actions) {
        this.logger.info(`[AiManager] [${corrId}] Executing: ${action.type}`);
        executedActions.push(action.type);

        switch (action.type) {
          case 'WRITE_FILE': {
            if (action.content == null) { executionError = `WRITE_FILE 실패: content가 비어 있습니다 (${action.path})`; break; }
            const res = await this.core.writeFile(action.path, action.content);
            if (!res.success) executionError = `WRITE_FILE 실패: ${res.error}`;
            break;
          }
          case 'APPEND_FILE': {
            const readRes = await this.core.readFile(action.path);
            const combined = readRes.success ? readRes.data + '\n' + action.content : action.content;
            const res = await this.core.writeFile(action.path, combined);
            if (!res.success) executionError = `APPEND_FILE 실패: ${res.error}`;
            break;
          }
          case 'DELETE_FILE': {
            const res = await this.core.deleteFile(action.path);
            if (!res.success) executionError = `DELETE_FILE 실패: ${res.error}`;
            break;
          }
          case 'READ_FILE': {
            const res = await this.core.readFile(action.path);
            if (!res.success) { executionError = `READ_FILE 실패: ${res.error}`; break; }
            let text = res.data || '';
            if (action.lines && text.split('\n').length > action.lines) {
              text = text.split('\n').slice(0, action.lines).join('\n') + `\n... (truncated to ${action.lines} lines)`;
            }
            finalDataList.push({ path: action.path, content: text });
            break;
          }
          case 'LIST_DIR': {
            const res = await this.core.listFiles(action.path);
            if (!res.success) executionError = `LIST_DIR 실패: ${res.error}`;
            else finalDataList.push({ path: action.path, items: res.data });
            break;
          }
          case 'EXECUTE': {
            const res = await this.core.sandboxExecute(action.path, action.inputData ?? {});
            if (!res.success) {
              executionError = `EXECUTE 샌드박스 오류 (${action.path}): ${res.error}`;
            } else if (res.data?.success === false) {
              executionError = `EXECUTE 모듈 로직 오류 (${action.path}): ${JSON.stringify(res.data)}. 코드를 수정하세요.`;
            } else {
              finalDataList.push(res.data);
            }
            break;
          }
          case 'NETWORK_REQUEST': {
            const res = await this.core.networkFetch(action.url, { method: action.method, body: action.body, headers: action.headers });
            if (!res.success) executionError = `NETWORK_REQUEST 오류: ${res.error}`;
            else finalDataList.push(res.data);
            break;
          }
          case 'SCHEDULE_TASK': {
            const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const res = await this.core.scheduleCronJob(jobId, action.targetPath ?? '', {
              cronTime: action.cronTime, runAt: action.runAt, delaySec: action.delaySec,
              startAt: action.startAt, endAt: action.endAt,
              inputData: action.inputData,
              pipeline: action.pipeline,
              title: action.title,
              description: action.description,
            });
            if (!res.success) executionError = `SCHEDULE_TASK 오류: ${res.error}`;
            break;
          }
          case 'CANCEL_TASK': {
            const res = await this.core.cancelCronJob(action.jobId);
            if (!res.success) executionError = `CANCEL_TASK 오류: ${res.error}`;
            break;
          }
          case 'LIST_TASKS': {
            const jobs = this.core.listCronJobs();
            finalDataList.push({ cronJobs: jobs });
            break;
          }
          case 'DATABASE_QUERY': {
            const res = await this.core.queryDatabase(action.query, action.params);
            if (!res.success) executionError = `DATABASE_QUERY 오류: ${res.error}`;
            else finalDataList.push(res.data);
            break;
          }
          case 'OPEN_URL': {
            finalDataList.push({ openUrl: action.url });
            break;
          }
          case 'SAVE_PAGE': {
            const specStr = typeof action.spec === 'string' ? action.spec : JSON.stringify(action.spec);
            const res = await this.core.savePage(action.slug, specStr);
            if (!res.success) executionError = `SAVE_PAGE 실패: ${res.error}`;
            else finalDataList.push({ savedPage: action.slug, openUrl: `/${action.slug}` });
            break;
          }
          case 'DELETE_PAGE': {
            const res = await this.core.deletePage(action.slug);
            if (!res.success) executionError = `DELETE_PAGE 실패: ${res.error}`;
            break;
          }
          case 'LIST_PAGES': {
            const res = await this.core.listPages();
            if (!res.success) executionError = `LIST_PAGES 실패: ${res.error}`;
            else finalDataList.push(res.data);
            break;
          }
          case 'REQUEST_SECRET': {
            // 프론트엔드에 시크릿 입력 요청을 전달 — 실행 중단
            finalDataList.push({
              requestSecret: true,
              name: action.name,
              prompt: action.prompt,
              helpUrl: action.helpUrl,
            });
            break;
          }
          case 'MCP_CALL': {
            if (isDemo) { executionError = 'MCP는 데모 모드에서 사용할 수 없습니다.'; break; }
            const mcpRes = await this.core.callMcpTool(action.server, action.tool, action.arguments ?? {});
            if (!mcpRes.success) {
              executionError = `MCP_CALL 실패 (${action.server}/${action.tool}): ${mcpRes.error}`;
            } else {
              finalDataList.push({ mcpResult: { server: action.server, tool: action.tool, data: mcpRes.data } });
            }
            break;
          }
          case 'RUN_TASK': {
            const taskRes = await this.core.runTask(action.pipeline);
            if (!taskRes.success) {
              executionError = `RUN_TASK 실패: ${taskRes.error}`;
            } else {
              finalDataList.push({ taskResult: taskRes.data });
            }
            break;
          }
        }

        if (executionError) break;
      }

      if (executionError) {
        lastError = executionError;
        this.logger.error(`[AiManager] [${corrId}] 액션 실패: ${executionError}`);
        currentPrompt = `[SYSTEM] 실행 실패: ${executionError}\n원인을 분석하고 수정된 플랜을 제출하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      // RUN_TASK 파이프라인 결과가 있으면 reply에 반영 (문자열 결과만, JSON은 AI reply 유지)
      let finalReply = plan.reply;
      const hasTaskResult = (d: unknown): d is { taskResult: unknown } =>
        d !== null && typeof d === 'object' && 'taskResult' in d;
      const taskResults = finalDataList.filter(hasTaskResult);
      if (taskResults.length > 0) {
        const textResults = taskResults
          .filter(d => typeof d.taskResult === 'string')
          .map(d => d.taskResult as string)
          .join('\n\n')
          .trim();
        if (textResults) {
          finalReply = textResults;
        }
      }

      const totalMs = Date.now() - startTime;
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] 완료 (${executedActions.length}개 액션, ${totalMs}ms)`);
      return {
        success: true,
        thoughts: plan.thoughts,
        reply: finalReply,
        executedActions,
        data: finalDataList.length === 1 ? finalDataList[0] : finalDataList.length > 1 ? finalDataList : undefined,
      };
    }

    const totalMs = Date.now() - startTime;
    this.logger.error(`[AiManager] [${corrId}] [${modelId}] 최종 실패 (${maxRetries}회 시도, ${totalMs}ms): ${lastError}`);
    return {
      success: false,
      executedActions,
      error: '요청을 처리하지 못했습니다. 다시 시도해 주세요.',
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Plan-Execute 분리 파이프라인
  // ══════════════════════════════════════════════════════════════════════════

  /** Plan만 수립 (실행하지 않음) — 유저 확인용 */
  async planOnly(prompt: string, history: ChatMessage[] = [], opts?: AiRequestOpts, maxRetries = 3): Promise<{
    success: boolean;
    plan?: FirebatPlan;
    corrId?: string;
    modelId?: string;
    error?: string;
  }> {
    const isDemo = opts?.isDemo ?? false;
    const llmOpts: LlmCallOpts | undefined = opts?.model ? { model: opts.model } : undefined;
    const corrId = Math.random().toString(36).slice(2, 10);
    const modelId = llmOpts?.model ?? this.llm.getModelId();
    const { recentHistory, contextSummary } = this.compressHistory(history);
    const systemContext = await this.gatherSystemContext(isDemo);
    const systemPrompt = this.buildSystemPrompt(systemContext);
    const finalSystemPrompt = contextSummary ? systemPrompt + `\n\n${contextSummary}` : systemPrompt;

    const cleanJsonString = (raw: string) =>
      raw.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim();

    let currentPrompt = prompt;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Plan Attempt ${attempt}/${maxRetries}`);

      const llmStart = Date.now();
      const llmRes = await this.llm.ask(currentPrompt, finalSystemPrompt, recentHistory, llmOpts);
      const llmMs = Date.now() - llmStart;

      if (!llmRes.success) {
        lastError = `LLM API 실패: ${llmRes.error}`;
        this.logger.error(`[AiManager] [${corrId}] [${modelId}] Plan LLM 실패 (${llmMs}ms): ${llmRes.error}`);
        currentPrompt = `[SYSTEM] LLM 호출 실패: ${llmRes.error}. 동일한 요청을 다시 시도하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      let cleanedData = llmRes.data;
      if (typeof cleanedData === 'string') {
        try { cleanedData = JSON.parse(cleanJsonString(cleanedData)); } catch {}
      }
      // AI가 배열을 반환한 경우 → actions로 감싸서 복구 시도
      if (Array.isArray(cleanedData)) {
        this.logger.warn(`[AiManager] [${corrId}] [${modelId}] Plan이 배열로 반환됨 → 객체로 변환 시도`);
        cleanedData = { thoughts: '', reply: '', actions: cleanedData, suggestions: [] };
      }

      const parseResult = FirebatPlanSchema.safeParse(cleanedData);
      if (!parseResult.success) {
        const errorDetails = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        lastError = errorDetails;
        this.logger.warn(`[AiManager] [${corrId}] [${modelId}] Plan 스키마 실패 (${llmMs}ms): ${errorDetails}`);
        currentPrompt = `[SYSTEM] JSON 스키마 위반: ${errorDetails}. 수정하여 재시도하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      const plan = parseResult.data;
      // 필드 누락 방어
      for (const a of plan.actions) {
        if (!a.description) a.description = a.type;
        if (a.type === 'SCHEDULE_TASK' && !a.title) {
          a.title = a.description || 'SCHEDULE_TASK';
        }
      }
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Plan 수립 완료 (${llmMs}ms, ${plan.actions.length}개 액션)`);
      return { success: true, plan, corrId, modelId };
    }

    this.logger.error(`[AiManager] [${corrId}] [${modelId}] Plan ${maxRetries}회 실패: ${lastError}`);
    return { success: false, error: '요청을 처리하지 못했습니다. 다시 시도해 주세요.' };
  }

  /** Plan의 액션을 단계별 실행 — onStep 콜백으로 진행률 전달 */
  async executePlan(
    plan: FirebatPlan,
    corrId: string,
    opts?: AiRequestOpts,
    onStep?: (step: { index: number; total: number; type: string; status: 'start' | 'done' | 'error'; error?: string }) => void,
  ): Promise<CoreResult> {
    const isDemo = opts?.isDemo ?? false;
    const startTime = Date.now();
    const modelId = opts?.model ?? this.llm.getModelId();
    const executedActions: string[] = [];
    const finalDataList: unknown[] = [];

    // RUN_TASK 파이프라인은 내부 단계를 풀어서 step 이벤트 전달
    let stepOffset = 0;
    let totalSteps = 0;
    for (const a of plan.actions) {
      totalSteps += (a.type === 'RUN_TASK' && a.pipeline?.length) ? a.pipeline.length : 1;
    }

    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      executedActions.push(action.type);

      if (action.type === 'RUN_TASK' && action.pipeline?.length) {
        // 파이프라인 실행 — 단계별 step 이벤트는 실행 시점에 콜백으로 전달
        const pipelineSteps = action.pipeline;
        const taskRes = await this.core.runTask(pipelineSteps, (pipeIdx, status, error) => {
          const step = pipelineSteps[pipeIdx];
          const desc = step.description || ('instruction' in step ? step.instruction : '') || ('path' in step ? step.path : '') || step.type;
          onStep?.({ index: stepOffset + pipeIdx, total: totalSteps, type: step.type, status, error });
        });
        if (!taskRes.success) {
          this.logger.error(`[AiManager] [${corrId}] 액션 실패: RUN_TASK 실패: ${taskRes.error}`);
          return { success: false, thoughts: plan.thoughts, reply: plan.reply, executedActions, error: `RUN_TASK 실패: ${taskRes.error}` };
        }
        finalDataList.push({ taskResult: taskRes.data });
        stepOffset += action.pipeline.length;
      } else {
        onStep?.({ index: stepOffset, total: totalSteps, type: action.type, status: 'start' });

        const actionError = await this.executeAction(action, finalDataList, isDemo);

        if (actionError) {
          onStep?.({ index: stepOffset, total: totalSteps, type: action.type, status: 'error', error: actionError });
          this.logger.error(`[AiManager] [${corrId}] 액션 실패: ${actionError}`);
          return { success: false, thoughts: plan.thoughts, reply: plan.reply, executedActions, error: actionError };
        }

        onStep?.({ index: stepOffset, total: totalSteps, type: action.type, status: 'done' });
        stepOffset += 1;
      }
    }

    const totalMs = Date.now() - startTime;
    this.logger.info(`[AiManager] [${corrId}] [${modelId}] 실행 완료 (${executedActions.length}개 액션, ${totalMs}ms)`);

    // 실행 결과를 reply에 반영 (문자열 결과만, JSON은 AI reply 유지)
    let finalReply = plan.reply;
    const hasTaskResult = (d: unknown): d is { taskResult: unknown } =>
      d !== null && typeof d === 'object' && 'taskResult' in d;
    const taskResults = finalDataList.filter(hasTaskResult);
    if (taskResults.length > 0) {
      const textResults = taskResults
        .filter(d => typeof d.taskResult === 'string')
        .map(d => d.taskResult as string)
        .join('\n\n')
        .trim();
      if (textResults) {
        finalReply = textResults;
      }
    } else if (finalDataList.length > 0) {
      // 단독 EXECUTE 등의 결과가 있으면 reply에 반영
      const extractText = (d: unknown): string => {
        if (typeof d === 'string') return d;
        if (d && typeof d === 'object') {
          const r = d as Record<string, unknown>;
          if (typeof r.text === 'string') return r.text;
          if (typeof r.content === 'string') return r.content;
          if (r.data && typeof r.data === 'object') {
            const inner = r.data as Record<string, unknown>;
            if (typeof inner.text === 'string') return inner.text;
            if (typeof inner.content === 'string') return inner.content;
          }
        }
        return JSON.stringify(d, null, 2);
      };
      const dataTexts = finalDataList
        .filter(d => d != null)
        .map(extractText)
        .join('\n\n')
        .trim();
      if (dataTexts) {
        finalReply = dataTexts;
      }
    }

    return {
      success: true,
      thoughts: plan.thoughts,
      reply: finalReply,
      executedActions,
      data: finalDataList.length === 1 ? finalDataList[0] : finalDataList.length > 1 ? finalDataList : undefined,
    };
  }

  /** 단일 액션 실행 — 에러 문자열 반환 (성공 시 null) */
  private async executeAction(action: FirebatAction, dataList: unknown[], isDemo = false): Promise<string | null | undefined> {
    switch (action.type) {
      case 'WRITE_FILE': {
        if (action.content == null) return `WRITE_FILE 실패: content가 비어 있습니다 (${action.path})`;
        const res = await this.core.writeFile(action.path, action.content);
        return res.success ? null : `WRITE_FILE 실패: ${res.error}`;
      }
      case 'APPEND_FILE': {
        const readRes = await this.core.readFile(action.path);
        const combined = readRes.success ? readRes.data + '\n' + action.content : action.content;
        const res = await this.core.writeFile(action.path, combined);
        return res.success ? null : `APPEND_FILE 실패: ${res.error}`;
      }
      case 'DELETE_FILE': {
        const res = await this.core.deleteFile(action.path);
        return res.success ? null : `DELETE_FILE 실패: ${res.error}`;
      }
      case 'READ_FILE': {
        const res = await this.core.readFile(action.path);
        if (!res.success) return `READ_FILE 실패: ${res.error}`;
        let text = res.data || '';
        if (action.lines && text.split('\n').length > action.lines) {
          text = text.split('\n').slice(0, action.lines).join('\n') + `\n... (truncated to ${action.lines} lines)`;
        }
        dataList.push({ path: action.path, content: text });
        return null;
      }
      case 'LIST_DIR': {
        const res = await this.core.listFiles(action.path);
        if (!res.success) return `LIST_DIR 실패: ${res.error}`;
        dataList.push({ path: action.path, items: res.data });
        return null;
      }
      case 'EXECUTE': {
        const res = await this.core.sandboxExecute(action.path, action.inputData ?? {});
        if (!res.success) return `EXECUTE 샌드박스 오류 (${action.path}): ${res.error}`;
        if (res.data?.success === false) return `EXECUTE 모듈 로직 오류 (${action.path}): ${JSON.stringify(res.data)}`;
        dataList.push(res.data);
        return null;
      }
      case 'NETWORK_REQUEST': {
        const res = await this.core.networkFetch(action.url, { method: action.method, body: action.body, headers: action.headers });
        if (!res.success) return `NETWORK_REQUEST 오류: ${res.error}`;
        dataList.push(res.data);
        return null;
      }
      case 'SCHEDULE_TASK': {
        const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const res = await this.core.scheduleCronJob(jobId, action.targetPath ?? '', {
          cronTime: action.cronTime, runAt: action.runAt, delaySec: action.delaySec,
          startAt: action.startAt, endAt: action.endAt,
          inputData: action.inputData,
          pipeline: action.pipeline,
          title: action.title,
        });
        return res.success ? null : `SCHEDULE_TASK 오류: ${res.error}`;
      }
      case 'CANCEL_TASK': {
        const res = await this.core.cancelCronJob(action.jobId);
        return res.success ? null : `CANCEL_TASK 오류: ${res.error}`;
      }
      case 'LIST_TASKS': {
        const jobs = this.core.listCronJobs();
        dataList.push({ cronJobs: jobs });
        return null;
      }
      case 'DATABASE_QUERY': {
        const res = await this.core.queryDatabase(action.query, action.params);
        if (!res.success) return `DATABASE_QUERY 오류: ${res.error}`;
        dataList.push(res.data);
        return null;
      }
      case 'OPEN_URL': {
        dataList.push({ openUrl: action.url });
        return null;
      }
      case 'SAVE_PAGE': {
        const specStr = typeof action.spec === 'string' ? action.spec : JSON.stringify(action.spec);
        const res = await this.core.savePage(action.slug, specStr);
        if (!res.success) return `SAVE_PAGE 실패: ${res.error}`;
        dataList.push({ savedPage: action.slug, openUrl: `/${action.slug}` });
        return null;
      }
      case 'DELETE_PAGE': {
        const res = await this.core.deletePage(action.slug);
        return res.success ? null : `DELETE_PAGE 실패: ${res.error}`;
      }
      case 'LIST_PAGES': {
        const res = await this.core.listPages();
        if (!res.success) return `LIST_PAGES 실패: ${res.error}`;
        dataList.push(res.data);
        return null;
      }
      case 'REQUEST_SECRET': {
        dataList.push({
          requestSecret: true,
          name: action.name,
          prompt: action.prompt,
          helpUrl: action.helpUrl,
        });
        return null;
      }
      case 'MCP_CALL': {
        if (isDemo) return 'MCP는 데모 모드에서 사용할 수 없습니다.';
        const mcpRes = await this.core.callMcpTool(action.server, action.tool, action.arguments ?? {});
        if (!mcpRes.success) return `MCP_CALL 실패 (${action.server}/${action.tool}): ${mcpRes.error}`;
        dataList.push({ mcpResult: { server: action.server, tool: action.tool, data: mcpRes.data } });
        return null;
      }
      case 'RUN_TASK': {
        const taskRes = await this.core.runTask(action.pipeline);
        if (!taskRes.success) return `RUN_TASK 실패: ${taskRes.error}`;
        dataList.push({ taskResult: taskRes.data });
        return null;
      }
    }
  }

  /** 시스템 프롬프트 빌드 (planOnly와 process에서 공용) */
  private buildSystemPrompt(systemContext: string): string {
    const userTz = this.core.getTimezone();
    return `Firebat User AI. 자연스럽게 대화. 모든 출력(응답, 생각, 추론)을 한국어로 작성. 시스템 내부 구조 밝히지 마라.

## 시스템 상태
${systemContext}
## 응답
유효한 JSON만 출력. \`\`\`json 감싸기 금지.
{ "thoughts": "판단 근거 (앱 생성 시만 상세)", "reply": "사용자 답변 (한국어)", "actions": [...], "suggestions": [...] }
- action마다 description(한국어 설명) 필수.
- reply에 raw JSON/디버그 정보 금지. 결과는 자연어로 요약.
- 대화/인사/질문 → actions: []
- suggestions: 사용자 결정이 필요할 때만. 실행 완료/예약 완료 후에는 넣지 마라. 문자열="버튼", {"type":"input","label":"표시명","placeholder":"힌트"}=자유 입력 필드. 예: ["바로 실행", {"type":"input","label":"다른 시간 지정","placeholder":"오후 2시 30분"}].
### 액션 JSON 샘플
SAVE_PAGE: {"type":"SAVE_PAGE","description":"BMI 계산기 페이지 생성","slug":"bmi-calculator","spec":{"slug":"bmi-calculator","status":"published","project":"bmi","head":{"title":"BMI 계산기","description":"비만도 계산","keywords":["BMI"],"og":{"title":"BMI 계산기","description":"비만도 계산","image":"","type":"website"}},"body":[{"type":"Html","props":{"content":"<div>...</div>"}}]}}
DELETE_PAGE: {"type":"DELETE_PAGE","description":"BMI 페이지 삭제","slug":"bmi-calculator"}
LIST_PAGES: {"type":"LIST_PAGES","description":"페이지 목록 조회"}
WRITE_FILE: {"type":"WRITE_FILE","description":"모듈 생성","path":"user/modules/weather/main.py","content":"import sys..."}
READ_FILE: {"type":"READ_FILE","description":"파일 읽기","path":"user/modules/weather/main.py"}
LIST_DIR: {"type":"LIST_DIR","description":"모듈 폴더 조회","path":"user/modules"}
APPEND_FILE: {"type":"APPEND_FILE","description":"로그 추가","path":"user/modules/log/data.txt","content":"새 로그"}
DELETE_FILE: {"type":"DELETE_FILE","description":"프로젝트 삭제","path":"user/modules/old-project"}
EXECUTE: {"type":"EXECUTE","description":"날씨 모듈 테스트","path":"user/modules/weather/main.py","mockData":{"city":"Seoul"}}
NETWORK_REQUEST: {"type":"NETWORK_REQUEST","description":"API 호출","url":"https://api.example.com/data","method":"GET"}
OPEN_URL: {"type":"OPEN_URL","description":"페이지 열기","url":"/bmi-calculator"}
REQUEST_SECRET: {"type":"REQUEST_SECRET","description":"API 키 요청","name":"openweather-api-key","prompt":"OpenWeather API 키를 입력해주세요"}
MCP_CALL: {"type":"MCP_CALL","description":"이메일 검색","server":"gmail","tool":"search_emails","arguments":{"query":"is:unread","maxResults":5}}
CANCEL_TASK: {"type":"CANCEL_TASK","description":"스케줄 해제","jobId":"cron-12345-abcd"}
LIST_TASKS: {"type":"LIST_TASKS","description":"스케줄 목록 조회"}

## 실행 요청
기존 프로젝트 활용. 새 모듈 만들지 마라.
- [DB 페이지]/[프로젝트] 목록에서 먼저 확인.
- 즉시 실행: 페이지 → OPEN_URL, 모듈 → EXECUTE.
- 예약/반복: 기존 모듈/페이지 경로로 SCHEDULE_TASK. 페이지 URL도 targetPath에 넣을 수 있다.

## 앱/페이지 생성 — 3단계 공동 설계
1단계(기능 선택): 앱에 넣을 기능 후보를 제시. actions: [] → suggestions에 toggle로 기능 목록 + input으로 직접 추가 + "취소".
  예: [{"type":"toggle","label":"기능 선택","options":["vs 컴퓨터 대전","스코어보드","애니메이션","효과음","난이도 선택"],"defaults":["vs 컴퓨터 대전","스코어보드","애니메이션"]},{"type":"input","label":"기능 직접 추가","placeholder":"추가할 기능"},"취소"]
2단계(디자인 선택): 사용자가 기능을 확정하면 디자인 스타일 선택지 제시. actions: [] → suggestions에 스타일 버튼들 + input.
  예: ["다크 + 네온","밝은 미니멀","레트로 게임",{"type":"input","label":"스타일 직접 입력","placeholder":"원하는 스타일"},"취소"]
3단계(구현): 기능+디자인 확정 후 SAVE_PAGE + WRITE_FILE 실행.
- SAVE_PAGE로 PageSpec JSON 저장. page.tsx 직접 작성 금지.
- PageSpec: { slug, status:"published", project, head: { title, description, keywords, og: { title, description, image:"", type:"website" } }, body: [{ type:"Html", props:{ content:"..." } }] }
- og 필드 필수. title/description 비우지 마라.
- Html 컴포넌트 메인. iframe sandbox 내 HTML+CSS+JS 자유.
- 프로덕션 수준 디자인: 그라디언트, 그림자, 애니메이션, 반응형.
- CSS는 <style> 태그, 클래스 기반. JS는 <script> 태그. CDN 사용 가능.
- localStorage/sessionStorage 금지 (sandbox 차단). vw 단위 금지 (100% 사용).
- 내장 컴포넌트: Header, Text, Image, Form, ResultDisplay, Button, Divider, Table, Card, Grid, Html, AdSlot, Slider, Tabs, Accordion, Progress, Badge, Alert, List, Carousel, Countdown, Chart.
- project 필드로 페이지+모듈 묶기. 수정 시 같은 slug로 upsert. 삭제 DELETE_PAGE.
- 프로젝트명 = 모듈 폴더명 = 페이지 slug 통일.

## 쓰기 구역
user/modules/[name]/ 만. core/, infra/, system/, app/ 금지.

## 모듈
- I/O: stdin JSON → stdout JSON. sys.argv 금지. Python: True/False/None.
- config.json 필수 (name, type, scope, runtime, packages, input, output).
- API 키: config.json secrets 배열 등록 → 환경변수 자동 주입. 하드코딩 금지.
- 미등록 키 → REQUEST_SECRET (다른 액션 앞에 배치). 키 이름은 kebab-case.
- EXECUTE mockData는 input 스펙에 맞는 실제 값.

## 스케줄링
시간 기준: ${userTz}. 현재: ${new Date().toLocaleString('ko-KR', { timeZone: userTz })}
jobId는 시스템 자동 생성 — 넣지 마라.
필수: title(짧은 이름). 선택: description(상세 설명).
모드: cronTime(반복), cronTime+startAt/endAt(기간 한정), runAt(1회, ISO 8601), delaySec(N초 후).
즉시 실행이 필요한 복합 작업은 SCHEDULE_TASK가 아닌 RUN_TASK를 사용하라.
크론: "분 시 일 월 요일", ${userTz} 기준.
시각이 이미 지났으면: 바로 실행할지, 시각 수정할지 reply에서 물어라. 자의적으로 시각을 바꾸지 마라.
CANCEL_TASK: LIST_TASKS로 jobId 확인 후 해제. 새 모듈 만들지 마라.

### RUN_TASK (즉시 파이프라인 실행)
"지금 바로 해줘" 류 복합 작업은 RUN_TASK. 예약이 아닌 즉시 실행.
파이프라인 단계 type: EXECUTE, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM, CONDITION.
사용자에게 결과를 보여줄 때는 마지막 단계를 LLM_TRANSFORM으로 끝내라.
CONDITION: 조건 검사. false면 파이프라인 정상 종료(에러 아님).
  field: "$prev" 또는 "$prev.필드명", op: ==, !=, <, <=, >, >=, includes, not_includes, exists, not_exists.
모듈 경로·입출력은 [시스템 모듈] 목록 참조. 하드코딩 금지.
$prev 규칙:
- 각 단계의 결과는 자동으로 다음 단계의 입력($prev).
- $prev.필드명으로 속성 접근. inputMap으로 매핑: {"url":"$prev.url"}.
- CONDITION은 $prev를 변경하지 않음.
LLM_TRANSFORM instruction: 사용자가 물어본 범위만 정확히 지정. 모호한 표현 금지. 안 물어본 내용 포함 금지.

### SCHEDULE_TASK (예약/반복)
단순 실행: targetPath+inputData+cronTime/runAt/delaySec.
파이프라인 예약: pipeline 배열+cronTime/runAt/delaySec. RUN_TASK와 동일한 단계 규칙.

## 시스템 모듈
[시스템 모듈]에 경로·입출력·capability·providerType이 명시되어 있다. EXECUTE의 path에 해당 경로를, inputData에 입력 형식을 그대로 사용.
같은 capability의 모듈이 여러 개면 [시스템 모듈] 목록의 첫 번째를 사용하라. 순서는 사용자가 설정한 우선순위다.
AI는 절대 자의적으로 provider를 선택하지 마라. 목록 순서대로만 선택. 실패하면 TaskManager가 자동 폴백한다.

## MCP 외부 도구
[MCP 외부 도구] 목록의 도구만 MCP_CALL로 호출. inputSchema 준수. raw JSON 표시 금지.
도구 없으면 "설정에서 MCP 서버를 추가해주세요" 안내.
복합 요청: actions 배열에 순서대로 (조회 → 가공 → 발송 → 예약).

## 응답 범위
- 질문한 것만 답하라. 안 물어본 정보를 절대 덧붙이지 마라.
- reply에 thoughts(분석 과정)를 반복하지 마라. thoughts는 내부용이다.
- 추가 정보가 유용할 것 같으면 suggestions로 선택지를 제공하라.

## 금지
- [Kernel Block] 에러 → actions: [] 중단. 우회 금지.
- 시스템 내부 코드 설명/출력 금지.`;

  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Function Calling — 멀티턴 도구 루프
  // ══════════════════════════════════════════════════════════════════════════

  /** 단순 대화 판별 — 도구가 필요 없는 인사/질문/잡담 */
  private isSimpleChat(prompt: string): boolean {
    const p = prompt.trim();
    // 확실한 인사/잡담만 화이트리스트 (나머지는 전부 도구 경로)
    if (p.length > 15) return false;
    return /^(안녕|하이|헬로|ㅎㅇ|ㅎㅎ+|ㅋㅋ+|ㄱㅅ|감사|고마워|땡큐|잘자|바이|ㅇㅋ|ㅇㅇ|ㄴㄴ|네|예|응|그래|좋아|ㅠㅠ*|hi|hello|hey|thanks|ok|bye)[\s!.~?ㅎㅋ]*$/i.test(p);
  }

  /** Function Calling 기반 AI 처리 — 도구 호출 루프 */
  async processWithTools(
    prompt: string,
    history: ChatMessage[] = [],
    opts?: AiRequestOpts,
    onToolCall?: (info: { name: string; status: 'start' | 'done' | 'error'; error?: string }) => void,
    onChunk?: (chunk: LlmChunk) => void,
  ): Promise<CoreResult> {
    const isDemo = opts?.isDemo ?? false;
    const thinkingLevel = this.core.getAiThinkingLevel();
    const corrId = Math.random().toString(36).slice(2, 10);
    const startTime = Date.now();

    // 도구 사용 흐름은 스트리밍 꺼서 중간 턴 text 깜빡임 방지 (프론트에서 chunk-flow 애니메이션으로 대체)
    // Fast Path(단순 대화)는 한 턴이라 스트리밍 유지 OK
    const llmOpts: LlmCallOpts = {
      thinkingLevel,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.image ? { image: opts.image } : {}),
    };
    const fastPathOpts: LlmCallOpts = { ...llmOpts, ...(onChunk ? { onChunk } : {}) };
    const MAX_TOOL_TURNS = 10;
    const modelId = llmOpts?.model ?? this.llm.getModelId();

    // ── 단순 대화 Fast Path: 도구 없이 askText로 빠른 응답 (스트리밍 유지) ──
    if (this.isSimpleChat(prompt) && !opts?.image) {
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] 단순 대화 감지 → Fast Path (도구 0개)`);
      const { recentHistory, contextSummary } = this.compressHistory(history);
      const chatSystemPrompt = `Firebat User AI. 자연스럽게 한국어로 대화. 모든 출력(응답, 생각, 추론)을 한국어로 작성. 시스템 내부 구조 밝히지 마라. 마크다운 규칙: 코드 블록은 실제 코드에만. 강조는 **볼드**.${contextSummary ? `\n\n${contextSummary}` : ''}`;
      const chatResult = await this.llm.askWithTools(prompt, chatSystemPrompt, [], recentHistory, [], fastPathOpts);
      const totalMs = Date.now() - startTime;
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Fast Path 완료 (${totalMs}ms)`);
      if (!chatResult.success) return { success: false, executedActions: [], error: chatResult.error };
      return { success: true, reply: chatResult.data?.text || '', executedActions: [] };
    }

    const { recentHistory, contextSummary } = this.compressHistory(history);
    const systemContext = await this.gatherSystemContext(isDemo);

    const systemPrompt = this.buildToolSystemPrompt(systemContext);
    const finalSystemPrompt = contextSummary
      ? systemPrompt + `\n\n${contextSummary}`
      : systemPrompt;

    // 도구 정의 빌드 (캐시 활용)
    const tools = await this.buildToolDefinitions(isDemo);
    this.logger.info(`[AiManager] [${corrId}] [${modelId}] Function Calling 시작 (${tools.length}개 도구)`);

    const toolExchanges: ToolExchangeEntry[] = [];
    const executedActions: string[] = [];
    const collectedData: Record<string, unknown>[] = [];
    const pendingActions: Array<{ planId: string; name: string; summary: string; args: Record<string, unknown> }> = [];
    // 인라인 블록 — text/html/component를 순서대로 쌓음 (Claude 스타일 inline 렌더링용)
    const blocks: Array<
      | { type: 'text'; text: string }
      | { type: 'html'; htmlContent: string; htmlHeight?: string }
      | { type: 'component'; name: string; props: Record<string, unknown> }
    > = [];
    let finalReply = '';
    let suggestions: unknown[] = [];

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const llmStart = Date.now();
      const llmRes = await this.llm.askWithTools(prompt, finalSystemPrompt, tools, recentHistory, toolExchanges, llmOpts);
      const llmMs = Date.now() - llmStart;

      if (!llmRes.success) {
        this.logger.error(`[AiManager] [${corrId}] [${modelId}] LLM 실패 (turn ${turn + 1}, ${llmMs}ms): ${llmRes.error}`);
        return { success: false, executedActions, error: `LLM API 실패: ${llmRes.error}` };
      }

      const { text: rawText, toolCalls, rawModelParts } = llmRes.data!;
      // Gemini가 종종 tool call JSON을 코드 블록으로 출력 → 제거
      const text = this.stripToolLeakage(rawText || '').trim();
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Turn ${turn + 1} (${llmMs}ms): text=${text.length}자, tools=${toolCalls.length}개`);

      // 도구 호출이 없으면 최종 응답
      if (toolCalls.length === 0) {
        finalReply = text;
        if (text) blocks.push({ type: 'text', text });
        break;
      }

      // rawModelParts 순서대로 블록 플레이스홀더 기록 — tool 실행 후 결과로 치환
      // 시각화 도구 (render_html, render_pagespec) 만 inline 블록화
      const RENDER_TOOLS = new Set(['render_html', 'render_pagespec']);
      const turnBlocks: Array<{ type: 'text'; text: string } | { type: 'tool-placeholder'; toolCallIdx: number }> = [];
      if (rawModelParts) {
        const seenCount: Record<string, number> = {};
        for (const part of rawModelParts as Array<Record<string, unknown>>) {
          if (part.text && typeof part.text === 'string' && !part.thought) {
            // tool call을 코드 블록으로 노출하는 Gemini 버릇 차단
            const cleaned = this.stripToolLeakage(part.text as string);
            if (cleaned) {
              // 연속된 text part는 합침 (단어 중간 줄바꿈 방지)
              const last = turnBlocks[turnBlocks.length - 1];
              if (last && last.type === 'text') last.text += cleaned;
              else turnBlocks.push({ type: 'text', text: cleaned });
            }
          } else if (part.functionCall && typeof part.functionCall === 'object') {
            const fc = part.functionCall as { name?: string };
            const name = fc.name || '';
            if (RENDER_TOOLS.has(name)) {
              const prevCount = seenCount[name] || 0;
              // toolCalls에서 같은 이름의 (prevCount+1)번째 호출 인덱스
              let seen = 0;
              const toolCallIdx = toolCalls.findIndex(t => { if (t.name !== name) return false; seen++; return seen === prevCount + 1; });
              if (toolCallIdx >= 0) {
                turnBlocks.push({ type: 'tool-placeholder', toolCallIdx });
                seenCount[name] = prevCount + 1;
              }
            }
          }
        }
      }

      // 도구 실행
      const toolResults: ToolResult[] = [];
      for (const tc of toolCalls) {
        const argsPreview = JSON.stringify(tc.args).slice(0, 120);
        this.logger.info(`[AiManager] [${corrId}] Tool: ${tc.name} ${argsPreview}`);
        executedActions.push(tc.name);
        onToolCall?.({ name: tc.name, status: 'start' });

        // 승인 게이트 — 위험 도구는 pending으로 저장 후 사용자 승인 대기
        const approval = await this.checkNeedsApproval(tc);
        let result: Record<string, unknown>;
        if (approval) {
          const { createPending } = await import('../../lib/pending-tools');
          const planId = createPending(tc.name, tc.args as Record<string, unknown>, approval.summary);
          pendingActions.push({ planId, name: tc.name, summary: approval.summary, args: tc.args as Record<string, unknown> });
          result = { success: true, pending: true, planId, message: `'${approval.summary}' — 사용자 승인 대기 중입니다. 자동으로 실행되지 않았습니다.` };
          this.logger.info(`[AiManager] [${corrId}] Tool 승인 대기: ${tc.name} (planId=${planId}) — ${approval.summary}`);
        } else {
          result = await this.executeToolCall(tc, isDemo);
        }
        toolResults.push({ name: tc.name, result });

        if (result.success === false) {
          this.logger.warn(`[AiManager] [${corrId}] Tool 실패: ${tc.name} — ${(result.error as string || '').slice(0, 200)}`);
          onToolCall?.({ name: tc.name, status: 'error', error: result.error as string });
        } else {
          const resultPreview = JSON.stringify(result).slice(0, 200);
          this.logger.info(`[AiManager] [${corrId}] Tool 결과: ${tc.name} — ${resultPreview}`);
          onToolCall?.({ name: tc.name, status: 'done' });
        }

        // suggest 도구는 suggestions에 저장
        if (tc.name === 'suggest' && tc.args.suggestions) {
          suggestions = tc.args.suggestions as unknown[];
        }
        // render_html 결과 수집 (프론트엔드에서 iframe 렌더링)
        if (tc.name === 'render_html' && result.success !== false && result.htmlContent) {
          collectedData.push({ htmlContent: result.htmlContent, htmlHeight: result.htmlHeight });
        }
      }

      // turn 블록 → 최종 blocks로 변환 (placeholder를 실제 결과로 치환)
      // 중간 턴(tools>0) text는 전부 버림 — Gemini가 매 턴 commentary 재생성하는 버릇 차단.
      // 최종 턴(tools=0) text만 사용자 응답으로 사용됨 (위 `if (toolCalls.length === 0)` 경로).
      const toolPointer: Record<string, number> = {};
      for (const tb of turnBlocks) {
        if (tb.type === 'text') continue; // 중간 턴 해설 폐기
        const tc = toolCalls[tb.toolCallIdx];
        if (!tc) continue;
        const name = tc.name;
        // 같은 이름의 도구에서 N번째 결과 찾기
        const sameNameResults = toolResults.filter(r => r.name === name);
        const idx = toolPointer[name] || 0;
        const result = sameNameResults[idx]?.result as Record<string, unknown> | undefined;
        toolPointer[name] = idx + 1;
        if (!result || result.success === false) continue;
        if (name === 'render_html' && result.htmlContent) {
          blocks.push({ type: 'html', htmlContent: result.htmlContent as string, htmlHeight: result.htmlHeight as string | undefined });
        } else if (name === 'render_pagespec' && result.component) {
          blocks.push({ type: 'component', name: result.component as string, props: (result.props as Record<string, unknown>) ?? {} });
        }
      }

      // 교환 히스토리에 추가 (rawModelParts 보존 → 멀티턴 시 thought_signature 유지)
      toolExchanges.push({ toolCalls, toolResults, rawModelParts });

      // 텍스트 응답이 있으면 누적
      if (text) finalReply = text;
    }

    // Fallback: MAX_TOOL_TURNS 소진 등으로 최종 턴 도달 못한 경우, 마지막 중간 turn의 text라도 사용
    if (!finalReply && blocks.length > 0) {
      // 이 시점에 finalReply는 마지막 intermediate turn의 text로 세팅됨 (루프 안 `if (text) finalReply = text`)
    }
    if (finalReply && !blocks.some(b => b.type === 'text')) {
      blocks.push({ type: 'text', text: finalReply });
    }

    const totalMs = Date.now() - startTime;
    this.logger.info(`[AiManager] [${corrId}] [${modelId}] Function Calling 완료 (${executedActions.length}개 도구, ${totalMs}ms)`);

    return {
      success: true,
      reply: finalReply,
      executedActions,
      data: collectedData.length > 0 || suggestions.length > 0 || pendingActions.length > 0 || blocks.length > 0
        ? {
            ...(suggestions.length > 0 ? { suggestions } : {}),
            ...(collectedData.length > 0 ? { htmlItems: collectedData } : {}),
            ...(pendingActions.length > 0 ? { pendingActions } : {}),
            ...(blocks.length > 0 ? { blocks } : {}),
          }
        : undefined,
    };
  }

  /**
   * 승인 필요 여부 판정 — 위험 도구만 반환, 아니면 null
   *  write_file/save_page: 기존 존재 시만 (덮어쓰기=수정)
   *  delete_file/delete_page/schedule_task: 항상
   */
  private async checkNeedsApproval(tc: ToolCall): Promise<{ summary: string } | null> {
    switch (tc.name) {
      case 'write_file': {
        const path = (tc.args as { path?: string }).path;
        if (!path) return null;
        const exists = await this.core.readFile(path);
        if (!exists.success) return null; // 새 파일은 즉시 작성
        return { summary: `파일 수정: ${path}` };
      }
      case 'save_page': {
        const slug = (tc.args as { slug?: string }).slug;
        if (!slug) return null;
        const exists = await this.core.getPage(slug);
        if (!exists.success) return null; // 새 페이지는 즉시 저장
        return { summary: `페이지 수정: /${slug}` };
      }
      case 'delete_file': {
        const path = (tc.args as { path?: string }).path;
        return { summary: `파일 삭제: ${path ?? '(unknown)'}` };
      }
      case 'delete_page': {
        const slug = (tc.args as { slug?: string }).slug;
        return { summary: `페이지 삭제: /${slug ?? '(unknown)'}` };
      }
      case 'schedule_task': {
        const args = tc.args as { title?: string; cronTime?: string; runAt?: string; delaySec?: number };
        const when = args.cronTime ?? args.runAt ?? (args.delaySec != null ? `${args.delaySec}초 후` : '');
        return { summary: `예약 등록: ${args.title ?? '(제목 없음)'} (${when})` };
      }
      default:
        return null;
    }
  }

  /** 단일 도구 호출 실행 — 결과를 Record<string, unknown>로 반환 */
  private async executeToolCall(tc: ToolCall, isDemo = false): Promise<Record<string, unknown>> {
    try {
      switch (tc.name) {
        case 'write_file': {
          const { path, content } = tc.args as { path: string; content: string };
          if (content == null) return { success: false, error: 'content가 비어 있습니다' };
          const res = await this.core.writeFile(path, content);
          return res.success ? { success: true } : { success: false, error: res.error };
        }
        case 'read_file': {
          const { path, lines } = tc.args as { path: string; lines?: number };
          const res = await this.core.readFile(path);
          if (!res.success) return { success: false, error: res.error };
          let text = res.data || '';
          if (lines && text.split('\n').length > lines) {
            text = text.split('\n').slice(0, lines).join('\n') + `\n... (truncated to ${lines} lines)`;
          }
          return { success: true, content: text };
        }
        case 'list_dir': {
          const { path } = tc.args as { path: string };
          const res = await this.core.listFiles(path);
          return res.success ? { success: true, items: res.data } : { success: false, error: res.error };
        }
        case 'append_file': {
          const { path, content } = tc.args as { path: string; content: string };
          const readRes = await this.core.readFile(path);
          const combined = readRes.success ? readRes.data + '\n' + content : content;
          const res = await this.core.writeFile(path, combined);
          return res.success ? { success: true } : { success: false, error: res.error };
        }
        case 'delete_file': {
          const { path } = tc.args as { path: string };
          const res = await this.core.deleteFile(path);
          return res.success ? { success: true } : { success: false, error: res.error };
        }
        case 'execute': {
          const { path, inputData } = tc.args as { path: string; inputData?: Record<string, unknown> };
          const res = await this.core.sandboxExecute(path, inputData ?? {});
          if (!res.success) return { success: false, error: res.error };
          if (res.data?.success === false) return { success: false, error: JSON.stringify(res.data) };
          return { success: true, data: res.data };
        }
        case 'network_request': {
          const { url, method, body, headers } = tc.args as {
            url: string; method?: string; body?: string; headers?: Record<string, string>;
          };
          const res = await this.core.networkFetch(url, { method: method as 'GET', body, headers });
          return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
        }
        case 'save_page': {
          const { slug, spec } = tc.args as { slug: string; spec: Record<string, unknown> };
          const specStr = JSON.stringify(spec);
          const res = await this.core.savePage(slug, specStr);
          return res.success ? { success: true, slug, url: `/${slug}` } : { success: false, error: res.error };
        }
        case 'delete_page': {
          const { slug } = tc.args as { slug: string };
          const res = await this.core.deletePage(slug);
          return res.success ? { success: true } : { success: false, error: res.error };
        }
        case 'list_pages': {
          const res = await this.core.listPages();
          return res.success ? { success: true, pages: res.data } : { success: false, error: res.error };
        }
        case 'schedule_task': {
          const args = tc.args as Record<string, unknown>;
          const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const res = await this.core.scheduleCronJob(jobId, (args.targetPath as string) ?? '', {
            cronTime: args.cronTime as string | undefined,
            runAt: args.runAt as string | undefined,
            delaySec: args.delaySec as number | undefined,
            startAt: args.startAt as string | undefined,
            endAt: args.endAt as string | undefined,
            inputData: args.inputData as Record<string, unknown> | undefined,
            pipeline: args.pipeline as unknown[] as import('../ports').PipelineStep[] | undefined,
            title: args.title as string | undefined,
            oneShot: args.oneShot as boolean | undefined,
          });
          return res.success ? { success: true, jobId } : { success: false, error: res.error };
        }
        case 'cancel_task': {
          const { jobId } = tc.args as { jobId: string };
          const res = await this.core.cancelCronJob(jobId);
          return res.success ? { success: true } : { success: false, error: res.error };
        }
        case 'list_tasks': {
          const jobs = this.core.listCronJobs();
          return { success: true, cronJobs: jobs };
        }
        case 'database_query': {
          const { query, params } = tc.args as { query: string; params?: unknown[] };
          const res = await this.core.queryDatabase(query, params);
          return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
        }
        case 'open_url': {
          return { success: true, openUrl: tc.args.url };
        }
        case 'request_secret': {
          return { success: true, requestSecret: true, name: tc.args.name, prompt: tc.args.prompt, helpUrl: tc.args.helpUrl };
        }
        case 'run_task': {
          const pipeline = tc.args.pipeline as import('../ports').PipelineStep[];
          const taskRes = await this.core.runTask(pipeline);
          return taskRes.success ? { success: true, data: taskRes.data } : { success: false, error: taskRes.error };
        }
        case 'mcp_call': {
          if (isDemo) return { success: false, error: 'MCP는 데모 모드에서 사용할 수 없습니다.' };
          const { server, tool, arguments: args } = tc.args as { server: string; tool: string; arguments?: Record<string, unknown> };
          const res = await this.core.callMcpTool(server, tool, args ?? {});
          return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
        }
        case 'render_pagespec': {
          // PageSpec 컴포넌트 인라인 렌더 (React 컴포넌트 직접)
          const args = tc.args as { type?: string; props?: Record<string, unknown> };
          if (!args.type) return { success: false, error: 'type 필수' };
          return { success: true, component: args.type, props: args.props ?? {} };
        }
        case 'render_html': {
          // CDN 라이브러리 자동 삽입
          const cdnMap: Record<string, string> = {
            d3: '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>',
            mermaid: '<script src="https://cdn.jsdelivr.net/npm/mermaid@10"></script>',
            leaflet: '<link rel="stylesheet" href="https://unpkg.com/leaflet@1/dist/leaflet.css"/><script src="https://unpkg.com/leaflet@1/dist/leaflet.js"></script>',
            threejs: '<script src="https://cdn.jsdelivr.net/npm/three@0.160/build/three.min.js"></script>',
            animejs: '<script src="https://cdn.jsdelivr.net/npm/animejs@3/lib/anime.min.js"></script>',
            tailwindcss: '<script src="https://cdn.tailwindcss.com"></script>',
            katex: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"/><script src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16/dist/contrib/auto-render.min.js"></script>',
            hljs: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css"/><script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>',
            marked: '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
            cytoscape: '<script src="https://cdn.jsdelivr.net/npm/cytoscape@3/dist/cytoscape.min.js"></script>',
            mathjax: '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>',
            echarts: '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>',
            p5: '<script src="https://cdn.jsdelivr.net/npm/p5@1/lib/p5.min.js"></script>',
            lottie: '<script src="https://cdn.jsdelivr.net/npm/lottie-web@5/build/player/lottie.min.js"></script>',
            datatables: '<link rel="stylesheet" href="https://cdn.datatables.net/1.13.7/css/jquery.dataTables.min.css"/><script src="https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js"></script><script src="https://cdn.datatables.net/1.13.7/js/jquery.dataTables.min.js"></script>',
            swiper: '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css"/><script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>',
          };
          const libs = (tc.args.libraries as string[] | undefined) || [];
          const cdnTags = libs.map(l => cdnMap[l]).filter(Boolean).join('\n');
          let html = tc.args.html as string;
          if (cdnTags) {
            // <head>가 있으면 그 안에, 없으면 html 앞에 삽입
            if (html.includes('</head>')) {
              html = html.replace('</head>', `${cdnTags}\n</head>`);
            } else if (html.includes('<body')) {
              html = html.replace(/<body/i, `${cdnTags}\n<body`);
            } else {
              html = `${cdnTags}\n${html}`;
            }
          }
          return { success: true, htmlContent: html, htmlHeight: tc.args.height || '400px' };
        }
        case 'suggest': {
          // suggest는 프론트엔드에서 처리 — 도구 결과로 확인만 전달
          return { success: true, displayed: true };
        }
        default: {
          // sysmod_ 접두사 → 시스템 모듈 실행으로 라우팅
          if (tc.name.startsWith('sysmod_')) {
            const modPath = this._sysmodPaths.get(tc.name);
            if (!modPath) return { success: false, error: `시스템 모듈 경로를 찾을 수 없습니다: ${tc.name}` };
            const res = await this.core.sandboxExecute(modPath, tc.args);
            if (!res.success) return { success: false, error: res.error };
            if (res.data?.success === false) return { success: false, error: JSON.stringify(res.data) };
            return { success: true, data: res.data };
          }
          // mcp_ 접두사 동적 도구 → MCP 호출로 라우팅
          if (tc.name.startsWith('mcp_')) {
            if (isDemo) return { success: false, error: 'MCP는 데모 모드에서 사용할 수 없습니다.' };
            // mcp_{server}_{tool} → server, tool 분리
            const parts = tc.name.slice(4).split('_');
            const server = parts[0];
            const tool = parts.slice(1).join('_');
            const res = await this.core.callMcpTool(server, tool, tc.args);
            return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
          }
          return { success: false, error: `알 수 없는 도구: ${tc.name}` };
        }
      }
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Gemini가 text 안에 tool call JSON / 마크다운 표를 토해내는 버릇 제거.
   * 1) fenced JSON 코드블록 중 tool-ish 속성이 보이는 것
   * 2) // render_pagespec 호출: 같은 주석 prefix + JSON 블록
   * 3) fence 없이 "json\n{...}" 로 시작하는 단독 JSON 블록
   */
  private stripToolLeakage(input: string): string {
    if (!input) return '';
    let out = input;
    const KEYWORDS = 'StockChart|Table|Alert|Card|Grid|Badge|Progress|Header|Text|List|Divider|Countdown|Chart|render_html|render_pagespec|render_stock_chart|execute|run_task|schedule_task|sysmod_|mcp_call';
    // 1) ```lang?\n(// 주석\n)? { ... "type|render_...":"... 키워드..." ... }\n```
    out = out.replace(
      new RegExp(
        '```(?:json|\\w*)?\\s*\\n?(?:\\/\\/[^\\n]*\\n)*\\{[\\s\\S]*?"(?:type|chart|tool|functionCall|render_html|render_pagespec|execute|run_task|schedule_task|sysmod_[\\w]+|mcp_call)"\\s*:\\s*"?(?:' + KEYWORDS + ')[\\s\\S]*?\\}\\s*\\n?```',
        'g',
      ),
      '',
    );
    // 2) 주석 라인 제거
    // 영문: // render_xxx, // functionCall, // tool, // call
    out = out.replace(/^\s*\/\/\s*(?:render_\w+|functionCall|tool|call)[^\n]*\n?/gm, '');
    // 컴포넌트명 + 한글 동사: // Table 컴포넌트 호출, // Alert 호출, // StockChart 렌더링 등
    out = out.replace(/^\s*\/\/\s*(?:StockChart|Table|Alert|Card|Grid|Badge|Progress|Header|Text|List|Divider|Countdown|Chart|Html|Image|Button|Form|Slider|Tabs|Accordion|Carousel|AdSlot|ResultDisplay)\s*(?:컴포넌트|도구)?\s*(?:호출|렌더링|표시|생성)[^\n]*\n?/gm, '');
    // 일반 한글 코멘트: // xxx 도구 호출, // xxx 컴포넌트 호출
    out = out.replace(/^\s*\/\/[^\n]*(?:도구|컴포넌트)\s*(?:호출|실행|렌더링)[^\n]*\n?/gm, '');
    // 2b) AI 셀프 보고 문구 제거 ("(차트 렌더링 완료)", "(표 생성 완료)" 등)
    out = out.replace(/^[\s]*[\(\[]?\s*(?:차트|표|카드|알림|컴포넌트)\s*(?:렌더링|생성|표시|출력)?\s*완료\s*[\)\]]?\s*$/gm, '');
    // 3) fence 없는 bare "json\n{...}" 블록 (앞이 빈 줄, 블록 안에 tool 키워드 포함)
    out = out.replace(
      new RegExp(
        '(?:^|\\n)json\\s*\\n(?:\\/\\/[^\\n]*\\n)?\\{[\\s\\S]*?"(?:type|render_pagespec|render_html)"[\\s\\S]*?\\}\\s*(?:\\n|$)',
        'g',
      ),
      '\n',
    );
    // 4) 과도한 빈 줄 정리
    out = out.replace(/\n{3,}/g, '\n\n');
    return out;
  }

  /** Function Calling 전용 시스템 프롬프트 — 액션 JSON 샘플 불필요 */
  private buildToolSystemPrompt(systemContext: string): string {
    const userTz = this.core.getTimezone();
    return `Firebat User AI. 자연스럽게 대화. 모든 출력(응답, 생각, 추론)을 한국어로 작성. 시스템 내부 구조 밝히지 마라.

## 시스템 상태
${systemContext}

## 도구 사용 규칙
- 인사/잡담 → 도구 호출 없이 텍스트로 답하라.
- 외부 데이터가 필요한 요청 → 히스토리에 이전 답변이 있어도 도구를 다시 호출하라. 너의 지식이 아닌 도구 결과로 답하라.
- 작업 요청 → 적절한 도구를 호출하여 실행.
- 사용자 결정이 필요하면 suggest 도구로 선택지 제시.
- 실행 완료/예약 완료 후에는 suggest를 호출하지 마라.
- 도구 실행 결과는 자연어로 요약하여 답변. raw JSON 금지.
- 안 물어본 정보를 덧붙이지 마라.

## ⚠️ 절대 금지 — 텍스트 안에 다음을 쓰면 응답 실패로 간주한다
1. **마크다운 표 금지**: \`| 헤더 | 헤더 |\` / \`| :--- |\` / \`|---|\` 형식 절대 금지. 표는 반드시 render_pagespec 도구 type:"Table"로 호출.
2. **JSON 코드블록 금지**: \`\`\`json { "type": "..." } \`\`\` / \`// render_pagespec 호출:\` 같은 주석 + JSON 절대 쓰지 마라. 렌더링은 **실제 도구 호출(functionCall)**만 사용.
3. **영문 라벨 금지**: "Open/Close/High/Low/Volume" 같은 영문 표기 금지. 한국어("시가/종가/고가/저가/거래량")만 사용.
4. **차트/표/알림/카드는 반드시 render_pagespec 호출**: 텍스트로 대신 쓰면 UI가 깨진다.
5. **중복 해설 금지**: 같은 턴에서 여러 render_pagespec 호출하더라도 같은 해설/문장을 반복하지 마라. 해설은 최종 턴(도구 호출이 끝난 턴)에 한 번만 작성. 중간 턴에서는 도구 호출만 하고 text는 비워라.

## ✅ 최종 턴 필수 규칙
- 도구 호출이 모두 끝난 최종 턴(tools=0)에서 사용자에게 전달할 **종합 해설**을 작성하라.
- **모든 도구 결과를 빠짐없이 반영**: 조회한 시세/뉴스/데이터 중 생략 없이 의미 있는 수치·핵심·인사이트를 정리.
- 중간 턴에서 하려던 모든 말(요약, 주의사항, 결론, 권장)을 여기 한 번에 담아라. 중간 턴 해설은 사용자에게 전달되지 않으니 이 한 번이 유일한 기회.

## 리치 응답 패턴 (권장)
주식 분석, 데이터 비교, 지표 요약 같은 구조화된 답변:
1. 짧은 도입 텍스트 (1-2문장)
2. render_pagespec(type:"StockChart") — 차트
3. render_pagespec(type:"Table") — 수치 표
4. render_pagespec(type:"Alert") — 주의사항
5. 마무리 텍스트 (해설)

## 쓰기 구역
user/modules/[name]/ 만. core/, infra/, system/, app/ 금지.

## 모듈
- I/O: stdin JSON → stdout JSON. sys.argv 금지. Python: True/False/None.
- config.json 필수 (name, type, scope, runtime, packages, input, output).
- API 키: config.json secrets 배열 등록 → 환경변수 자동 주입. 하드코딩 금지.
- 미등록 키 → request_secret (다른 도구 앞에 호출). 키 이름은 kebab-case.

## 시스템 모듈
시스템 모듈은 sysmod_ 접두사 도구로 직접 호출 가능.
같은 capability 모듈이 여러 개면 [시스템 모듈] 목록 순서 첫 번째 사용. 실패하면 시스템이 자동 폴백.

## 인라인 HTML 렌더링
- render_html: 대화창에 차트/그래프/대시보드를 직접 표시. 별도 페이지 생성 불필요.
- 시각화 요청 시 render_html 우선 사용. 저장 요청 시 save_page.
- 반응형 필수: width 100%, responsive:true. 고정 px 폭 금지.
- 한국어 통일: 제목·축 레이블·범례·tooltip·날짜 포맷·단위 모두 한국어 (예: '2026년 4월', '3월 15일', 'Volume'→'거래량', 'Open'→'시가', 'Close'→'종가').
- 숫자 3자리 콤마: 가격/금액/거래량 등 모든 수치. (예: 216,500원, 5,145,052,576원, 24,092,884주). Intl.NumberFormat('ko-KR') 또는 toLocaleString('ko-KR') 사용.
- 날짜는 YYYY-MM-DD 또는 'M월 D일' 형식. Jan/Feb 같은 영어 약어 금지.

## 스케줄링
시간 기준: ${userTz}. 현재: ${new Date().toLocaleString('ko-KR', { timeZone: userTz })}
모드: cronTime(반복), runAt(1회, ISO 8601), delaySec(N초 후).
즉시 실행 복합 작업은 run_task, 예약은 schedule_task.
크론: "분 시 일 월 요일", ${userTz} 기준.
시각이 지났으면 바로 실행할지 물어라. 자의적으로 바꾸지 마라.

## 파이프라인 ($prev 규칙)
run_task/schedule_task의 pipeline에서:
- 각 단계 결과는 자동으로 다음 단계 입력($prev).
- $prev.속성명으로 특정 필드 접근. 예: $prev.url, $prev.text.
- inputMap으로 매핑: {"url":"$prev.url"}.
- 사용자에게 결과를 보여줄 때는 마지막 단계를 LLM_TRANSFORM으로 끝내라.

## 파이프라인 스텝 타입 — 이 5가지만 허용
- EXECUTE: 시스템/유저 모듈 실행. path 필수 (예: "system/modules/kiwoom/index.mjs"), inputData로 인자 전달.
- MCP_CALL: 외부 MCP 서버 호출. server 필수 + [MCP 외부 도구] 목록에 등록된 서버만 가능. **시스템 모듈(sysmod_*)은 MCP_CALL이 아니다 — EXECUTE로 호출**.
- NETWORK_REQUEST: HTTP 요청. url 필수.
- LLM_TRANSFORM: LLM으로 데이터 가공/요약. instruction 필수.
- CONDITION: 조건 검사 (false면 파이프라인 중단). field(예:"$prev.price") + op(">=","==","!=","<","<=",">","contains") + value 필수.
- **시스템 모듈(sysmod_xxx)은 반드시 EXECUTE**: path="system/modules/{name}/index.mjs" 또는 "main.py".

## suggest 도구 사용법
- 단순 확인/예/아니오 → **string 배열** (버튼). 예: ["네, 시작해주세요", "취소"]
- 자유 텍스트 입력 필요 → {type:"input", label, placeholder}
- 다중 선택 → {type:"toggle", label, options, defaults}
- 단순 확인을 input 타입으로 쓰지 마라.

## 앱/페이지 생성 — 3단계 공동 설계
1단계(기능 선택): suggest 도구로 toggle 선택지 제시.
2단계(디자인 선택): suggest 도구로 스타일 선택지 제시.
3단계(구현): save_page 도구로 PageSpec 저장.
- PageSpec: slug, status:"published", project, head(title, description, keywords, og), body([{type:"Html", props:{content:"..."}}])
- og 필드 필수. HTML+CSS+JS 자유. 프로덕션 수준 디자인.
- localStorage/sessionStorage 금지 (sandbox). vw 단위 금지 (100%).

## 마크다운 규칙
- 코드 블록(\`\`\`)은 실제 코드에만 사용. 일반 텍스트·제목·링크·강조에 코드 블록 사용 금지.
- 강조는 **볼드**, 제목은 ##, 목록은 - 사용.

## 금지
- [Kernel Block] 에러 → 도구 호출 중단. 우회 금지.
- 시스템 내부 코드 설명/출력 금지.`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Function Calling — 도구 정의 빌더
  // ══════════════════════════════════════════════════════════════════════════

  /** 파이프라인 단계 JSON Schema — RUN_TASK, SCHEDULE_TASK에서 재사용 */
  private get pipelineStepSchema(): JsonSchema {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'EXECUTE | MCP_CALL | NETWORK_REQUEST | LLM_TRANSFORM | CONDITION', enum: ['EXECUTE', 'MCP_CALL', 'NETWORK_REQUEST', 'LLM_TRANSFORM', 'CONDITION'] },
        description: { type: 'string', description: '단계 설명' },
        path: { type: 'string', description: 'EXECUTE: 모듈 경로 (예: system/modules/kiwoom/index.mjs)' },
        inputData: { type: 'object', description: '이 단계(EXECUTE/NETWORK_REQUEST)의 자체 입력. EXECUTE는 거의 항상 필요 (예: {action, symbol}).', additionalProperties: true },
        inputMap: { type: 'object', description: '$prev 매핑 (예: {"url":"$prev.url"})', additionalProperties: true },
        server: { type: 'string', description: 'MCP_CALL: 서버 이름' },
        tool: { type: 'string', description: 'MCP_CALL: 도구 이름' },
        arguments: { type: 'object', description: 'MCP_CALL: 도구 인자', additionalProperties: true },
        url: { type: 'string', description: 'NETWORK_REQUEST: URL' },
        method: { type: 'string', description: 'NETWORK_REQUEST: HTTP 메서드', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        headers: { type: 'object', description: 'NETWORK_REQUEST: HTTP 헤더', additionalProperties: true },
        body: { type: 'string', description: 'NETWORK_REQUEST: 요청 본문' },
        instruction: { type: 'string', description: 'LLM_TRANSFORM: 변환 지시문' },
        field: { type: 'string', description: 'CONDITION: 검사 대상 ($prev, $prev.price 등)' },
        op: { type: 'string', description: 'CONDITION: 비교 연산자', enum: ['==', '!=', '<', '<=', '>', '>=', 'includes', 'not_includes', 'exists', 'not_exists'] },
        value: { type: 'string', description: 'CONDITION: 비교 값 (숫자 또는 문자열)' },
      },
      required: ['type'],
    };
  }

  /** 정적 Core 액션 도구 정의 — FirebatAction 타입에서 파생 */
  private getCoreToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'write_file',
        description: '파일 생성/덮어쓰기. user/modules/ 내부만 허용.',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', description: '저장할 파일 경로 (예: user/modules/weather/main.py)' },
            content: { type: 'string', description: '파일 내용 전체' },
          },
        },
      },
      {
        name: 'read_file',
        description: '파일 내용 읽기.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '읽을 파일 경로' },
            lines: { type: 'integer', description: '처음 N줄만 읽기 (선택)' },
          },
        },
      },
      {
        name: 'list_dir',
        description: '디렉토리 내 파일/폴더 목록 조회.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '조회할 폴더 경로 (예: user/modules)' },
          },
        },
      },
      {
        name: 'append_file',
        description: '파일 끝에 내용 추가.',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string', description: '추가할 파일 경로' },
            content: { type: 'string', description: '추가할 내용' },
          },
        },
      },
      {
        name: 'delete_file',
        description: '파일 또는 폴더 삭제.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '삭제할 경로' },
          },
        },
      },
      {
        name: 'execute',
        description: '모듈 실행. 시스템/사용자 모듈의 경로와 입력 데이터를 전달.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: '실행할 모듈 경로 (예: system/modules/firecrawl/index.mjs)' },
            inputData: { type: 'object', description: '모듈 입력 데이터', additionalProperties: true },
          },
        },
      },
      {
        name: 'network_request',
        description: 'HTTP 요청 실행.',
        parameters: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: '요청 URL' },
            method: { type: 'string', description: 'HTTP 메서드', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
            body: { type: 'string', description: '요청 본문 (JSON 문자열)' },
            headers: { type: 'object', description: 'HTTP 헤더', additionalProperties: true },
          },
        },
      },
      {
        name: 'save_page',
        description: '페이지 생성/수정. PageSpec JSON으로 저장.',
        parameters: {
          type: 'object',
          required: ['slug', 'spec'],
          properties: {
            slug: { type: 'string', description: '페이지 URL 슬러그 (kebab-case)' },
            spec: { type: 'object', description: 'PageSpec JSON (slug, head, body 포함)', additionalProperties: true },
          },
        },
      },
      {
        name: 'delete_page',
        description: '페이지 삭제.',
        parameters: {
          type: 'object',
          required: ['slug'],
          properties: {
            slug: { type: 'string', description: '삭제할 페이지 slug' },
          },
        },
      },
      {
        name: 'list_pages',
        description: 'DB에 저장된 페이지 목록 조회.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'schedule_task',
        description: '모듈/파이프라인 예약 실행 등록. 반복(cronTime), 1회(runAt), 지연(delaySec). 가격 알림 등 "조건 충족 시 1회 알림" 패턴은 cronTime + oneShot:true + CONDITION 스텝 조합.',
        parameters: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', description: '사이드바에 표시할 짧은 이름' },
            targetPath: { type: 'string', description: '단순 모듈 실행 시 경로 (pipeline 미사용 시에만)' },
            inputData: { type: 'object', description: 'targetPath 단일 실행용 입력. pipeline을 쓸 때는 이 필드 사용 금지 — 각 step의 inputData에 넣어라.', additionalProperties: true },
            pipeline: { type: 'array', description: '복합 작업 파이프라인. 각 step은 자체 inputData를 가져야 한다.', items: this.pipelineStepSchema },
            cronTime: { type: 'string', description: '반복 크론 표현식 (예: "0 9 * * *"). 주식 관련 스케줄은 평일 한정 "1-5" 요일 지정 필수.' },
            runAt: { type: 'string', description: '1회 실행 시각 (ISO 8601)' },
            delaySec: { type: 'number', description: 'N초 후 실행' },
            startAt: { type: 'string', description: '시작 시각 (ISO 8601)' },
            endAt: { type: 'string', description: '종료 시각 (ISO 8601)' },
            oneShot: { type: 'boolean', description: '첫 성공 시 자동 취소. 가격 알림 같은 "조건 충족 후 1회만" 케이스는 반드시 true. CONDITION 스텝 미충족 시에는 취소 안 되고 다음 주기에 재시도.' },
          },
        },
      },
      {
        name: 'cancel_task',
        description: '예약된 스케줄 해제.',
        parameters: {
          type: 'object',
          required: ['jobId'],
          properties: {
            jobId: { type: 'string', description: '해제할 잡 ID' },
          },
        },
      },
      {
        name: 'list_tasks',
        description: '등록된 스케줄(크론) 목록 조회.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'database_query',
        description: 'SQL 쿼리 실행.',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'SQL 쿼리 문자열' },
            params: { type: 'array', description: '바인딩 파라미터', items: { type: 'string' } },
          },
        },
      },
      {
        name: 'open_url',
        description: '새 탭에서 URL 열기.',
        parameters: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: 'URL 또는 경로 (예: /bmi-calculator)' },
          },
        },
      },
      {
        name: 'request_secret',
        description: '사용자에게 API 키 입력 요청. 프론트엔드에 입력 UI 표시.',
        parameters: {
          type: 'object',
          required: ['name', 'prompt'],
          properties: {
            name: { type: 'string', description: '시크릿 키 이름 (kebab-case)' },
            prompt: { type: 'string', description: '사용자 안내 메시지' },
            helpUrl: { type: 'string', description: 'API 키 발급 안내 URL (선택)' },
          },
        },
      },
      {
        name: 'run_task',
        description: '파이프라인 즉시 실행. 복합 작업(스크래핑→요약→발송 등)에 사용.',
        parameters: {
          type: 'object',
          required: ['pipeline'],
          properties: {
            pipeline: { type: 'array', description: '실행할 파이프라인 단계 배열', items: this.pipelineStepSchema },
          },
        },
      },
      {
        name: 'mcp_call',
        description: '외부 MCP 서버 도구 호출.',
        parameters: {
          type: 'object',
          required: ['server', 'tool'],
          properties: {
            server: { type: 'string', description: 'MCP 서버 이름 (예: gmail)' },
            tool: { type: 'string', description: '도구 이름' },
            arguments: { type: 'object', description: '도구 인자', additionalProperties: true },
          },
        },
      },
      {
        name: 'render_pagespec',
        description: `채팅에 인라인 컴포넌트 렌더링 (iframe 없음, React 직접 렌더). 클로드 스타일 풍부한 응답 가능 — 텍스트 사이사이에 Card/Table/StockChart 등을 배치할 수 있음.

**사용 가능한 타입:**
- StockChart: 주식 차트 {symbol, title(**종목 한글명 필수** 예:"삼성전자"), data[{date,open,high,low,close,volume}], indicators?, buyPoints?, sellPoints?}. 최소 10일 이상 데이터 권장. title에 심볼 코드("005930") 넣지 마라.
- Card: 카드 {children: Component[]}
- Grid: 그리드 {columns, children: Component[]}
- Table: 표 {headers: [], rows: [][]}
- Badge: 뱃지 {text, color}
- Alert: 알림 {message, type: 'info'|'warn'|'error'|'success', title?}
- Progress: 진행률 {value, max?, label?, color?}
- Header: 제목 {text, level?}
- Text: 본문 {content}  (대부분 일반 텍스트 블록으로 충분)
- List: 목록 {items: [], ordered?}
- Divider: 구분선
- Countdown: 카운트다운 {targetDate, label?}
- Chart: 단순 차트 {chartType: 'bar'|'line'|'pie'|'doughnut', data, labels, title?}

주식 시각화는 반드시 StockChart 사용 (render_html 자유 HTML보다 우선). 데이터 표는 Table, 강조 알림은 Alert, 통계 묶음은 Grid+Card.

**중요 — 텍스트에 직접 쓰지 말고 컴포넌트 써라:**
- 표 데이터는 반드시 Table 컴포넌트. 절대 markdown \`| --- |\` 테이블로 쓰지 마라 (스트리밍 분할 시 파싱 실패).
- 목록이 3개 이상이면 List 컴포넌트. 짧으면 텍스트에 \`- \` 리스트 OK.
- 강조/경고 박스는 Alert 컴포넌트 (\`**주의**\` 같은 텍스트 금지).`,
        parameters: {
          type: 'object',
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              enum: [
                'Header', 'Text', 'Image', 'Divider',
                'Table', 'Card', 'Grid',
                'Progress', 'Badge', 'Alert', 'List',
                'Countdown', 'Chart', 'StockChart',
              ],
              description: '컴포넌트 타입',
            },
            props: { type: 'object', description: '컴포넌트 props (타입별 다름)', additionalProperties: true },
          },
        },
      },
      {
        name: 'render_html',
        description: '자유 HTML 인라인 렌더링 (iframe). 정형화된 UI는 render_pagespec 우선 사용. render_html은 지도/다이어그램/애니메이션/수학식 등 CDN 라이브러리 필요할 때만. CDN은 libraries 파라미터로 선택.',
        parameters: {
          type: 'object',
          required: ['html'],
          properties: {
            html: { type: 'string', description: '렌더링할 HTML (body 내용 또는 완전한 HTML 문서). libraries에서 선택한 CDN은 자동 삽입됨.' },
            height: { type: 'string', description: 'iframe 높이 (기본 400px). 예: "500px", "60vh"' },
            libraries: {
              type: 'array',
              description: '사용할 CDN 라이브러리 목록. 선택하면 자동으로 <script>/<link> 태그가 HTML <head>에 삽입됨.',
              items: {
                type: 'string',
                enum: ['d3', 'mermaid', 'leaflet', 'threejs', 'animejs', 'tailwindcss', 'katex', 'hljs', 'marked', 'cytoscape', 'mathjax', 'p5', 'lottie', 'datatables', 'swiper'],
              },
            },
          },
        },
      },
      {
        name: 'suggest',
        description: '사용자에게 선택지를 제시. 대화형 흐름에서 사용자 결정이 필요할 때 호출.',
        parameters: {
          type: 'object',
          required: ['suggestions'],
          properties: {
            suggestions: {
              type: 'array',
              description: '선택지 배열. 문자열=버튼, {"type":"input","label":"..","placeholder":".."}=입력, {"type":"toggle","label":"..","options":[..]}=다중 선택',
              items: { type: ['object', 'string'] },
            },
          },
        },
      },
    ];
  }

  /** 동적 도구 정의 빌드 — Core 정적 도구 + MCP 외부 도구 (60초 캐시) */
  async buildToolDefinitions(isDemo = false): Promise<ToolDefinition[]> {
    if (this._toolsCache && this._toolsCache.isDemo === isDemo && (Date.now() - this._toolsCache.ts) < AiManager.TOOLS_CACHE_TTL) {
      return this._toolsCache.tools;
    }
    const tools = [...this.getCoreToolDefinitions()];

    // 시스템 모듈 → 개별 Function Calling 도구로 자동 등록
    const sysModules = await this.core.listDir('system/modules');
    if (sysModules.success && sysModules.data) {
      for (const d of sysModules.data.filter(e => e.isDirectory)) {
        const file = await this.core.readFile(`system/modules/${d.name}/config.json`);
        if (!file.success || !file.data) continue;
        try {
          const cfg = JSON.parse(file.data);
          if (cfg.type !== 'module' || !cfg.input) continue;
          // 비활성화된 모듈은 도구 목록에서 제외
          const moduleName = cfg.name || d.name;
          if (!this.core.isModuleEnabled(moduleName)) continue;
          const rt = cfg.runtime === 'node' ? 'index.mjs' : cfg.runtime === 'python' ? 'main.py' : 'index.mjs';
          const toolName = `sysmod_${d.name.replace(/-/g, '_')}`;
          tools.push({
            name: toolName,
            description: `[시스템 모듈] ${cfg.description || d.name}`,
            parameters: sanitizeSchema(cfg.input) as unknown as JsonSchema,
          });
          // 경로 매핑 저장 (executeToolCall에서 사용)
          this._sysmodPaths.set(toolName, `system/modules/${d.name}/${rt}`);
        } catch { /* config 파싱 실패 — 무시 */ }
      }
    }

    // 데모 모드에서는 MCP 도구 제외
    if (!isDemo) {
      const mcpResult = await this.core.listAllMcpTools();
      if (mcpResult.success && mcpResult.data) {
        for (const t of mcpResult.data) {
          tools.push({
            name: `mcp_${t.server}_${t.name}`,
            description: `[MCP ${t.server}] ${t.description}`,
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
          });
        }
      }
    }

    this._toolsCache = { tools, ts: Date.now(), isDemo };
    return tools;
  }

  /** 캐시 무효화 (모듈 추가/삭제/설정 변경 시 호출) */
  invalidateCache(): void {
    this._ctxCache = null;
    this._toolsCache = null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  코드 어시스트
  // ══════════════════════════════════════════════════════════════════════════

  /** 코드 수정 제안 (FileEditor AI 어시스턴트) */
  async codeAssist(params: {
    code: string;
    language: string;
    instruction: string;
    selectedCode?: string;
  }, opts?: AiRequestOpts): Promise<InfraResult<string>> {
    const { code, language, instruction, selectedCode } = params;
    const llmOpts: LlmCallOpts | undefined = opts?.model ? { model: opts.model } : undefined;

    const systemPrompt = [
      'You are an expert code assistant.',
      'Respond with ONLY the raw code — no explanations, no markdown fences, no backticks.',
      'Preserve the original indentation style and language conventions.',
      `Target language: ${language}`,
    ].join('\n');

    const context = selectedCode
      ? `Selected code (modify this):\n${selectedCode}\n\nFull file for context:\n${code}`
      : `Full file:\n${code}`;

    const result = await this.llm.askText(`Instruction: ${instruction}\n\n${context}`, systemPrompt, llmOpts);
    if (!result.success) return result;

    const cleaned = (result.data ?? '')
      .replace(/^```[\w]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();

    return { success: true, data: cleaned };
  }
}

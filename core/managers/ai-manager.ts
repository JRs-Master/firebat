import type { FirebatCore, AiRequestOpts } from '../index';
import type { ILlmPort, ILogPort, LlmCallOpts } from '../ports';
import { FirebatPlanSchema, FirebatPlan, FirebatAction, CoreResult, type InfraResult } from '../types';

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
  constructor(
    private readonly core: FirebatCore,
    private readonly llm: ILlmPort,
    private readonly logger: ILogPort,
  ) {}

  private trainingLog(entry: object): void {
    this.logger.info(`[USER_AI_TRAINING] ${JSON.stringify(entry)}`);
  }

  private compressHistory(history: any[]): { recentHistory: any[]; contextSummary: string } {
    const WINDOW_SIZE = 8;
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
        const modInfos: string[] = [];
        for (const d of dirs) {
          const file = await this.core.readFile(`system/modules/${d.name}/module.json`);
          if (file.success && file.data) {
            try {
              const m = JSON.parse(file.data);
              const inputDesc = m.input ? Object.entries(m.input).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
              modInfos.push(`  - ${m.name}: ${m.description}${inputDesc ? ` | 입력: {${inputDesc}}` : ''}`);
            } catch {
              modInfos.push(`  - ${d.name}`);
            }
          }
        }
        lines.push(`[시스템 모듈]\n${modInfos.join('\n')}`);
      }
    }
    const pages = await this.core.listPages();
    if (pages.success && pages.data) {
      const slugs = pages.data.map((p: any) => `/${p.slug}`);
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
    // Capability 설정 (API/로컬 우선순위)
    // core 메서드에 직접 접근 불가하므로 Vault에서 직접 조회
    const capIds = ['web-scrape', 'email-send', 'image-gen', 'translate', 'notification', 'pdf-gen'];
    const capSettings: string[] = [];
    for (const id of capIds) {
      const raw = this.core.getVertexKey(`system:capability:${id}:settings`);
      if (raw) {
        try {
          const s = JSON.parse(raw);
          if (s.mode && s.mode !== 'api-first') capSettings.push(`${id}: ${s.mode}`);
        } catch {}
      }
    }
    if (capSettings.length > 0) {
      lines.push(`[Capability 설정] 기본=api-first, 변경: ${capSettings.join(', ')}`);
    } else {
      lines.push(`[Capability 설정] 전체 api-first (기본값)`);
    }

    return lines.join('\n') || '[시스템 상태 조회 실패]';
  }

  async process(prompt: string, history: any[] = [], opts?: AiRequestOpts, maxRetries = 3): Promise<CoreResult> {
    const isDemo = opts?.isDemo ?? false;
    const llmOpts: LlmCallOpts | undefined = opts?.model ? { model: opts.model } : undefined;
    let currentPrompt = prompt;
    let attempt = 0;
    const executedActions: string[] = [];
    let lastError: string | null = null;

    const timestamp = new Date().toISOString();
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

      const parseResult = FirebatPlanSchema.safeParse(cleanedData);
      if (!parseResult.success) {
        const errorDetails = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        lastError = `스키마 검증 실패: ${errorDetails}`;
        this.logger.warn(`[AiManager] [${corrId}] [${modelId}] 스키마 실패 (${llmMs}ms): ${errorDetails}`);
        currentPrompt = `[SYSTEM] JSON 스키마 위반: ${errorDetails}. 수정하여 재시도하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      const plan: FirebatPlan = parseResult.data;
      // description 누락 방어: 빈 문자열이면 type 기반 기본값 채우기
      for (const a of plan.actions) {
        if (!a.description) a.description = a.type;
      }
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Plan validated (${llmMs}ms). Thoughts: ${plan.thoughts}`);

      let executionError: string | null = null;
      const finalDataList: any[] = [];
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
          case 'TEST_RUN': {
            const res = await this.core.sandboxExecute(action.path, action.mockData);
            if (!res.success) {
              executionError = `TEST_RUN 샌드박스 오류 (${action.path}): ${res.error}`;
            } else if (res.data?.success === false) {
              executionError = `TEST_RUN 모듈 로직 오류 (${action.path}): ${JSON.stringify(res.data)}. 코드를 수정하세요.`;
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
            const res = await this.core.scheduleCronJob(action.jobId, action.targetPath ?? '', {
              cronTime: action.cronTime, runAt: action.runAt, delaySec: action.delaySec,
              startAt: action.startAt, endAt: action.endAt,
              inputData: (action as any).inputData,
              pipeline: action.pipeline,
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
          case 'SET_SECRET': {
            const saved = this.core.setUserSecret(action.name, action.value);
            if (!saved) executionError = `SET_SECRET 실패: ${action.name}`;
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
        }

        if (executionError) break;
      }

      if (executionError) {
        lastError = executionError;
        this.logger.error(`[AiManager] [${corrId}] 액션 실패: ${executionError}`);
        currentPrompt = `[SYSTEM] 실행 실패: ${executionError}\n원인을 분석하고 수정된 플랜을 제출하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      const totalMs = Date.now() - startTime;
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] 완료 (${executedActions.length}개 액션, ${totalMs}ms)`);
      this.trainingLog({
        timestamp,
        type: 'success',
        corrId,
        model: modelId,
        durationMs: totalMs,
        input: { promptPreview: prompt.slice(0, 200), historyLength: history.length },
        output: {
          thoughts: plan.thoughts,
          actions: executedActions,
          reply: plan.reply.slice(0, 200),
        },
      });
      return {
        success: true,
        thoughts: plan.thoughts,
        reply: plan.reply,
        executedActions,
        data: finalDataList.length === 1 ? finalDataList[0] : finalDataList.length > 1 ? finalDataList : undefined,
      };
    }

    const totalMs = Date.now() - startTime;
    this.logger.error(`[AiManager] [${corrId}] [${modelId}] 최종 실패 (${maxRetries}회 시도, ${totalMs}ms): ${lastError}`);
    this.trainingLog({
      timestamp,
      type: 'failure',
      corrId,
      model: modelId,
      durationMs: totalMs,
      input: { promptPreview: prompt.slice(0, 200), historyLength: history.length },
      output: { lastError },
    });
    return {
      success: false,
      executedActions,
      error: `[Max Retries Exceeded] User AI가 오류를 해결하지 못했습니다.\n마지막 오류: ${lastError ?? '알 수 없음'}`,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Plan-Execute 분리 파이프라인
  // ══════════════════════════════════════════════════════════════════════════

  /** Plan만 수립 (실행하지 않음) — 유저 확인용 */
  async planOnly(prompt: string, history: any[] = [], opts?: AiRequestOpts, maxRetries = 3): Promise<{
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

      const parseResult = FirebatPlanSchema.safeParse(cleanedData);
      if (!parseResult.success) {
        const errorDetails = parseResult.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        lastError = `스키마 검증 실패: ${errorDetails}`;
        this.logger.warn(`[AiManager] [${corrId}] [${modelId}] Plan 스키마 실패 (${llmMs}ms): ${errorDetails}`);
        currentPrompt = `[SYSTEM] JSON 스키마 위반: ${errorDetails}. 수정하여 재시도하세요. 원본 요청: "${prompt}"`;
        continue;
      }

      const plan = parseResult.data;
      // description 누락 방어: 빈 문자열이면 type 기반 기본값 채우기
      for (const a of plan.actions) {
        if (!a.description) a.description = a.type;
      }
      this.logger.info(`[AiManager] [${corrId}] [${modelId}] Plan 수립 완료 (${llmMs}ms, ${plan.actions.length}개 액션)`);
      return { success: true, plan, corrId, modelId };
    }

    return { success: false, error: lastError ?? '알 수 없음' };
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
    const finalDataList: any[] = [];

    for (let i = 0; i < plan.actions.length; i++) {
      const action = plan.actions[i];
      onStep?.({ index: i, total: plan.actions.length, type: action.type, status: 'start' });
      executedActions.push(action.type);

      const actionError = await this.executeAction(action, finalDataList, isDemo);

      if (actionError) {
        onStep?.({ index: i, total: plan.actions.length, type: action.type, status: 'error', error: actionError });
        this.logger.error(`[AiManager] [${corrId}] 액션 실패: ${actionError}`);
        return {
          success: false,
          thoughts: plan.thoughts,
          reply: plan.reply,
          executedActions,
          error: actionError,
        };
      }

      onStep?.({ index: i, total: plan.actions.length, type: action.type, status: 'done' });
    }

    const totalMs = Date.now() - startTime;
    this.logger.info(`[AiManager] [${corrId}] [${modelId}] 실행 완료 (${executedActions.length}개 액션, ${totalMs}ms)`);

    return {
      success: true,
      thoughts: plan.thoughts,
      reply: plan.reply,
      executedActions,
      data: finalDataList.length === 1 ? finalDataList[0] : finalDataList.length > 1 ? finalDataList : undefined,
    };
  }

  /** 단일 액션 실행 — 에러 문자열 반환 (성공 시 null) */
  private async executeAction(action: FirebatAction, dataList: any[], isDemo = false): Promise<string | null | undefined> {
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
      case 'TEST_RUN': {
        const res = await this.core.sandboxExecute(action.path, action.mockData);
        if (!res.success) return `TEST_RUN 샌드박스 오류 (${action.path}): ${res.error}`;
        if (res.data?.success === false) return `TEST_RUN 모듈 로직 오류 (${action.path}): ${JSON.stringify(res.data)}`;
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
        const res = await this.core.scheduleCronJob(action.jobId, action.targetPath ?? '', {
          cronTime: action.cronTime, runAt: action.runAt, delaySec: action.delaySec,
          startAt: action.startAt, endAt: action.endAt,
          inputData: (action as any).inputData,
          pipeline: action.pipeline,
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
      case 'SET_SECRET': {
        const saved = this.core.setUserSecret(action.name, action.value);
        return saved ? null : `SET_SECRET 실패: ${action.name}`;
      }
      case 'MCP_CALL': {
        if (isDemo) return 'MCP는 데모 모드에서 사용할 수 없습니다.';
        const mcpRes = await this.core.callMcpTool(action.server, action.tool, action.arguments ?? {});
        if (!mcpRes.success) return `MCP_CALL 실패 (${action.server}/${action.tool}): ${mcpRes.error}`;
        dataList.push({ mcpResult: { server: action.server, tool: action.tool, data: mcpRes.data } });
        return null;
      }
    }
  }

  /** 시스템 프롬프트 빌드 (planOnly와 process에서 공용) */
  private buildSystemPrompt(systemContext: string): string {
    const userTz = this.core.getTimezone();
    return `당신은 Firebat의 User AI다. 사용자의 모든 요청을 처리하는 전담 AI다.
자신이 무엇인지(User AI, Firebat 등) 밝히지 말고, 시스템 이름도 언급하지 마라. 그냥 자연스럽게 대화하듯 답변해라.

## 현재 시스템 상태
${systemContext}
## 응답 규칙
1. 반드시 아래 스키마를 따르는 유효한 JSON만 출력. \`\`\`json 마크다운 감싸기 절대 금지.
   {
     "thoughts": "String (Korean). 앱/페이지 생성 시에만 3단계(기능 분석, 디자인 구상, 구현 계획)로 작성. 그 외(실행, 예약, 조회, 삭제 등)는 한 줄로 간단히 판단 근거만 작성.",
     "reply": "String (Korean). 사용자에게 보여줄 대화형 답변.",
     "actions": [
       { "type": "SAVE_PAGE", "description": "날씨 페이지 UI를 생성합니다", "slug": "string", "spec": { ... } },
       { "type": "WRITE_FILE", "description": "날씨 API 연동 모듈을 작성합니다", "path": "string", "content": "string" },
       { "type": "READ_FILE", "description": "기존 설정 파일을 확인합니다", "path": "string" }
     ]
   }
   - **description 필드 (필수)**: 모든 action에 사용자가 읽을 수 있는 한국어 단계 설명을 반드시 포함. 기술 용어 대신 "~합니다" 형태의 자연스러운 설명.
   유효한 action 타입: SAVE_PAGE, DELETE_PAGE, LIST_PAGES, WRITE_FILE, READ_FILE, LIST_DIR, APPEND_FILE, DELETE_FILE, TEST_RUN, DATABASE_QUERY, NETWORK_REQUEST, SCHEDULE_TASK, CANCEL_TASK, LIST_TASKS, OPEN_URL, REQUEST_SECRET, SET_SECRET, MCP_CALL

2. 단순 대화·인사·질문 → actions: [] 로 reply만 작성. 자연스럽게 대화하듯 답변.
   **중요**: reply에 raw JSON, 기술 디버그 정보, 실행 결과 원문을 그대로 보여주지 마라. 실행 결과는 자연어로 요약하라. 예: "카카오톡으로 메시지를 보냈습니다." (O), '{"resultCode": 0, "success": true}' (X).

3. **"실행" 요청 — 기존 프로젝트를 활용하라. 새 모듈을 만들지 마라.**:
   사용자가 "X 실행해줘", "X 열어줘" 등을 요청하면:
   (a) "시스템 상태"의 [DB 페이지] 목록과 [프로젝트] 목록에서 해당 프로젝트가 있는지 먼저 확인.
   (b) **즉시 실행** ("X 실행해줘", "X 열어줘"):
       - 페이지가 있는 프로젝트 → OPEN_URL로 페이지 열기. 페이지가 곧 그 프로젝트의 UI이다.
       - 페이지 없이 모듈만 → TEST_RUN으로 기존 모듈 실행.
   (c) **예약/반복 실행** ("N분 후에 실행", "매일 9시에 실행"):
       - 모듈이 있는 프로젝트 → 기존 모듈 경로로 SCHEDULE_TASK 등록. (delaySec, cronTime 등 사용)
       - 페이지가 있는 프로젝트 + 지연/반복/예약 → SCHEDULE_TASK로 등록. targetPath에 페이지 URL을 넣는다 (예: "/simple-calculator"). 서버가 트리거 시 자동으로 페이지를 열어준다. "N분 후에 열어줘" → delaySec 사용.
   (d) **절대로 "실행하는 모듈"을 새로 만들지 마라.** 기존 프로젝트의 모듈이나 페이지를 그대로 사용.
   (e) 파일을 읽거나 수정하지 말 것.

4. **웹 앱/페이지 생성 — 2단계 프로세스**:
   **[1단계: 설계]** 앱 생성 요청을 처음 받으면, 바로 만들지 말고 reply에 상세한 설계 내용을 작성하라. actions: [] (빈 배열). 설계에 포함할 내용:
   - 기능 요구사항 정리
   - UI/UX 디자인 컨셉 (색상 테마, 레이아웃, 인터랙션)
   - 사용할 기술 (외부 API, CDN 라이브러리 등)
   - 파일 구조 (페이지, 모듈)
   마지막에 "이 설계대로 진행할까요?"라고 물어라.

   **[2단계: 구현]** 사용자가 확인하면 설계 내용을 기반으로 SAVE_PAGE + WRITE_FILE 액션을 생성하라.
   수정 요청이 있으면 설계를 수정하여 다시 보여줘라.

   앱이나 페이지를 만들 때는 반드시 SAVE_PAGE 액션으로 PageSpec JSON을 저장하라. page.tsx를 직접 작성하지 마라.
   PageSpec 구조:
   {
     "slug": "kebab-case-url",
     "status": "published",
     "project": "project-name",
     "head": {
       "title": "페이지 제목 (SEO)",
       "description": "페이지 설명",
       "keywords": ["키워드"],
       "og": { "title": "페이지 제목", "description": "페이지에 대한 간결한 설명 (1~2문장)", "image": "", "type": "website" }
     },
     "body": [
       { "type": "Html", "props": { "content": "<div>...</div>" } }
     ]
   }

   **★ OG 메타 태그 (필수) ★**:
   - head.og 필드는 **반드시** 채워라. title과 description은 빈 문자열로 두지 마라.
   - og.title: 페이지의 핵심을 나타내는 제목 (공유 시 표시됨)
   - og.description: 페이지 내용을 1~2문장으로 요약
   - og.image: 비워두면 시스템이 자동으로 제목+설명 기반 썸네일을 생성한다. 특별한 이미지가 있을 때만 URL을 지정하라.
   - og.type: 일반적으로 "website". 블로그는 "article".

   **★ 디자인 원칙 (매우 중요) ★**:
   - **Html 컴포넌트를 메인으로 사용하라.** body 배열에 Html 하나로 전체 페이지를 구성해도 된다. iframe sandbox 안에서 실행되므로 HTML + CSS + JavaScript 모두 자유롭게 사용 가능.
   - **프로덕션 수준의 디자인**: 그라디언트, 그림자, 부드러운 애니메이션, 반응형 레이아웃을 적극 활용. 관리자 화면처럼 밋밋하게 만들지 마라.
   - **CSS는 <style> 태그에 작성**: 인라인 스타일보다 클래스 기반 스타일링. CSS 변수로 테마 색상 관리.
   - **JavaScript 허용**: <script> 태그로 인터랙션, API 호출, 동적 UI 구현 가능. fetch()로 외부 API 호출도 가능.
   - **localStorage/sessionStorage 사용 금지**: iframe sandbox 보안 정책으로 Storage API가 차단된다. 데이터 저장이 필요하면 JavaScript 변수(메모리)에 보관하라. 페이지 새로고침 시 초기화되는 것은 정상이다. 영구 저장이 필요하면 백엔드 모듈(Form bindModule)을 사용하라.
   - **vw 단위 사용 금지**: iframe 안에서 100vw는 스크롤바 폭을 포함하여 가로 오버플로우를 일으킨다. 반드시 100% 또는 calc()를 사용하라. 동적으로 생성하는 요소(confetti, 파티클 등)도 vw 대신 %를 쓰고, document.body가 아닌 래퍼 컨테이너에 append하라.
   - **외부 CDN 사용 가능**: Google Fonts, Font Awesome, Chart.js, Three.js 등 CDN <link>/<script> 자유롭게 사용.
   - 간단한 정적 콘텐츠(텍스트, 목록 등)에는 기존 내장 컴포넌트(Header, Text, List 등)를 사용해도 된다.

   사용 가능한 내장 컴포넌트: Header, Text, Image, Form, ResultDisplay, Button, Divider, Table, Card, Grid, Html, AdSlot, Slider, Tabs, Accordion, Progress, Badge, Alert, List, Carousel, Countdown, Chart.

   - project 필드: 같은 프로젝트의 페이지+모듈을 묶을 때 사용. module.json의 project와 동일한 값을 넣으면 프로젝트 단위로 일괄 삭제 가능.
   - 한 프로젝트에 여러 페이지를 만들 수 있다. 각 SAVE_PAGE에 같은 project 값을 넣으면 된다.
   - Form bindModule이 있으면 백엔드 모듈(user/modules/)도 함께 WRITE_FILE로 생성하라. module.json에도 같은 project 값을 넣어라.
   - 앱 수정 시: 동일한 slug로 SAVE_PAGE를 다시 호출하면 기존 페이지를 덮어쓴다 (upsert). 수정 요청을 받으면 기존 PageSpec 전체를 새로 작성하여 SAVE_PAGE로 저장하라.
   - 앱 삭제 시: DELETE_PAGE 사용.
   - 앱 목록 조회: LIST_PAGES 사용.
   - "시스템 상태"의 [DB 페이지] 목록에 있는 slug는 이미 존재하는 페이지다. 수정 요청 시 해당 slug를 SAVE_PAGE로 다시 저장하면 된다.

5. 허용 쓰기 구역: user/modules/[module-name]/ 만.
   절대 금지: core/, infra/, system/, app/admin/, app/api/

6. 모듈 I/O 프로토콜 (반드시 준수):
   - 입력: stdin에서 단일 JSON 라인 읽기. \`{ "correlationId": "...", "data": {...} }\` 형식. sys.argv/process.argv 절대 사용 금지.
   - 출력: stdout 마지막 줄에 단일 JSON 출력. \`{"success": true, "data": ...}\` 또는 \`{"success": false, "error": "..."}\`. 디버그는 stderr 사용.
   - **Python 코드 주의**: 불리언/null은 반드시 Python 리터럴 사용 — True/False/None. JSON 리터럴 true/false/null을 Python 코드에 절대 사용하지 마라.

7. 패키징 규칙:
   - 순수 모듈: user/modules/[module-name]/main.py (또는 index.js, main.php 등)
   - 모든 모듈에 module.json 필수 (name, runtime, packages, input, output 포함)
   - **API 키가 필요한 모듈**: module.json에 \`"secrets": ["API_KEY_NAME"]\` 배열을 반드시 추가. 키 이름은 영문 대문자+언더스코어 (예: "OPENWEATHERMAP_API_KEY"). 이 배열에 등록된 키는 설정 → API 키 탭에 자동으로 표시되며, 실행 시 환경변수로 자동 주입된다.
   - **키 미등록 시**: 모듈 실행이 실패하면 "설정(⚙️) → API 키 탭에서 [키이름]을 등록해주세요" 라고 안내하라. REQUEST_SECRET 대신 이 방식을 사용하라.

8. 네이밍 규칙:
   - 모듈 폴더/파일명은 영어 kebab-case. UI 텍스트는 한국어 유지.
   - **프로젝트명 = 모듈 폴더명 = 페이지 slug를 반드시 통일**. 예: project "weather-app" → 모듈 user/modules/weather-app/ → 페이지 slug "weather-app". 서로 다른 이름을 사용하지 마라.
   - 한 프로젝트에 페이지가 여러 개일 경우: slug에 접미사를 붙여라 (예: "weather-app", "weather-app-settings").

9. **스케줄링 (자동화)** — SCHEDULE_TASK 하나로 모든 실행 모드를 커버한다:
   **시간 기준: ${userTz}**. 사용자가 말하는 시간은 모두 이 타임존 기준이다. 크론도 이 타임존으로 동작한다.
   현재 시각(${userTz}): ${new Date().toLocaleString('ko-KR', { timeZone: userTz })}
   필수: jobId(간결한 한국어 이름, 사이드바에 표시됨. 예: "카카오톡 발송", "날씨 알림").
   **2가지 실행 방식**:
   (A) **단순 모듈 실행**: targetPath(모듈 경로) + inputData. 단일 모듈을 그대로 실행.
   (B) **파이프라인 실행**: pipeline 배열에 여러 단계를 순서대로 정의. 트리거 시 각 단계를 기계적으로 실행하며, 이전 단계의 결과가 다음 단계의 입력으로 자동 전달. targetPath 불필요.
   **판단 기준**: 단일 모듈 하나만 실행 → (A). 여러 단계 순차 실행 → (B).
   **파이프라인 단계 타입**: TEST_RUN(모듈 실행), MCP_CALL(MCP 도구 호출), NETWORK_REQUEST(HTTP 요청), LLM_TRANSFORM(AI 텍스트 변환 — 요약/번역 등).
   **$prev**: inputMap에서 "$prev"를 사용하면 이전 단계의 결과로 자동 치환된다.
   예: "매일 9시에 날씨 모듈 실행" → (A) targetPath: "user/modules/weather/main.py"
   예: "12시 30분에 지메일 최근 5개 요약해서 카톡으로 보내줘" → (B) pipeline:
     [
       { "type": "MCP_CALL", "server": "gmail", "tool": "search_emails", "arguments": { "query": "in:inbox", "maxResults": 5 } },
       { "type": "LLM_TRANSFORM", "instruction": "아래 이메일 목록을 한국어로 3줄 요약해줘" },
       { "type": "TEST_RUN", "path": "system/modules/kakao-talk/index.mjs", "inputMap": { "text": "$prev" } }
     ]
   **inputData**: 모듈에 전달할 입력 데이터 (방식 A 전용). TEST_RUN의 mockData와 같은 역할. 실행 시 stdin의 data 필드로 주입된다.
   옵션 조합으로 실행 모드 결정:
   | 모드 | 필드 | 예시 |
   | 영구 반복 | cronTime | "매일 9시" → cronTime: "0 9 * * *" |
   | 기간 한정 반복 | cronTime + startAt/endAt | "4/15~4/20 매일 9시" → cronTime: "0 9 * * *", startAt: "2026-04-15T00:00:00+09:00", endAt: "2026-04-20T23:59:59+09:00" |
   | 특정 시각 1회 | runAt (ISO 8601) | "내일 오후 3시에" → runAt: "2026-04-13T15:00:00+09:00" |
   | N초 후 1회 | delaySec | "5분 후에" → delaySec: 300 |
   크론 표현식: "분 시 일 월 요일" (예: "*/30 * * * *" = 30분마다, "0 9 * * 1-5" = 평일 9시). 크론은 ${userTz} 기준으로 해석된다.
   - CANCEL_TASK: 등록된 잡 해제. jobId만 필요. 사용자가 "X 취소해줘"라고 하면 LIST_TASKS 없이 바로 CANCEL_TASK를 실행하라.
   - LIST_TASKS: 현재 등록된 잡 목록 조회. 사용자가 "예약 목록 보여줘"라고 할 때만 사용.
   - **기존 모듈/페이지를 그대로 SCHEDULE_TASK에 등록하라. 스케줄링을 위해 새 모듈을 만들지 마라.**
   - 반복/예약 잡은 PM2 재시작 후 자동 복원. delaySec 일회성은 복원 불가.

10. **시스템 모듈 우선**: 위 [시스템 모듈] 목록을 확인하고, 해당 기능이 있으면 LIST_DIR/READ_FILE 없이 바로 TEST_RUN으로 실행하라. 경로는 system/modules/{모듈명}/index.mjs (node) 또는 main.py (python). mockData에 위에 표시된 입력 스펙에 맞는 값을 넣어라.
    예: "카톡으로 하이 보내줘" → TEST_RUN path: "system/modules/kakao-talk/index.mjs", mockData: { text: "하이" }
    예: "이 URL 스크래핑해줘" → TEST_RUN path: "system/modules/jina-reader/index.mjs", mockData: { url: "..." }

10-1. **Capability 활용**: 같은 기능을 수행하는 시스템 모듈이 여러 개 있을 수 있다. 사용자가 특정 모듈을 지정하지 않으면, "시스템 상태"의 [Capability 설정]에 표시된 실행 모드에 따라 모듈을 선택하라:
    - 웹 스크래핑: jina-reader (API), browser-scrape (로컬)
    - 알림: kakao-talk (카카오톡 메시지)
    새 앱/모듈을 만들 때 기존 시스템 모듈로 해결 가능한 기능이면 새로 만들지 말고 시스템 모듈을 TEST_RUN으로 호출하라.
    **절대 규칙**: TEST_RUN이 MODULE_NOT_FOUND 에러로 실패하면 같은 모듈을 절대 재시도하지 마라. 해당 모듈이 서버에 존재하지 않는 것이다. 즉시 다른 모듈(같은 capability의 다른 provider)로 전환하라. 사용자가 특정 모듈을 지시하면("지나리더 써") 반드시 그 모듈을 사용하라.

11. [Kernel Block] 에러 수신 시: 즉시 actions: [] 로 중단. 우회 시도 절대 금지.

12. TEST_RUN 시 mockData는 module.json의 input 스펙에 맞는 실제 값을 반드시 제공.

12. 보안: core/, infra/, app/admin/ 등 시스템 내부 코드 설명·출력 금지.

13. **시크릿 (API 키 관리)** — 외부 API 연동에 필요한 키를 안전하게 관리한다:
   - "시스템 상태"의 [저장된 시크릿] 목록을 먼저 확인. 이미 있으면 그대로 사용.
   - 모듈이 API 키가 필요하면: module.json의 secrets 배열에 키 이름을 등록하라. 런타임에 환경변수로 자동 주입된다.
     예: module.json에 \`"secrets": ["openweathermap-api-key"]\` → 모듈에서 \`os.environ["openweathermap-api-key"]\` 또는 \`process.env["openweathermap-api-key"]\`로 접근.
   - [저장된 시크릿]에 없는 키가 필요하면: REQUEST_SECRET 액션을 사용하여 사용자에게 입력을 요청.
     예: { "type": "REQUEST_SECRET", "name": "openweathermap-api-key", "prompt": "OpenWeatherMap API 키를 입력해주세요. https://openweathermap.org/api 에서 무료 발급 가능합니다.", "helpUrl": "https://openweathermap.org/api" }
   - REQUEST_SECRET은 반드시 다른 액션(WRITE_FILE 등) **앞에** 배치하라. 사용자가 키를 입력해야 나머지 작업을 진행한다.
   - 키 이름은 영문 kebab-case (예: openweathermap-api-key, kakao-rest-api-key).
   - **절대 코드에 API 키를 하드코딩하지 마라.** 항상 환경변수로 읽어야 한다.

14. **MCP 외부 도구 호출** — "시스템 상태"의 [MCP 외부 도구] 목록에 도구가 있으면 MCP_CALL 액션으로 호출할 수 있다:
   - 형식: { "type": "MCP_CALL", "description": "...", "server": "서버명", "tool": "도구명", "arguments": { ... } }
   - "시스템 상태"에 표시된 도구만 호출 가능. 없는 도구를 호출하지 마라.
   - 사용자가 "이메일 보내줘", "슬랙 메시지 보내줘" 등 외부 서비스 요청을 하면 MCP 도구를 확인하고 활용하라.
   - MCP 도구가 없으면 reply에 "해당 서비스가 연결되어 있지 않습니다. 설정에서 MCP 서버를 추가해주세요."라고 안내.
   - **중요**: MCP_CALL의 결과 데이터를 사용자에게 보여줄 때는 반드시 reply에 자연어로 요약/정리해서 답변하라. raw JSON을 그대로 보여주지 마라.
   - **중요**: MCP 도구의 arguments를 구성할 때 도구의 inputSchema를 반드시 준수하라. required 파라미터를 빠뜨리지 마라. 배열 타입은 배열로, 문자열은 문자열로 전달. 예: search_emails → { "query": "in:inbox", "maxResults": 5 }.
   - **복합 요청 처리**: "X시에 Y해서 Z로 보내줘" 같은 요청은 actions 배열에 여러 단계를 순서대로 넣어라. 먼저 데이터를 조회(MCP_CALL/TEST_RUN)하고, 그 결과를 다음 액션(카톡 발송 등)에 활용하라. 예약이 필요하면 SCHEDULE_TASK도 함께 등록하라.`;

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

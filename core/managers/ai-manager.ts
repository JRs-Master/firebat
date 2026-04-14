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
          const file = await this.core.readFile(`system/modules/${d.name}/config.json`);
          if (file.success && file.data) {
            try {
              const m = JSON.parse(file.data);
              const rt = m.runtime === 'node' ? 'index.mjs' : m.runtime === 'python' ? 'main.py' : 'index.mjs';
              const path = `system/modules/${d.name}/${rt}`;
              const inputDesc = m.input ? Object.entries(m.input).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
              const outputDesc = m.output ? Object.entries(m.output).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
              const capInfo = m.capability ? ` [${m.capability}, ${m.providerType || 'unknown'}]` : '';
              let line = `  - ${m.name} (${path})${capInfo}: ${m.description}`;
              if (inputDesc) line += `\n    입력: {${inputDesc}}`;
              if (outputDesc) line += `\n    출력: {${outputDesc}}`;
              modInfos.push(line);
            } catch {
              modInfos.push(`  - ${d.name}`);
            }
          }
        }
        lines.push(`[시스템 모듈] TEST_RUN으로 호출. path에 아래 경로 사용.\n${modInfos.join('\n')}`);
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
      // 필드 누락 방어
      for (const a of plan.actions) {
        if (!a.description) a.description = a.type;
        if (a.type === 'SCHEDULE_TASK' && !(a as any).title) {
          (a as any).title = a.description || 'SCHEDULE_TASK';
        }
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
            const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const res = await this.core.scheduleCronJob(jobId, action.targetPath ?? '', {
              cronTime: action.cronTime, runAt: action.runAt, delaySec: action.delaySec,
              startAt: action.startAt, endAt: action.endAt,
              inputData: (action as any).inputData,
              pipeline: action.pipeline,
              title: (action as any).title,
              description: (action as any).description,
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

      // RUN_TASK 파이프라인 결과가 있으면 reply에 반영 (LLM_TRANSFORM 요약 결과)
      let finalReply = plan.reply;
      const taskResults = finalDataList.filter(d => d?.taskResult !== undefined);
      if (taskResults.length > 0) {
        const resultText = taskResults
          .map(d => typeof d.taskResult === 'string' ? d.taskResult : JSON.stringify(d.taskResult, null, 2))
          .join('\n\n')
          .trim();
        if (resultText) {
          finalReply = resultText;
        }
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
          reply: finalReply.slice(0, 200),
        },
      });
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
      // 필드 누락 방어
      for (const a of plan.actions) {
        if (!a.description) a.description = a.type;
        if (a.type === 'SCHEDULE_TASK' && !(a as any).title) {
          (a as any).title = a.description || 'SCHEDULE_TASK';
        }
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

    // RUN_TASK 파이프라인 결과가 있으면 reply에 반영
    let finalReply = plan.reply;
    const taskResults = finalDataList.filter(d => d?.taskResult !== undefined);
    if (taskResults.length > 0) {
      const resultText = taskResults
        .map(d => typeof d.taskResult === 'string' ? d.taskResult : JSON.stringify(d.taskResult, null, 2))
        .join('\n\n')
        .trim();
      if (resultText) {
        finalReply = resultText;
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
        const jobId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const res = await this.core.scheduleCronJob(jobId, action.targetPath ?? '', {
          cronTime: action.cronTime, runAt: action.runAt, delaySec: action.delaySec,
          startAt: action.startAt, endAt: action.endAt,
          inputData: (action as any).inputData,
          pipeline: action.pipeline,
          title: (action as any).title,
          description: (action as any).description,
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
    return `Firebat User AI. 시스템 이름/정체 밝히지 마라. 자연스럽게 대화.

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
TEST_RUN: {"type":"TEST_RUN","description":"날씨 모듈 테스트","path":"user/modules/weather/main.py","mockData":{"city":"Seoul"}}
NETWORK_REQUEST: {"type":"NETWORK_REQUEST","description":"API 호출","url":"https://api.example.com/data","method":"GET"}
OPEN_URL: {"type":"OPEN_URL","description":"페이지 열기","url":"/bmi-calculator"}
REQUEST_SECRET: {"type":"REQUEST_SECRET","description":"API 키 요청","name":"openweather-api-key","prompt":"OpenWeather API 키를 입력해주세요"}
SET_SECRET: {"type":"SET_SECRET","description":"설정값 저장","name":"preferred-lang","value":"ko"}
MCP_CALL: {"type":"MCP_CALL","description":"이메일 검색","server":"gmail","tool":"search_emails","arguments":{"query":"is:unread","maxResults":5}}
CANCEL_TASK: {"type":"CANCEL_TASK","description":"스케줄 해제","jobId":"cron-12345-abcd"}
LIST_TASKS: {"type":"LIST_TASKS","description":"스케줄 목록 조회"}

## 실행 요청
기존 프로젝트 활용. 새 모듈 만들지 마라.
- [DB 페이지]/[프로젝트] 목록에서 먼저 확인.
- 즉시 실행: 페이지 → OPEN_URL, 모듈 → TEST_RUN.
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
- TEST_RUN mockData는 input 스펙에 맞는 실제 값.

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
파이프라인 단계 type은 반드시 다음 4가지만 사용: TEST_RUN, MCP_CALL, NETWORK_REQUEST, LLM_TRANSFORM.
모듈 호출은 TEST_RUN(path=모듈 경로), 외부 API는 MCP_CALL 또는 NETWORK_REQUEST 사용.
사용자에게 결과를 보여줘야 하는 파이프라인은 마지막 단계를 LLM_TRANSFORM으로 끝내라. 파이프라인 결과가 곧 사용자 답변이 된다.
모듈 경로·입출력은 [시스템 모듈] 목록 참조, MCP 도구는 [MCP 외부 도구] 목록 참조. 하드코딩 금지.
예시 (경로·서버·도구는 실제 목록에서 선택):
{"type":"RUN_TASK","description":"복합 작업","pipeline":[
  {"type":"TEST_RUN","path":"<시스템 모듈 경로>","inputData":{"<입력키>":"<값>"}},
  {"type":"LLM_TRANSFORM","instruction":"결과를 사용자에게 보여줄 자연어로 요약."}
]}

### SCHEDULE_TASK 샘플 (예약/반복)
(A) 단순 모듈 실행:
{"type":"SCHEDULE_TASK","description":"매일 실행","title":"작업명","targetPath":"<모듈 경로>","inputData":{},"cronTime":"0 9 * * *"}

(B) 파이프라인 예약 ($prev로 이전 결과 전달):
{"type":"SCHEDULE_TASK","description":"복합 예약","title":"작업명","runAt":"2026-04-14T14:00:00","pipeline":[
  {"type":"MCP_CALL","server":"<서버명>","tool":"<도구명>","arguments":{}},
  {"type":"LLM_TRANSFORM","instruction":"결과 요약."},
  {"type":"TEST_RUN","path":"<모듈 경로>","inputMap":{"text":"$prev"}}
]}

## 시스템 모듈
[시스템 모듈]에 경로·입출력·capability·providerType이 명시되어 있다. TEST_RUN의 path에 해당 경로를, inputData에 입력 형식을 그대로 사용.
같은 capability의 모듈이 여러 개면 반드시 [Capability 설정]의 모드에 따라 선택:
- api-first(기본): 반드시 providerType=api 모듈을 먼저 사용. JS 렌더링이 필요하다고 판단해도 local 선택 금지. 실패하면 TaskManager가 자동 폴백한다.
- local-first: providerType=local 우선, 실패 시 api 폴백
AI는 절대 자의적으로 provider를 선택하지 마라. 모드에 따른 첫 번째 선택만 하라.

## MCP 외부 도구
[MCP 외부 도구] 목록의 도구만 MCP_CALL로 호출. inputSchema 준수. raw JSON 표시 금지.
도구 없으면 "설정에서 MCP 서버를 추가해주세요" 안내.
복합 요청: actions 배열에 순서대로 (조회 → 가공 → 발송 → 예약).

## 응답 범위
- 질문한 것만 답하라. 안 물어본 정보를 덧붙이지 마라.
- 추가 정보가 유용할 것 같으면 suggestions로 선택지를 제공하라 (예: "주요 뉴스도 볼까요?", "스포츠 이슈도 정리할까요?").

## 금지
- [Kernel Block] 에러 → actions: [] 중단. 우회 금지.
- 시스템 내부 코드 설명/출력 금지.`;

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

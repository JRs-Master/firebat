/**
 * cli-gemini format handler
 *
 * Google Gemini CLI 를 자식 프로세스로 spawn 하여 실행. Google AI Pro 구독 (또는 무료 티어) 사용.
 * 인증은 `gemini auth login` 으로 OAuth 코드 플로우 (API 키 불필요).
 *
 * 실행: gemini -p "prompt" --output-format stream-json --approval-mode yolo
 * MCP: ~/.gemini/settings.json 대신 임시 GEMINI_HOME 에 settings.json 생성 + env 주입.
 *   (--mcp-config CLI 플래그는 존재하지 않음 — 공식 문서 확인)
 * Thinking: CLI 플래그 미지원 — 모델 내부 자동 처리에 맡김
 */
import { spawn, ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';

interface CliRunResult {
  text: string;
  sessionId?: string;
  usedTools: string[];
  renderedBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'html'; htmlContent: string; htmlHeight?: string }
    | { type: 'component'; name: string; props: Record<string, unknown> }
  >;
  pendingActions: Array<{ planId: string; name: string; summary: string; args?: Record<string, unknown>; status?: 'past-runat'; originalRunAt?: string }>;
  suggestions: unknown[];
  error?: string;
}

/** render_* 도구 이름 → 컴포넌트 타입 매핑 (prefix 제거 후) */
const RENDER_COMPONENT_MAP: Record<string, string> = {
  render_stock_chart: 'StockChart',
  render_table: 'Table',
  render_alert: 'Alert',
  render_callout: 'Callout',
  render_badge: 'Badge',
  render_progress: 'Progress',
  render_header: 'Header',
  render_text: 'Text',
  render_list: 'List',
  render_divider: 'Divider',
  render_countdown: 'Countdown',
  render_chart: 'Chart',
  render_image: 'Image',
  render_card: 'Card',
  render_grid: 'Grid',
  render_metric: 'Metric',
  render_timeline: 'Timeline',
  render_compare: 'Compare',
  render_key_value: 'KeyValue',
  render_status_badge: 'StatusBadge',
};

/** Gemini CLI MCP 도구 prefix 제거 — mcp_firebat_schedule_task → schedule_task */
function stripGeminiMcpPrefix(name: string): string {
  return name.replace(/^mcp_firebat_/, '').replace(/^mcp__[^_]+__/, '');
}

interface RunOptions {
  systemPrompt?: string;
  history?: ChatMessage[];
  cliModel?: string;
  geminiHome?: string;
  geminiWorkspace?: string;
  resumeSessionId?: string;
  onChunk?: LlmCallOpts['onChunk'];
}

export class CliGeminiFormat implements FormatHandler {
  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : '\n\n응답은 JSON 객체로만 반환 (마크다운·설명 금지).';
    const res = await this.runGemini(prompt + jsonInstruction, { systemPrompt, history });
    if (res.error) return { success: false, error: res.error };
    try { return { success: true, data: JSON.parse(res.text) as LlmJsonResponse }; }
    catch { return { success: true, data: { thoughts: '', reply: res.text, actions: [], suggestions: [] } }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : opts?.jsonMode ? '\n\n응답은 JSON 객체로만 반환.' : '';
    const res = await this.runGemini(prompt + jsonInstruction, { systemPrompt, onChunk: opts?.onChunk });
    if (res.error) return { success: false, error: res.error };
    return { success: true, data: res.text };
  }

  async askWithTools(prompt: string, systemPrompt: string, _tools: ToolDefinition[], history: ChatMessage[], _toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const mcpCfg = ctx.resolveMcpConfig?.();
    const baseUrl = mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, '');
    // workspace 하나에 GEMINI.md(시스템 프롬프트) + .gemini/settings.json(MCP 설정) 통합.
    // GEMINI_HOME env var 는 Gemini CLI 가 지원 안 함 → 프로젝트 로컬 설정으로 주입.
    const geminiWorkspace = this.ensureGeminiWorkspace(systemPrompt, mcpCfg?.token, baseUrl);
    const geminiHome = undefined; // 더 이상 사용 안 함 (호환성 유지 위해 필드 유지)
    const cliModel = ctx.config.cliModel;
    const resumeSessionId = opts?.cliResumeSessionId;
    let res = await this.runGemini(prompt, {
      systemPrompt: undefined, // GEMINI.md 로 이동했으므로 prompt 에 넣지 않음
      history,
      cliModel,
      geminiHome,
      geminiWorkspace,
      resumeSessionId,
      onChunk: opts?.onChunk,
    });
    // resume 실패(세션 삭제·workspace 변경 등) → resume 없이 재시도
    if (res.error && resumeSessionId && /Invalid session identifier|Error resuming session/i.test(res.error)) {
      res = await this.runGemini(prompt, {
        systemPrompt: undefined,
        history,
        cliModel,
        geminiHome,
        geminiWorkspace,
        resumeSessionId: undefined,
        onChunk: opts?.onChunk,
      });
    }
    if (res.error) return { success: false, error: res.error };
    // 첫 턴 session_id 캡처
    if (res.sessionId && !resumeSessionId && opts?.onCliSessionId) {
      opts.onCliSessionId(res.sessionId);
    }
    return {
      success: true,
      data: {
        text: res.text,
        toolCalls: [],
        responseId: res.sessionId,
        internallyUsedTools: res.usedTools,
        renderedBlocks: res.renderedBlocks,
        pendingActions: res.pendingActions,
        suggestions: res.suggestions,
      },
    };
  }

  /**
   * Firebat 전용 Gemini workspace 디렉토리 생성 + GEMINI.md + .gemini/settings.json 기록.
   *
   * Gemini CLI 동작:
   *   - cwd/GEMINI.md → 프로젝트 컨텍스트로 자동 로드 (system prompt 대체)
   *   - cwd/.gemini/settings.json → 프로젝트 설정 (mcpServers 등, user settings 위에 머지)
   *
   * GEMINI_HOME env var 는 Gemini CLI 가 지원하지 않음 → ~/.gemini/settings.json 수정 없이
   * 프로젝트 로컬 설정으로 MCP 주입.
   */
  private ensureGeminiWorkspace(systemPrompt: string | undefined, internalMcpToken?: string | null, baseUrl?: string): string {
    const workspace = path.join(os.tmpdir(), 'firebat-gemini-workspace');
    const geminiDir = path.join(workspace, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    if (systemPrompt) {
      // Gemini CLI 는 MCP 도구를 `mcp_firebat_*` 접두사로 등록. 시스템 프롬프트는 맨 이름(schedule_task 등)으로
      // 작성되어 있어 Gemini 가 매칭 실패 → 도구 호출 0개 현상 발생. 접두사 규칙 주입.
      const geminiCliNote = `\n\n## Gemini CLI 전용 도구 이름 규칙 (매우 중요)\n\n이 런타임에서는 Firebat 내부 도구가 MCP 서버 \`firebat\` 경유로 등록되어, **\`mcp_firebat_\` 접두사**가 붙은 이름으로만 호출 가능합니다. 위 문서에 나온 도구 이름을 실제로 호출할 때는 반드시 접두사를 붙이세요:\n\n- \`schedule_task\` → \`mcp_firebat_schedule_task\`\n- \`run_task\` → \`mcp_firebat_run_task\`\n- \`execute\` → \`mcp_firebat_execute\`\n- \`search_history\` → \`mcp_firebat_search_history\`\n- \`render_header\` → \`mcp_firebat_render_header\`\n- \`render_text\` → \`mcp_firebat_render_text\`\n- \`render_grid\` / \`render_card\` / \`render_table\` / \`render_chart\` / \`render_stock_chart\` / \`render_alert\` / \`render_badge\` / \`render_progress\` / \`render_list\` / \`render_divider\` / \`render_countdown\` / \`render_image\` / \`render_metric\` / \`render_timeline\` / \`render_compare\` / \`render_key_value\` / \`render_status_badge\` / \`render_html\` 등 **모든 render_ 도구** → \`mcp_firebat_render_*\` 형태로 호출\n- \`sysmod_kiwoom\` → \`mcp_firebat_sysmod_kiwoom\`, \`sysmod_upbit\` → \`mcp_firebat_sysmod_upbit\` 등 **모든 sysmod_ 도구** 동일 규칙\n- \`save_page\` / \`get_page\` / \`list_pages\` / \`delete_page\` / \`read_file\` / \`write_file\` / \`delete_file\` / \`list_dir\` / \`list_projects\` / \`delete_project\` / \`suggest\` / \`request_secret\` / \`set_secret\` 등 모든 핵심 도구 동일\n\n외부 MCP(gmail 등)는 자체 네임스페이스 접두사 (\`gmail_send_email\` 등) 를 따르므로 위 규칙 적용 안 함.\n\n**절대 원칙**: 위 문서에서 언급된 도구 이름이 있으면 접두사 \`mcp_firebat_\` 를 붙여 호출하세요. 접두사 없이 호출하면 'Tool not found' 로 실패합니다.\n`;
      fs.writeFileSync(path.join(workspace, 'GEMINI.md'), systemPrompt + geminiCliNote);
    }
    // 프로젝트 로컬 MCP 설정
    const mcpServers: Record<string, unknown> = {};
    if (internalMcpToken) {
      const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
      mcpServers.firebat = { httpUrl: url, headers: { Authorization: `Bearer ${internalMcpToken}` }, timeout: 30000 };
    } else {
      const projectDir = process.cwd();
      const stdioPath = path.join(projectDir, 'mcp', 'stdio-user-ai.ts');
      mcpServers.firebat = { command: 'npx', args: ['tsx', stdioPath], cwd: projectDir, timeout: 30000 };
    }
    const settings = {
      mcpServers,
      autoMemory: false,
      telemetry: { enabled: false },
      // 내장 툴 차단 — mcp_firebat_* 만 사용하도록 유도. shell/file 등 위험 툴 전면 금지.
      //  (Gemini CLI 의 자체 도구 세트: ShellTool, ReadFileTool, WriteFileTool, EditTool, WebFetchTool, WebSearchTool,
      //   MemoryTool, GlobTool, GrepTool, EnterPlanMode, ExitPlanMode 등.
      //   Firebat 은 MCP 로 필요한 건 다 노출하므로 내장 툴은 0으로 설정)
      coreTools: [],
      excludeTools: [
        'ShellTool', 'ReadFileTool', 'WriteFileTool', 'EditTool',
        'WebFetchTool', 'WebSearchTool', 'MemoryTool', 'GlobTool', 'GrepTool',
        'EnterPlanMode', 'ExitPlanMode', 'PlanMode',
      ],
    };
    fs.writeFileSync(path.join(geminiDir, 'settings.json'), JSON.stringify(settings, null, 2));
    return workspace;
  }

  /** Firebat 전용 GEMINI_HOME 디렉토리 + settings.json 쓰기 */
  private ensureGeminiHome(internalMcpToken?: string | null, baseUrl?: string): string {
    const geminiHome = path.join(os.tmpdir(), 'firebat-gemini-home');
    fs.mkdirSync(geminiHome, { recursive: true });
    // 기존 OAuth creds 복사 (로그인 세션 유지)
    const realHome = path.join(os.homedir(), '.gemini');
    for (const f of ['oauth_creds.json', 'google_account_id', 'installation_id']) {
      const src = path.join(realHome, f);
      const dst = path.join(geminiHome, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch { /* 권한 이슈 무시 */ }
      }
    }

    const mcpServers: Record<string, unknown> = {};
    if (internalMcpToken) {
      const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
      mcpServers.firebat = { httpUrl: url, headers: { Authorization: `Bearer ${internalMcpToken}` }, timeout: 30000 };
    } else {
      const projectDir = process.cwd();
      const stdioPath = path.join(projectDir, 'mcp', 'stdio-user-ai.ts');
      mcpServers.firebat = { command: 'npx', args: ['tsx', stdioPath], cwd: projectDir, timeout: 30000 };
    }

    const settings = {
      mcpServers,
      autoMemory: false,        // 세션 mining 비활성 (Firebat DB에 별도 저장)
      telemetry: { enabled: false },
    };
    fs.writeFileSync(path.join(geminiHome, 'settings.json'), JSON.stringify(settings, null, 2));
    return geminiHome;
  }

  private buildPromptWithHistory(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) return prompt;
    const recent = history.slice(-10);
    const hist = recent.map(h => {
      const role = h.role === 'assistant' ? 'AI' : '사용자';
      const content = typeof h.content === 'string' ? h.content : JSON.stringify(h.content);
      return `${role}: ${content}`;
    }).join('\n\n');
    return `[이전 대화]\n${hist}\n\n[현재 요청]\n${prompt}`;
  }

  private runGemini(prompt: string, options: RunOptions): Promise<CliRunResult> {
    return new Promise((resolve) => {
      // systemPrompt 는 GEMINI.md 경유 주입되므로 여기서는 user query 만.
      //   이 방식 이점: Gemini 기본 시스템 프롬프트와 공존, echo 없음, 깔끔한 레이어링.
      // resume 시 history 주입 생략 — Gemini 세션이 이미 컨텍스트 보유
      const promptBody = options.resumeSessionId ? prompt : this.buildPromptWithHistory(prompt, options.history);
      const finalPrompt = options.systemPrompt
        ? `<SYSTEM_INSTRUCTIONS>\n${options.systemPrompt}\n</SYSTEM_INSTRUCTIONS>\n\n<USER_QUERY>\n${promptBody}\n</USER_QUERY>\n\n위 SYSTEM_INSTRUCTIONS 는 행동 규범. 반복·요약 금지. USER_QUERY 에만 답하세요.`
        : promptBody;

      // gemini -p "..." --output-format stream-json --approval-mode yolo
      const args: string[] = [
        '-p', finalPrompt,
        '--output-format', 'stream-json',
        '--approval-mode', 'yolo',
      ];
      if (options.cliModel) args.push('-m', options.cliModel);
      if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);

      const childEnv: NodeJS.ProcessEnv = options.geminiHome
        ? { ...process.env, GEMINI_HOME: options.geminiHome }
        : process.env;

      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn('gemini', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
          // cwd = workspace (GEMINI.md 가 있는 디렉토리) → Gemini 가 자동 로드
          ...(options.geminiWorkspace ? { cwd: options.geminiWorkspace } : {}),
        });
      } catch (e) {
        resolve({ text: '', usedTools: [], renderedBlocks: [], pendingActions: [], suggestions: [], error: `Gemini CLI 실행 실패 (gemini 명령어 미설치?): ${(e as Error).message}` });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      const textParts: string[] = [];
      const usedTools: string[] = [];
      const pendingToolCalls = new Map<string, { name: string; parameters: unknown }>();
      const renderedBlocks: CliRunResult['renderedBlocks'] = [];
      const pendingActions: CliRunResult['pendingActions'] = [];
      const suggestions: unknown[] = [];
      let sessionId: string | undefined;
      let errored = false;
      let errorMsg: string | undefined;

      const toErrStr = (v: unknown): string => {
        if (typeof v === 'string') return v;
        if (v && typeof v === 'object') {
          const m = (v as Record<string, unknown>).message;
          if (typeof m === 'string') return m;
          try { return JSON.stringify(v); } catch { return String(v); }
        }
        return String(v ?? '');
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; }
        catch { return; /* 파싱 실패 스킵 */ }

        const t = ev.type;
        // session_id (init 이벤트)
        if (t === 'init' && typeof ev.session_id === 'string') {
          if (!sessionId) sessionId = ev.session_id;
          return;
        }
        // 에러 이벤트
        if (t === 'error' || ev.error) {
          errored = true;
          errorMsg = toErrStr(ev.message) || toErrStr(ev.error) || 'Gemini 오류';
          return;
        }
        // message — role=assistant 만 채택.
        //   Gemini 포맷 2종:
        //     1) event-level thought 플래그: {role:'assistant', content, thought:true}
        //     2) 인라인 마커: content 안에 '[Thought: true]...' 문자열로 사고 과정 삽입
        //   둘 다 thinking 스트림으로 분리.
        if (t === 'message') {
          const role = ev.role;
          if (role === 'assistant' && typeof ev.content === 'string') {
            if (ev.thought === true) {
              options.onChunk?.({ type: 'thinking', content: ev.content });
              return;
            }
            // 인라인 [Thought: true] 마커 파싱
            const raw = ev.content;
            if (raw.includes('[Thought:')) {
              // [Thought: true]<...>(다음 [Thought: ...] 또는 끝까지) 블록을 모두 thinking 으로 분리
              const THOUGHT_RE = /\[Thought:\s*(?:true|false)\]/g;
              const parts: Array<{ kind: 'text' | 'thinking'; text: string }> = [];
              let lastIdx = 0;
              let m: RegExpExecArray | null;
              // 첫 마커 이전: 일반 텍스트
              while ((m = THOUGHT_RE.exec(raw)) !== null) {
                if (m.index > lastIdx) {
                  parts.push({ kind: lastIdx === 0 ? 'text' : 'thinking', text: raw.slice(lastIdx, m.index) });
                }
                lastIdx = m.index + m[0].length;
              }
              // 마지막 마커 이후 나머지 — thinking (마커가 한 번이라도 있었다면)
              if (lastIdx < raw.length) {
                parts.push({ kind: 'thinking', text: raw.slice(lastIdx) });
              }
              for (const p of parts) {
                if (!p.text || !p.text.trim()) continue; // 공백만 있는 조각은 스킵 (isThinking 플립 방지)
                if (p.kind === 'text') {
                  textParts.push(p.text);
                  options.onChunk?.({ type: 'text', content: p.text });
                } else {
                  options.onChunk?.({ type: 'thinking', content: p.text });
                }
              }
            } else {
              // [Thought:] 마커 없이 누출된 reasoning 블록 감지 — chunk 전체 기준 한 번만 판정.
              // split·개행 추가 하지 않음 (markdown 표가 깨지거나 Thought 마커가 경계에 걸리는 문제 방지).
              // 최종 cleanup 은 sanitizeFinal 에서 처리.
              const REASONING_GERUND = /\b(Conducting|Analyzing|Refining|Reviewing|Finalizing|Preparing|Evaluating|Processing|Synthesizing|Compiling|Investigating|Considering|Formulating|Examining)\b/;
              const FIRST_PERSON = /\bI['']?(m|ve| am| will| have| need)\b|\bLet me\b|\bMy (next|step|plan|focus|approach)\b/;
              const hasKorean = /[가-힣]/.test(raw);
              const looksLikeReasoning = !hasKorean && REASONING_GERUND.test(raw) && FIRST_PERSON.test(raw);
              if (looksLikeReasoning) {
                options.onChunk?.({ type: 'thinking', content: raw });
              } else {
                textParts.push(raw);
                options.onChunk?.({ type: 'text', content: raw });
              }
            }
          }
          return;
        }
        // tool_use — 도구 호출 시작
        if (t === 'tool_use') {
          const rawName = typeof ev.tool_name === 'string' ? ev.tool_name
            : typeof ev.name === 'string' ? ev.name : '';
          const toolId = typeof ev.tool_id === 'string' ? ev.tool_id : '';
          const params = ev.parameters ?? ev.input;
          if (rawName) {
            // Gemini CLI 내장 메타 도구 차단 — enter_plan_mode 등 진입 시 출력 스트림이
            // 멈춰 UI 가 '로봇 사라짐' 상태로 보임. 호출 자체는 이미 발생했으므로
            // 사용자에게만 알리고 턴 종료는 result 이벤트를 그대로 기다림.
            const META_TOOLS = ['enter_plan_mode', 'exit_plan_mode', 'plan_mode', 'plan'];
            if (META_TOOLS.includes(rawName.toLowerCase())) {
              options.onChunk?.({ type: 'thinking', content: `[메타 도구 ${rawName} 호출 감지 — 3단계 suggest 플로우를 사용해야 합니다]` });
            }
            const bare = stripGeminiMcpPrefix(rawName);
            usedTools.push(bare);
            options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${bare}]` });
            if (toolId) pendingToolCalls.set(toolId, { name: bare, parameters: params });
          }
          return;
        }
        // tool_result — tool_id 로 매칭, output JSON 파싱 → render/pending/suggestions 추출
        if (t === 'tool_result') {
          const toolId = typeof ev.tool_id === 'string' ? ev.tool_id : '';
          const pending = toolId ? pendingToolCalls.get(toolId) : undefined;
          const output = ev.output;
          const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
          if (pending && outputStr) {
            try {
              const payload = JSON.parse(outputStr) as Record<string, unknown>;
              if (payload.success) {
                // 1) render_* 결과 → blocks
                if (pending.name === 'render_html' && typeof payload.htmlContent === 'string') {
                  renderedBlocks.push({ type: 'html', htmlContent: payload.htmlContent, htmlHeight: payload.htmlHeight as string | undefined });
                } else if (typeof payload.component === 'string' && payload.component.trim()) {
                  // 빈 문자열이면 '지원되지 않는 컴포넌트 ()' 로 렌더되므로 제외 + RENDER_COMPONENT_MAP 폴백으로 넘김
                  renderedBlocks.push({ type: 'component', name: payload.component, props: (payload.props as Record<string, unknown>) ?? {} });
                } else if (RENDER_COMPONENT_MAP[pending.name]) {
                  renderedBlocks.push({ type: 'component', name: RENDER_COMPONENT_MAP[pending.name], props: (pending.parameters as Record<string, unknown>) ?? {} });
                }
                // 2) 승인 대기 도구 → pendingActions
                if (payload.pending === true && typeof payload.planId === 'string') {
                  pendingActions.push({
                    planId: payload.planId,
                    name: pending.name,
                    summary: typeof payload.summary === 'string' ? payload.summary : pending.name,
                    args: pending.parameters as Record<string, unknown> | undefined,
                    ...(payload.status === 'past-runat' ? { status: 'past-runat' as const } : {}),
                    ...(typeof payload.originalRunAt === 'string' ? { originalRunAt: payload.originalRunAt } : {}),
                  });
                }
                // 3) suggest 도구 → suggestions
                if (pending.name === 'suggest' && Array.isArray(payload.suggestions)) {
                  for (const s of payload.suggestions) suggestions.push(s);
                }
              }
            } catch { /* 파싱 실패 무시 */ }
            pendingToolCalls.delete(toolId);
          }
          return;
        }
        // result — 실행 종료, 통계만 (별도 처리 불필요)
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) processLine(line);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      child.on('error', (e) => {
        resolve({ text: textParts.join(''), usedTools, renderedBlocks, pendingActions, suggestions, sessionId, error: `Gemini CLI 프로세스 에러: ${e.message}` });
      });
      // 텍스트 후처리 — AI 가 본문에 섞어 넣은 도구 이름·[Thought:] 마커·영문 reasoning 정리.
      // (프롬프트로 금지해도 Gemini flash 가 종종 뱉으므로 방어)
      //
      // 영문 reasoning 시그니처: 문단이 gerund 키워드로 시작하고 1인칭 동사 포함.
      // 한국어 첫 글자가 나올 때까지의 영문 블록을 전체 제거.
      // 예) "Comparing Major Tech Stocks I'm now initiating... compile the comparison table. 하이닉스, ..."
      //   →  "하이닉스, ..."
      const REASONING_PREFIX = '(?:Comparing|Analyzing|Refining|Reviewing|Finalizing|Preparing|Evaluating|Processing|Synthesizing|Compiling|Investigating|Considering|Formulating|Examining|Displaying|Conducting|Gathering|Summarizing)';
      const leakedReasoningRe = new RegExp(
        `(?:^|\\n|\\s)(?:\\*\\*)?\\s*${REASONING_PREFIX}\\b[^가-힣]*?(?=[가-힣]|\\n\\n|$)`,
        'g',
      );
      const sanitizeFinal = (t: string): string => {
        return t
          // [Thought: true|false] 마커 (공백·대소문자 변종 허용)
          .replace(/\[\s*Thought\s*:\s*(?:true|false)\s*\]/gi, '')
          // 영문 reasoning 누출 제거 — 한국어 첫 글자 직전까지 영문 블록 통째 날림
          .replace(leakedReasoningRe, ' ')
          // `mcp_firebat_render_*` / `render_table` / `render_metric` 등 도구 이름 백틱 표기 + 뒤 괄호 설명 제거
          .replace(/`(?:mcp_firebat_)?render_[a-z_]+`\s*(?:\([^)]*\))?[^\n]*\n?/g, '')
          // 줄 시작이 도구 이름만 있는 경우 (백틱 없이)
          .replace(/^\s*mcp_firebat_render_[a-z_]+\b[^\n]*\n/gm, '')
          // 빈 줄 3연속 이상 축약
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };
      child.on('close', (code) => {
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        const finalText = sanitizeFinal(textParts.join(''));
        if (errored) {
          resolve({ text: finalText, usedTools, renderedBlocks, pendingActions, suggestions, sessionId, error: errorMsg });
          return;
        }
        if (code !== 0) {
          resolve({
            text: finalText, usedTools, renderedBlocks, pendingActions, suggestions, sessionId,
            error: `Gemini 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: finalText, usedTools, renderedBlocks, pendingActions, suggestions, sessionId });
      });
    });
  }
}

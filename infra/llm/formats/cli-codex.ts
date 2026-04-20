/**
 * cli-codex format handler
 *
 * OpenAI Codex CLI 를 자식 프로세스로 spawn 하여 실행. ChatGPT Plus/Pro 구독 사용.
 * 인증은 `codex login` 으로 브라우저 OAuth (API 키 불필요).
 *
 * 실행: codex exec "prompt" --json --skip-git-repo-check --full-auto
 * MCP: ~/.codex/config.toml 대신 임시 CODEX_HOME 디렉토리에 config.toml 생성 후 env 주입.
 * Thinking: --config model_reasoning_effort=<level> (minimal|low|medium|high|xhigh)
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

interface RunOptions {
  systemPrompt?: string;
  history?: ChatMessage[];
  cliModel?: string;
  codexHome?: string;
  thinkingLevel?: string;
  resumeSessionId?: string;
  onChunk?: LlmCallOpts['onChunk'];
}

/** THINKING_LEVELS → Codex model_reasoning_effort 매핑 (max 미지원, xhigh 모델 의존) */
function mapThinkingToCodex(level?: string): string | undefined {
  if (!level || level === 'none') return undefined;
  if (level === 'max') return 'xhigh';
  if (['minimal', 'low', 'medium', 'high', 'xhigh'].includes(level)) return level;
  return undefined;
}

export class CliCodexFormat implements FormatHandler {
  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : '\n\n응답은 JSON 객체로만 반환 (마크다운·설명 금지).';
    const res = await this.runCodex(prompt + jsonInstruction, { systemPrompt, history, thinkingLevel: opts?.thinkingLevel });
    if (res.error) return { success: false, error: res.error };
    try { return { success: true, data: JSON.parse(res.text) as LlmJsonResponse }; }
    catch { return { success: true, data: { thoughts: '', reply: res.text, actions: [], suggestions: [] } }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : opts?.jsonMode ? '\n\n응답은 JSON 객체로만 반환.' : '';
    const res = await this.runCodex(prompt + jsonInstruction, { systemPrompt, onChunk: opts?.onChunk, thinkingLevel: opts?.thinkingLevel });
    if (res.error) return { success: false, error: res.error };
    return { success: true, data: res.text };
  }

  async askWithTools(prompt: string, systemPrompt: string, _tools: ToolDefinition[], history: ChatMessage[], _toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const mcpCfg = ctx.resolveMcpConfig?.();
    const codexHome = this.ensureCodexHome(mcpCfg?.token, mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, ''));
    const cliModel = ctx.config.cliModel;
    const resumeSessionId = opts?.cliResumeSessionId;
    const res = await this.runCodex(prompt, {
      systemPrompt,
      history,
      cliModel,
      codexHome,
      thinkingLevel: opts?.thinkingLevel,
      resumeSessionId,
      onChunk: opts?.onChunk,
    });
    if (res.error) return { success: false, error: res.error };
    // 첫 턴에서 session_id 캡처 → 호출자에게 전달
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

  /** Firebat 전용 CODEX_HOME 디렉토리 생성 + config.toml 쓰기 */
  private ensureCodexHome(internalMcpToken?: string | null, baseUrl?: string): string {
    const codexHome = path.join(os.tmpdir(), 'firebat-codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    // 기존 ~/.codex/auth.json 복사 (로그인 세션 유지)
    const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
    const tmpAuth = path.join(codexHome, 'auth.json');
    if (fs.existsSync(realAuth) && !fs.existsSync(tmpAuth)) {
      try { fs.copyFileSync(realAuth, tmpAuth); } catch { /* 권한 이슈는 무시 */ }
    }

    let toml = '';
    if (internalMcpToken) {
      // HTTP 전송은 experimental_use_rmcp_client 필요 (현재 미지원 가능) — stdio 우선
      // baseUrl 이 있으면 향후 HTTP 시도용으로 남겨두지만 기본은 stdio 사용
      const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
      toml += `[features]\nexperimental_use_rmcp_client = true\n\n`;
      toml += `[mcp_servers.firebat]\n`;
      toml += `url = "${url}"\n`;
      toml += `bearer_token_env_var = "FIREBAT_MCP_TOKEN"\n`;
    } else {
      const projectDir = process.cwd();
      const stdioPath = path.join(projectDir, 'mcp', 'stdio-user-ai.ts').replace(/\\/g, '\\\\');
      toml += `[mcp_servers.firebat]\n`;
      toml += `command = "npx"\n`;
      toml += `args = ["tsx", "${stdioPath}"]\n`;
      toml += `cwd = "${projectDir.replace(/\\/g, '\\\\')}"\n`;
    }
    fs.writeFileSync(path.join(codexHome, 'config.toml'), toml);
    return codexHome;
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

  private runCodex(prompt: string, options: RunOptions): Promise<CliRunResult> {
    return new Promise((resolve) => {
      // resume 시 history 주입 생략 — Codex 세션이 이미 컨텍스트 보유
      const finalPrompt = options.resumeSessionId ? prompt : this.buildPromptWithHistory(prompt, options.history);
      const promptWithSystem = options.systemPrompt
        ? `${options.systemPrompt}\n\n${finalPrompt}`
        : finalPrompt;

      // codex exec — non-interactive + --full-auto (workspace-write + on-request approval)
      // resume 시: codex exec resume <session_id> <prompt> ... (서브커맨드)
      const args: string[] = options.resumeSessionId
        ? ['exec', 'resume', options.resumeSessionId, promptWithSystem, '--json', '--skip-git-repo-check', '--full-auto']
        : ['exec', promptWithSystem, '--json', '--skip-git-repo-check', '--full-auto'];
      if (options.cliModel) args.push('--model', options.cliModel);

      const effort = mapThinkingToCodex(options.thinkingLevel);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);

      const childEnv: NodeJS.ProcessEnv = options.codexHome
        ? { ...process.env, CODEX_HOME: options.codexHome }
        : process.env;

      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      } catch (e) {
        resolve({ text: '', usedTools: [], renderedBlocks: [], pendingActions: [], suggestions: [], error: `Codex CLI 실행 실패 (codex 명령어 미설치?): ${(e as Error).message}` });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      const textParts: string[] = [];
      const usedTools: string[] = [];
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

      // Codex exec --json 포맷:
      //   thread.started { thread_id }
      //   turn.started / turn.completed / turn.failed { error: { message } }
      //   item.started / item.completed / item.updated { item: { id, type, ...typeSpecific } }
      //     item.type 종류: agent_message (text), reasoning (text), command_execution,
      //                    file_change, mcp_tool_call (server,tool,arguments,result), web_search, todo_list, error
      //   error { message }
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; }

        const t = ev.type;
        if (t === 'thread.started') {
          if (typeof ev.thread_id === 'string' && !sessionId) sessionId = ev.thread_id;
          return;
        }
        if (t === 'turn.failed') {
          errored = true;
          errorMsg = toErrStr((ev.error as Record<string, unknown>)?.message) || toErrStr(ev.error) || 'Codex turn 실패';
          return;
        }
        if (t === 'error') {
          errored = true;
          errorMsg = toErrStr(ev.message) || 'Codex 오류';
          return;
        }
        if (t === 'turn.started' || t === 'turn.completed') return; // 통계만

        // item.* 이벤트
        if (t === 'item.started' || t === 'item.completed' || t === 'item.updated') {
          const item = ev.item as Record<string, unknown> | undefined;
          if (!item) return;
          const itemType = item.type;
          // agent_message: 최종 assistant 텍스트 (completed 만)
          if (itemType === 'agent_message' && t === 'item.completed' && typeof item.text === 'string') {
            textParts.push(item.text);
            options.onChunk?.({ type: 'text', content: item.text });
            return;
          }
          // reasoning: thinking 스트림
          if (itemType === 'reasoning' && typeof item.text === 'string') {
            options.onChunk?.({ type: 'thinking', content: item.text });
            return;
          }
          // mcp_tool_call: 도구 호출 + 결과
          if (itemType === 'mcp_tool_call') {
            const server = typeof item.server === 'string' ? item.server : '';
            const toolName = typeof item.tool === 'string' ? item.tool : '';
            if (!toolName) return;
            if (t === 'item.started') {
              usedTools.push(toolName);
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${toolName}]` });
              return;
            }
            if (t === 'item.completed' && server === 'firebat') {
              // result.content[0].text 에 우리 MCP 응답 JSON 있음
              const result = item.result as Record<string, unknown> | undefined;
              const contents = result?.content as Array<Record<string, unknown>> | undefined;
              const textPayload = contents?.[0]?.text;
              if (typeof textPayload !== 'string') return;
              try {
                const payload = JSON.parse(textPayload) as Record<string, unknown>;
                if (!payload.success) return;
                const args = (item.arguments as Record<string, unknown>) ?? {};
                // 1) render_* → blocks
                if (toolName === 'render_html' && typeof payload.htmlContent === 'string') {
                  renderedBlocks.push({ type: 'html', htmlContent: payload.htmlContent, htmlHeight: payload.htmlHeight as string | undefined });
                } else if (typeof payload.component === 'string') {
                  renderedBlocks.push({ type: 'component', name: payload.component, props: (payload.props as Record<string, unknown>) ?? {} });
                } else if (RENDER_COMPONENT_MAP[toolName]) {
                  renderedBlocks.push({ type: 'component', name: RENDER_COMPONENT_MAP[toolName], props: args });
                }
                // 2) pending
                if (payload.pending === true && typeof payload.planId === 'string') {
                  pendingActions.push({
                    planId: payload.planId,
                    name: toolName,
                    summary: typeof payload.summary === 'string' ? payload.summary : toolName,
                    args,
                    ...(payload.status === 'past-runat' ? { status: 'past-runat' as const } : {}),
                    ...(typeof payload.originalRunAt === 'string' ? { originalRunAt: payload.originalRunAt } : {}),
                  });
                }
                // 3) suggest
                if (toolName === 'suggest' && Array.isArray(payload.suggestions)) {
                  for (const s of payload.suggestions) suggestions.push(s);
                }
              } catch { /* 파싱 실패 무시 */ }
            }
            return;
          }
          // item.type === 'error' 내부 에러 (치명적 아님, 로깅만)
          if (itemType === 'error' && typeof item.message === 'string') {
            options.onChunk?.({ type: 'thinking', content: `[도구 오류: ${item.message}]` });
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) processLine(line);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      child.on('error', (e) => {
        resolve({ text: textParts.join(''), usedTools, renderedBlocks, pendingActions, suggestions, sessionId, error: `Codex CLI 프로세스 에러: ${e.message}` });
      });
      child.on('close', (code) => {
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        if (errored) {
          resolve({ text: textParts.join(''), usedTools, renderedBlocks, pendingActions, suggestions, sessionId, error: errorMsg });
          return;
        }
        if (code !== 0) {
          resolve({
            text: textParts.join(''), usedTools, renderedBlocks, pendingActions, suggestions, sessionId,
            error: `Codex 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: textParts.join(''), usedTools, renderedBlocks, pendingActions, suggestions, sessionId });
      });
    });
  }
}

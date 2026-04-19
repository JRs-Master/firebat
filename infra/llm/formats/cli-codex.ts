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
  error?: string;
}

interface RunOptions {
  systemPrompt?: string;
  history?: ChatMessage[];
  cliModel?: string;
  codexHome?: string;
  thinkingLevel?: string;
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
    const res = await this.runCodex(prompt, {
      systemPrompt,
      history,
      cliModel,
      codexHome,
      thinkingLevel: opts?.thinkingLevel,
      onChunk: opts?.onChunk,
    });
    if (res.error) return { success: false, error: res.error };
    return {
      success: true,
      data: {
        text: res.text,
        toolCalls: [],
        responseId: res.sessionId,
        internallyUsedTools: res.usedTools,
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
      const finalPrompt = this.buildPromptWithHistory(prompt, options.history);
      const promptWithSystem = options.systemPrompt
        ? `${options.systemPrompt}\n\n${finalPrompt}`
        : finalPrompt;

      // codex exec — non-interactive + --full-auto (workspace-write + on-request approval)
      const args: string[] = ['exec', promptWithSystem, '--json', '--skip-git-repo-check', '--full-auto'];
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
        resolve({ text: '', usedTools: [], error: `Codex CLI 실행 실패 (codex 명령어 미설치?): ${(e as Error).message}` });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      const textParts: string[] = [];
      const usedTools: string[] = [];
      let sessionId: string | undefined;
      let errored = false;
      let errorMsg: string | undefined;

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === 'error' || ev.error) {
            errored = true;
            errorMsg = (ev.message as string) || (ev.error as string) || 'Codex 오류';
            return;
          }
          if (typeof ev.session_id === 'string' && !sessionId) sessionId = ev.session_id;
          if (typeof ev.id === 'string' && !sessionId) sessionId = ev.id;
          const text = (ev.text as string) ?? (ev.content as string) ?? (ev.message as string) ?? (ev.output as string);
          if (typeof text === 'string' && text) {
            textParts.push(text);
            options.onChunk?.({ type: 'text', content: text });
          }
          if (ev.type === 'tool_use' || ev.type === 'tool_call') {
            const toolName = (ev.name as string) || (ev.tool as string);
            if (toolName) {
              const bare = toolName.replace(/^mcp__[^_]+__/, '');
              usedTools.push(bare);
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${bare}]` });
            }
          }
        } catch {
          textParts.push(line);
          options.onChunk?.({ type: 'text', content: line });
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
        resolve({ text: textParts.join(''), usedTools, error: `Codex CLI 프로세스 에러: ${e.message}` });
      });
      child.on('close', (code) => {
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        if (errored) {
          resolve({ text: textParts.join(''), usedTools, sessionId, error: errorMsg });
          return;
        }
        if (code !== 0) {
          resolve({
            text: textParts.join(''), usedTools, sessionId,
            error: `Codex 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: textParts.join(''), usedTools, sessionId });
      });
    });
  }
}

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
  error?: string;
}

interface RunOptions {
  systemPrompt?: string;
  history?: ChatMessage[];
  cliModel?: string;
  geminiHome?: string;
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
    const geminiHome = this.ensureGeminiHome(mcpCfg?.token, mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, ''));
    const cliModel = ctx.config.cliModel;
    const resumeSessionId = opts?.cliResumeSessionId;
    const res = await this.runGemini(prompt, {
      systemPrompt,
      history,
      cliModel,
      geminiHome,
      resumeSessionId,
      onChunk: opts?.onChunk,
    });
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
      },
    };
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
      const finalPrompt = this.buildPromptWithHistory(prompt, options.history);
      const promptWithSystem = options.systemPrompt
        ? `${options.systemPrompt}\n\n${finalPrompt}`
        : finalPrompt;

      // gemini -p "..." --output-format stream-json --approval-mode yolo
      const args: string[] = [
        '-p', promptWithSystem,
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
        child = spawn('gemini', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
      } catch (e) {
        resolve({ text: '', usedTools: [], error: `Gemini CLI 실행 실패 (gemini 명령어 미설치?): ${(e as Error).message}` });
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
            errorMsg = (ev.message as string) || (ev.error as string) || 'Gemini 오류';
            return;
          }
          // session_id 캡처 (Claude Code 와 유사한 stream-json 포맷 가정)
          if (typeof ev.session_id === 'string' && !sessionId) sessionId = ev.session_id;
          if (typeof ev.sessionId === 'string' && !sessionId) sessionId = ev.sessionId;
          // message / text chunk
          const text = (ev.text as string) ?? (ev.content as string) ?? (ev.message as string);
          if (typeof text === 'string' && text) {
            textParts.push(text);
            options.onChunk?.({ type: 'text', content: text });
          }
          // tool_use
          if (ev.type === 'tool_use' || ev.type === 'tool_call' || ev.type === 'function_call') {
            const toolName = (ev.name as string) || (ev.tool as string);
            if (toolName) {
              const bare = toolName.replace(/^mcp__[^_]+__/, '');
              usedTools.push(bare);
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${bare}]` });
            }
          }
        } catch {
          // JSON 아닌 텍스트 — 일반 출력 누적 (json 포맷 실패 대비)
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
        resolve({ text: textParts.join(''), usedTools, sessionId, error: `Gemini CLI 프로세스 에러: ${e.message}` });
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
            error: `Gemini 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: textParts.join(''), usedTools, sessionId });
      });
    });
  }
}

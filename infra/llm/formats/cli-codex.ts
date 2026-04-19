/**
 * cli-codex format handler
 *
 * OpenAI Codex CLI 를 자식 프로세스로 spawn 하여 실행. ChatGPT Plus/Pro 구독 사용.
 * 인증은 `codex login` 으로 브라우저 OAuth (API 키 불필요).
 *
 * 실행: codex exec "prompt" --json
 * MCP: ~/.codex/config.toml 또는 --config 플래그로 지정.
 *
 * Claude Code 와 MCP 연결 방식·출력 파싱은 다름.
 * 기본 버전 — 텍스트 + 도구 뱃지 수준. render block 추출은 Codex 의 실제 이벤트
 * 포맷 확정 후 확장 예정 (현재는 구독 연결 + 기본 응답 전달 목표).
 */
import { spawn } from 'child_process';
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
  mcpConfigPath?: string;
  onChunk?: LlmCallOpts['onChunk'];
}

export class CliCodexFormat implements FormatHandler {
  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : '\n\n응답은 JSON 객체로만 반환 (마크다운·설명 금지).';
    const res = await this.runCodex(prompt + jsonInstruction, { systemPrompt, history });
    if (res.error) return { success: false, error: res.error };
    try { return { success: true, data: JSON.parse(res.text) as LlmJsonResponse }; }
    catch { return { success: true, data: { thoughts: '', reply: res.text, actions: [], suggestions: [] } }; }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : opts?.jsonMode ? '\n\n응답은 JSON 객체로만 반환.' : '';
    const res = await this.runCodex(prompt + jsonInstruction, { systemPrompt, onChunk: opts?.onChunk });
    if (res.error) return { success: false, error: res.error };
    return { success: true, data: res.text };
  }

  async askWithTools(prompt: string, systemPrompt: string, _tools: ToolDefinition[], history: ChatMessage[], _toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    const mcpCfg = ctx.resolveMcpConfig?.();
    const mcpConfigPath = this.ensureMcpConfigFile(mcpCfg?.token, mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, ''));
    const cliModel = ctx.config.cliModel;
    const res = await this.runCodex(prompt, {
      systemPrompt,
      history,
      cliModel,
      mcpConfigPath,
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

  private ensureMcpConfigFile(internalMcpToken?: string | null, baseUrl?: string): string {
    const configPath = path.join(os.tmpdir(), 'firebat-codex-mcp-config.json');
    let config: Record<string, unknown>;
    if (internalMcpToken) {
      const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
      config = {
        mcpServers: {
          firebat: { type: 'http', url, headers: { Authorization: `Bearer ${internalMcpToken}` } },
        },
      };
    } else {
      const projectDir = process.cwd();
      const stdioPath = path.join(projectDir, 'mcp', 'stdio-user-ai.ts');
      config = {
        mcpServers: { firebat: { command: 'npx', args: ['tsx', stdioPath], cwd: projectDir } },
      };
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
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

      // codex exec — non-interactive 모드. --json 으로 이벤트 스트림.
      const args: string[] = ['exec', promptWithSystem, '--json', '--skip-git-repo-check'];
      if (options.cliModel) {
        args.push('--model', options.cliModel);
      }
      if (options.mcpConfigPath) {
        args.push('--config', `mcp_config_file=${options.mcpConfigPath}`);
      }

      let child;
      try {
        child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
          // session id
          if (typeof ev.session_id === 'string' && !sessionId) sessionId = ev.session_id;
          if (typeof ev.id === 'string' && !sessionId) sessionId = ev.id;
          // text 추출 — 여러 이벤트 포맷 대응
          const text = (ev.text as string) ?? (ev.content as string) ?? (ev.message as string) ?? (ev.output as string);
          if (typeof text === 'string' && text) {
            textParts.push(text);
            options.onChunk?.({ type: 'text', content: text });
          }
          // tool_use
          if (ev.type === 'tool_use' || ev.type === 'tool_call') {
            const toolName = (ev.name as string) || (ev.tool as string);
            if (toolName) {
              const bare = toolName.replace(/^mcp__[^_]+__/, '');
              usedTools.push(bare);
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${bare}]` });
            }
          }
        } catch {
          // JSON 아닌 텍스트 — 일반 출력으로 누적
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

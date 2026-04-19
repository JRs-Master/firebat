/**
 * cli-gemini format handler
 *
 * Google Gemini CLI 를 자식 프로세스로 spawn 하여 실행. Google AI Pro 구독 (또는 무료 티어) 사용.
 * 인증은 `gemini auth login` 으로 Google OAuth (API 키 불필요).
 *
 * 실행: gemini -p "prompt" --output-format json
 * MCP: ~/.gemini/settings.json 의 mcpServers 또는 --mcp-config 플래그.
 *
 * Gemini CLI 는 기본적으로 텍스트 출력. stream-json 포맷은 Claude Code 와 다름.
 * 기본 버전 — 텍스트 + 도구 뱃지 수준.
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
    const mcpConfigPath = this.ensureMcpConfigFile(mcpCfg?.token, mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, ''));
    const cliModel = ctx.config.cliModel;
    const res = await this.runGemini(prompt, {
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
        internallyUsedTools: res.usedTools,
      },
    };
  }

  private ensureMcpConfigFile(internalMcpToken?: string | null, baseUrl?: string): string {
    const configPath = path.join(os.tmpdir(), 'firebat-gemini-mcp-config.json');
    let config: Record<string, unknown>;
    if (internalMcpToken) {
      const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
      config = {
        mcpServers: {
          firebat: { httpUrl: url, headers: { Authorization: `Bearer ${internalMcpToken}` } },
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

  private runGemini(prompt: string, options: RunOptions): Promise<CliRunResult> {
    return new Promise((resolve) => {
      const finalPrompt = this.buildPromptWithHistory(prompt, options.history);
      const promptWithSystem = options.systemPrompt
        ? `${options.systemPrompt}\n\n${finalPrompt}`
        : finalPrompt;

      // gemini -p "..." 비대화 모드
      const args: string[] = ['-p', promptWithSystem, '--yolo'];
      if (options.cliModel) {
        args.push('-m', options.cliModel);
      }
      if (options.mcpConfigPath) {
        // Gemini CLI 는 --mcp-config 또는 settings.json 경유. 플래그 이름 다를 수 있음.
        args.push('--mcp-config', options.mcpConfigPath);
      }

      let child;
      try {
        child = spawn('gemini', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ text: '', usedTools: [], error: `Gemini CLI 실행 실패 (gemini 명령어 미설치?): ${(e as Error).message}` });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      const usedTools: string[] = [];

      // Gemini CLI 는 기본 스트리밍 텍스트 출력. 도구 호출 이벤트는 stderr 에 로그로 나오기도 함.
      const processChunk = (text: string) => {
        options.onChunk?.({ type: 'text', content: text });
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuf += text;
        processChunk(text);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        // stderr 에서 tool 호출 로그 패턴 감지 (정확한 포맷은 CLI 버전마다 다름)
        const toolMatch = chunk.toString().match(/(?:tool|function)\s*call[:\s]+([\w_]+)/i);
        if (toolMatch) {
          const bare = toolMatch[1].replace(/^mcp__[^_]+__/, '');
          usedTools.push(bare);
          options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${bare}]` });
        }
      });
      child.on('error', (e) => {
        resolve({ text: stdoutBuf, usedTools, error: `Gemini CLI 프로세스 에러: ${e.message}` });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          resolve({
            text: stdoutBuf, usedTools,
            error: `Gemini 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: stdoutBuf, usedTools });
      });
    });
  }
}

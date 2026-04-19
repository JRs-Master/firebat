/**
 * cli-claude-code format handler
 *
 * Claude Code CLI 를 자식 프로세스로 spawn 하여 실행.
 * 인증은 CLI 자체가 관리 (~/.claude/credentials). API 키 불필요, Claude Pro/Max 구독 사용.
 *
 * 흐름:
 *   spawn('claude', ['--print', prompt, '--output-format', 'stream-json', '--mcp-config', ...])
 *   → stdout 에 line-delimited JSON 이벤트 스트림
 *   → type 별 파싱: assistant.text / assistant.tool_use / user.tool_result / result
 *
 * tool 사용은 Claude Code 가 내부에서 처리 (MCP 서버 연결 통해). 우리는 prompt 만 넘기고 최종 text 받음.
 * 멀티턴 세션 재개는 session_id 기반 `--resume` 플래그 사용 (ctx 에서 주입).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChatMessage, LlmCallOpts, LlmJsonResponse, LlmToolResponse, ToolDefinition, ToolExchangeEntry } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { FormatHandler, FormatHandlerContext } from '../format-handler';

/** CLI 프로세스 실행 + stream-json 파싱 결과 */
interface CliRunResult {
  text: string;
  sessionId?: string;
  usedTools: string[];
  error?: string;
}

interface RunOptions {
  systemPrompt?: string;
  history?: ChatMessage[];
  resumeSessionId?: string;
  mcpConfigPath?: string;
  cliModel?: string;
  thinkingLevel?: string;
  onChunk?: LlmCallOpts['onChunk'];
}

/** Firebat thinkingLevel → Anthropic extended thinking budget_tokens */
function thinkingBudgetTokens(level?: string): number | null {
  if (!level || level === 'none') return null;
  const map: Record<string, number> = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 32768,
    max: 65536,
  };
  return map[level] ?? null;
}

/** stream-json 이벤트 타입 */
interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
    }>;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  result?: string;
}

export class CliClaudeCodeFormat implements FormatHandler {
  async ask(prompt: string, systemPrompt: string | undefined, history: ChatMessage[], opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<LlmJsonResponse>> {
    // JSON 모드: Claude Code 에 JSON 반환 지시. jsonSchema 있으면 프롬프트에 병합.
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : '\n\n응답은 JSON 객체로만 반환 (마크다운·설명 금지).';
    const finalPrompt = prompt + jsonInstruction;

    const res = await this.runClaude(finalPrompt, { systemPrompt, history });
    if (res.error) return { success: false, error: res.error };
    try {
      return { success: true, data: JSON.parse(res.text) as LlmJsonResponse };
    } catch {
      return { success: true, data: { thoughts: '', reply: res.text, actions: [], suggestions: [] } };
    }
  }

  async askText(prompt: string, systemPrompt: string | undefined, opts: LlmCallOpts | undefined, _ctx: FormatHandlerContext): Promise<InfraResult<string>> {
    const jsonInstruction = opts?.jsonSchema
      ? `\n\n응답은 다음 JSON 스키마를 정확히 따르는 JSON 객체로만 반환 (마크다운·설명 금지):\n${JSON.stringify(opts.jsonSchema)}`
      : opts?.jsonMode ? '\n\n응답은 JSON 객체로만 반환 (마크다운·설명 금지).' : '';
    const finalPrompt = prompt + jsonInstruction;
    const res = await this.runClaude(finalPrompt, { systemPrompt, onChunk: opts?.onChunk });
    if (res.error) return { success: false, error: res.error };
    return { success: true, data: res.text };
  }

  async askWithTools(prompt: string, systemPrompt: string, _tools: ToolDefinition[], history: ChatMessage[], _toolExchanges: ToolExchangeEntry[], opts: LlmCallOpts | undefined, ctx: FormatHandlerContext): Promise<InfraResult<LlmToolResponse>> {
    // Claude Code 가 내부에서 tool use loop 처리 (MCP 서버 통해).
    // 우리는 prompt + systemPrompt + 초기 history 를 넘기고 최종 text 만 받음.
    // toolExchanges 는 CLI 내부 처리이므로 빈 배열 반환.
    const resumeSessionId = (opts as { cliSessionId?: string })?.cliSessionId;
    const mcpConfigPath = this.ensureMcpConfigFile();
    const cliModel = ctx.config.cliModel;

    const res = await this.runClaude(prompt, {
      systemPrompt,
      history,
      resumeSessionId,
      mcpConfigPath,
      cliModel,
      thinkingLevel: opts?.thinkingLevel,
      onChunk: opts?.onChunk,
    });

    if (res.error) return { success: false, error: res.error };
    return {
      success: true,
      data: {
        text: res.text,
        toolCalls: [],
        responseId: res.sessionId, // 다음 턴 resume 용
      },
    };
  }

  /**
   * Firebat MCP 서버를 연결한 mcp-config.json 을 임시 디렉토리에 생성.
   * Claude Code 가 이 config 로 MCP 서버 연결 → Firebat 내부 도구 사용 가능.
   */
  private ensureMcpConfigFile(): string {
    const configPath = path.join(os.tmpdir(), 'firebat-claude-mcp-config.json');
    const projectDir = process.cwd();
    const stdioPath = path.join(projectDir, 'mcp', 'stdio.ts');
    const config = {
      mcpServers: {
        firebat: {
          command: 'npx',
          args: ['tsx', stdioPath],
          cwd: projectDir,
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  /** history 를 prompt 앞에 병합 (resume 미사용 시 전체 맥락 주입용) */
  private buildPromptWithHistory(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) return prompt;
    const recent = history.slice(-10); // 최근 10턴만
    const hist = recent.map(h => {
      const role = h.role === 'assistant' ? 'AI' : '사용자';
      const content = typeof h.content === 'string' ? h.content : JSON.stringify(h.content);
      return `${role}: ${content}`;
    }).join('\n\n');
    return `[이전 대화]\n${hist}\n\n[현재 요청]\n${prompt}`;
  }

  /** Claude Code 프로세스 실행 + stream-json 파싱 */
  private runClaude(prompt: string, options: RunOptions): Promise<CliRunResult> {
    return new Promise((resolve) => {
      // resume 없으면 history 를 prompt 에 병합해서 맥락 주입
      const finalPrompt = options.resumeSessionId ? prompt : this.buildPromptWithHistory(prompt, options.history);
      const args: string[] = [
        '--print', finalPrompt,
        '--output-format', 'stream-json',
        '--verbose',
        // 권한 프롬프트 자동 우회 (headless 모드 필수).
        // Firebat MCP 도구는 이미 Core 내부 승인 시스템(checkNeedsApproval) 이 있으므로
        // Claude Code 쪽 추가 확인은 중복.
        '--dangerously-skip-permissions',
      ];

      if (options.systemPrompt) {
        args.push('--append-system-prompt', options.systemPrompt);
      }
      if (options.resumeSessionId) {
        args.push('--resume', options.resumeSessionId);
      }
      if (options.mcpConfigPath) {
        args.push('--mcp-config', options.mcpConfigPath);
      }
      if (options.cliModel) {
        args.push('--model', options.cliModel);
      }
      const thinkingBudget = thinkingBudgetTokens(options.thinkingLevel);
      if (thinkingBudget != null) {
        args.push('--max-thinking-tokens', String(thinkingBudget));
      }

      let child;
      try {
        child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ text: '', usedTools: [], error: `Claude Code CLI 실행 실패 (claude 명령어 미설치?): ${(e as Error).message}` });
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
        let ev: ClaudeEvent;
        try { ev = JSON.parse(line) as ClaudeEvent; }
        catch { return; /* 파싱 실패 스킵 */ }

        // 세션 ID 캡처 (첫 system.init 또는 응답 메시지에서)
        if (ev.session_id && !sessionId) sessionId = ev.session_id;

        // 에러 이벤트
        if (ev.is_error === true || ev.subtype === 'error') {
          errored = true;
          errorMsg = ev.result || 'Claude Code CLI 오류';
          return;
        }

        // assistant 메시지: text / tool_use
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              textParts.push(c.text);
              options.onChunk?.({ type: 'text', content: c.text });
            } else if (c.type === 'tool_use' && typeof c.name === 'string') {
              usedTools.push(c.name);
              // 도구 호출 시작을 thinking 스트림으로 알림 (UI 표시용)
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${c.name}]` });
            }
          }
        }
        // 결과 이벤트 (실행 종료)
        if (ev.type === 'result') {
          if (ev.is_error) {
            errored = true;
            errorMsg = ev.result || '실행 오류';
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) processLine(line);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      child.on('error', (e) => {
        resolve({ text: '', usedTools, error: `Claude Code CLI 프로세스 에러: ${e.message}` });
      });

      child.on('close', (code) => {
        // 잔여 stdout 처리
        if (stdoutBuf.trim()) processLine(stdoutBuf);

        if (errored) {
          resolve({ text: textParts.join(''), usedTools, sessionId, error: errorMsg });
          return;
        }
        if (code !== 0) {
          resolve({
            text: textParts.join(''),
            usedTools,
            sessionId,
            error: `Claude Code 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: textParts.join(''), usedTools, sessionId });
      });
    });
  }
}

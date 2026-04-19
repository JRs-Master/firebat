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
    // HTTP MCP 우선 — 내부 토큰 있으면 Firebat 메인 프로세스 /api/mcp-internal 에 연결 (즉시)
    const mcpCfg = ctx.resolveMcpConfig?.();
    const mcpConfigPath = this.ensureMcpConfigFile(mcpCfg?.token, mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, ''));
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
   *
   * HTTP streamable 전송 우선 — 이미 Firebat 메인 프로세스에 떠있는 /api/mcp-internal 에 연결.
   * 매 claude spawn 마다 서브프로세스로 Firebat Core 를 재부팅(~수분) 하지 않고 즉시 도구 사용 가능.
   *
   * 내부 MCP 토큰이 없으면 stdio 폴백 (기존 경로, 초기 부팅 느림).
   */
  private ensureMcpConfigFile(internalMcpToken?: string | null, baseUrl?: string): string {
    const configPath = path.join(os.tmpdir(), 'firebat-claude-mcp-config.json');
    const projectDir = process.cwd();

    let config: Record<string, unknown>;
    if (internalMcpToken) {
      // HTTP streamable — Firebat 메인 프로세스의 /api/mcp-internal 에 연결 (즉시, 캐시된 Core 공유)
      const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
      config = {
        mcpServers: {
          firebat: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${internalMcpToken}` },
          },
        },
      };
    } else {
      // stdio 폴백 — 토큰 미설정 시. 매번 Firebat Core 재부팅하므로 초기 호출 느림.
      const stdioPath = path.join(projectDir, 'mcp', 'stdio-user-ai.ts');
      config = {
        mcpServers: {
          firebat: {
            command: 'npx',
            args: ['tsx', stdioPath],
            cwd: projectDir,
          },
        },
      };
    }

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
        // Firebat MCP 도구 전부 허용 — Core 내부 checkNeedsApproval 이 위험 작업은 이미 승인 대기로 처리.
        // (--dangerously-skip-permissions 는 root 권한에서 차단되므로 whitelist 방식 사용)
        '--allowed-tools', 'mcp__firebat__*',
      ];

      if (options.systemPrompt) {
        // --system-prompt 로 완전 교체 — Claude Code 기본 "코딩 도구" 프롬프트 대신
        // Firebat User AI 페르소나·시각화 규칙을 주입
        args.push('--system-prompt', options.systemPrompt);
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
        // stdin 을 즉시 닫아서 "no stdin data received in 3s" 경고 방지.
        // --print 모드는 prompt 를 인자로 받으므로 stdin 불필요.
        child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ text: '', usedTools: [], error: `Claude Code CLI 실행 실패 (claude 명령어 미설치?): ${(e as Error).message}` });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      // 최종 response 는 "마지막 tool_use/tool_result 이후의 assistant text" 만 채택.
      // 중간 assistant text (도구 호출 사이에 끼는 진행 멘트) 는 thinking 스트림으로 보내고 최종 응답엔 미포함.
      let currentTextBuffer = ''; // 현재 assistant turn 의 누적 text
      let finalText = ''; // 최종 (도구 호출 없이 끝나는) assistant text
      const usedTools: string[] = [];
      let sessionId: string | undefined;
      let errored = false;
      let errorMsg: string | undefined;

      const flushIntermediateAsThinking = () => {
        // 현재 currentTextBuffer 를 중간 멘트로 간주 → thinking 스트림으로 보내고 비움
        if (currentTextBuffer.trim()) {
          options.onChunk?.({ type: 'thinking', content: currentTextBuffer });
        }
        currentTextBuffer = '';
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let ev: ClaudeEvent;
        try { ev = JSON.parse(line) as ClaudeEvent; }
        catch { return; /* 파싱 실패 스킵 */ }

        if (ev.session_id && !sessionId) sessionId = ev.session_id;

        if (ev.is_error === true || ev.subtype === 'error') {
          errored = true;
          errorMsg = ev.result || 'Claude Code CLI 오류';
          return;
        }

        // assistant: text 누적 / tool_use 감지 시 직전까지의 text 를 중간 멘트로 처리
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              currentTextBuffer += c.text;
            } else if (c.type === 'tool_use' && typeof c.name === 'string') {
              // 도구 호출 발생 → 지금까지의 text 는 중간 멘트 → thinking 으로 노출
              flushIntermediateAsThinking();
              usedTools.push(c.name);
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${c.name}]` });
            }
          }
        }
        // tool_result 는 user 이벤트로 옴 — assistant 가 다시 말을 시작하는 경계
        if (ev.type === 'user' && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === 'tool_result') {
              // 도구 결과 받음 — buffer 정리 (이미 tool_use 직전에 flush 했지만 안전망)
              flushIntermediateAsThinking();
            }
          }
        }
        // 결과 이벤트 (실행 종료) — 이 시점의 currentTextBuffer = 최종 응답
        if (ev.type === 'result') {
          if (ev.is_error) {
            errored = true;
            errorMsg = ev.result || '실행 오류';
          } else {
            // 최종 text 는 마지막 assistant turn 의 buffer
            finalText = currentTextBuffer;
            // 스트리밍 시 화면 표시를 위해 text 이벤트로 발행
            if (finalText) options.onChunk?.({ type: 'text', content: finalText });
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

        // result 이벤트 없이 종료됐는데 currentTextBuffer 에 내용 있으면 그게 최종 응답
        if (!finalText && currentTextBuffer.trim()) finalText = currentTextBuffer;

        if (errored) {
          resolve({ text: finalText, usedTools, sessionId, error: errorMsg });
          return;
        }
        if (code !== 0) {
          resolve({
            text: finalText,
            usedTools,
            sessionId,
            error: `Claude Code 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: finalText, usedTools, sessionId });
      });
    });
  }
}

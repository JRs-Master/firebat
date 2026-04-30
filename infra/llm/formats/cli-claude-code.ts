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
import { claudeDaemonManager, hashSpawnConfig } from './claude-code-daemon';

/** CLI 프로세스 실행 + stream-json 파싱 결과 */
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

// render_* 도구 매핑은 lib/render-map.ts 단일 source 에서 import
import { RENDER_TOOL_MAP as RENDER_COMPONENT_MAP } from '../../../lib/render-map';

/** mcp__firebat__render_stock_chart → render_stock_chart */
function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
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

/** Firebat thinkingLevel → Claude Code CLI --effort 값 (low/medium/high/xhigh/max).
 *  minimal/none 은 미지원이므로 null 반환 (플래그 생략). */
function mapThinkingToEffort(level?: string): string | null {
  if (!level || level === 'none' || level === 'minimal') return null;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) return level;
  return null;
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
  /** Claude Code CLI 내장 도구 — 이미 --allowed-tools 로 필터링되지만 프롬프트에서도 재강조. */
  getBannedInternalTools(): string[] {
    return ['Task', 'Agent', 'ToolSearch'];
  }

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
    const resumeSessionId = opts?.cliResumeSessionId;
    // HTTP MCP 우선 — 내부 토큰 있으면 Firebat 메인 프로세스 /api/mcp-internal 에 연결 (즉시)
    const mcpCfg = ctx.resolveMcpConfig?.();
    const mcpConfigPath = this.ensureMcpConfigFile(mcpCfg?.token, mcpCfg?.url?.replace(/\/api\/mcp-internal.*$/, ''));
    const cliModel = ctx.config.cliModel;
    const thinkingEffort = mapThinkingToEffort(opts?.thinkingLevel) ?? undefined;

    // conversationId 있으면 persistent daemon 경유 — spawn 오버헤드 제거
    const conversationId = opts?.conversationId;
    if (conversationId) {
      const cfgHash = hashSpawnConfig(systemPrompt, mcpConfigPath, cliModel, thinkingEffort);
      const daemonKey = `${conversationId}:${cfgHash}`;
      const daemon = claudeDaemonManager.getOrCreate(daemonKey, {
        systemPrompt,
        mcpConfigPath,
        cliModel,
        thinkingEffort,
      });
      // 신규 데몬(첫 send) 이면 UI 의 prior history 를 주입. warm daemon 은 자체 세션 보유 → prompt 만.
      const daemonPrompt = daemon.isFirstSend()
        ? this.buildPromptWithHistory(prompt, history)
        : prompt;
      const daemonRes = await daemon.send(daemonPrompt, opts?.onChunk);
      if (daemonRes.error) {
        // 데몬 실패 시 invalidate + 콜드 경로 폴백 (안정성)
        claudeDaemonManager.invalidate(conversationId);
      } else {
        if (daemonRes.sessionId && !resumeSessionId && opts?.onCliSessionId) {
          opts.onCliSessionId(daemonRes.sessionId);
        }
        return {
          success: true,
          data: {
            text: daemonRes.text,
            toolCalls: [],
            responseId: daemonRes.sessionId,
            internallyUsedTools: daemonRes.usedTools,
            renderedBlocks: daemonRes.renderedBlocks,
            pendingActions: daemonRes.pendingActions,
            suggestions: daemonRes.suggestions,
          },
        };
      }
    }

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
    // 첫 턴: session_id 캡처 → 호출자에게 전달 (DB 영속화 용)
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
   * Claude Code 가 ~/.claude/projects/ 하위 각 프로젝트의 tool-results 디렉토리에 만드는
   * 디스크 캐시를 정리. 세션 종료마다 호출 — 오래된 캐시가 디스크 누적되는 것 방지.
   * 10분 이전 파일만 제거 (현재 실행 중 참조 방지).
   */
  private async cleanupClaudeCacheFiles(): Promise<void> {
    try {
      const homeDir = os.homedir();
      const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
      if (!fs.existsSync(claudeProjectsDir)) return;
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      const entries = fs.readdirSync(claudeProjectsDir);
      for (const proj of entries) {
        const toolResultsDir = path.join(claudeProjectsDir, proj, 'tool-results');
        if (!fs.existsSync(toolResultsDir)) continue;
        try {
          const files = fs.readdirSync(toolResultsDir);
          for (const f of files) {
            const fp = path.join(toolResultsDir, f);
            try {
              const st = fs.statSync(fp);
              if (st.mtimeMs < tenMinAgo) fs.unlinkSync(fp);
            } catch {}
          }
        } catch {}
      }
    } catch {}
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
        // Firebat MCP 도구만 허용 — Core 내부 checkNeedsApproval 이 위험 작업 승인 처리.
        // (--dangerously-skip-permissions 는 root 권한에서 차단되므로 whitelist 방식)
        '--allowed-tools', 'mcp__firebat__*',
        // Claude Code 내장 도구 차단 — Firebat 맥락에서 불필요한 작업으로 시간 낭비.
        // 특히 Agent/Task(서브에이전트 spawn), ToolSearch(도구 탐색 에이전트) 는
        // 수십 초~수분 추가 소요. MCP 기반 Firebat 도구만 사용하도록 전면 제한.
        '--disallowed-tools', 'Agent,Task,TaskOutput,TaskStop,ToolSearch,SlashCommand,Bash,BashOutput,KillBash,KillShell,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,TodoWrite,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,Monitor,PushNotification,RemoteTrigger,ScheduleWakeup,Skill,AskUserQuestion,CronCreate,CronDelete,CronList,ListMcpResources,ReadMcpResource',
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
      const effort = mapThinkingToEffort(options.thinkingLevel);
      if (effort) {
        args.push('--effort', effort);
      }

      let child;
      try {
        child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ text: '', usedTools: [], renderedBlocks: [], pendingActions: [], suggestions: [], error: `Claude Code CLI 실행 실패 (claude 명령어 미설치?): ${(e as Error).message}` });
        return;
      }

      let stdoutBuf = '';
      let stderrBuf = '';
      let currentTextBuffer = '';
      let finalText = '';
      const usedTools: string[] = [];
      const pendingToolUses = new Map<string, { name: string; input: unknown }>();
      const renderedBlocks: CliRunResult['renderedBlocks'] = [];
      const pendingActions: CliRunResult['pendingActions'] = [];
      const suggestions: unknown[] = [];
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
          // 실제 에러 정보 가능한 한 노출 — ev.result 우선, 그 외 type/subtype/message·error 필드 폴백
          const detail = ev.result
            || (ev as unknown as { error?: string }).error
            || (ev as unknown as { message?: { content?: unknown } }).message?.content
            || JSON.stringify(ev).slice(0, 300);
          errorMsg = `Claude CLI: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}`;
          return;
        }

        // assistant: text / thinking / tool_use
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === 'text' && typeof c.text === 'string') {
              currentTextBuffer += c.text;
            } else if (c.type === 'thinking') {
              // Extended thinking 블록 — UI 의 "생각 중" 영역으로 스트리밍
              const thinkingText = (c as unknown as { thinking?: string }).thinking;
              if (typeof thinkingText === 'string' && thinkingText) {
                options.onChunk?.({ type: 'thinking', content: thinkingText });
              }
            } else if (c.type === 'tool_use' && typeof c.name === 'string') {
              // 도구 호출 발생 → 지금까지의 text 는 중간 멘트 → thinking 으로 노출
              flushIntermediateAsThinking();
              const bareName = stripMcpPrefix(c.name);
              usedTools.push(bareName);
              options.onChunk?.({ type: 'thinking', content: `[도구 호출: ${bareName}]` });
              // tool_use id 기록 → 나중 tool_result 매칭용
              const toolUseId = (c as unknown as { id?: string }).id;
              if (toolUseId) pendingToolUses.set(toolUseId, { name: bareName, input: c.input });
            }
          }
        }
        // tool_result 는 user 이벤트로 옴 — render_* 결과면 UI blocks 로 추출
        if (ev.type === 'user' && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === 'tool_result') {
              flushIntermediateAsThinking();
              const toolUseId = (c as unknown as { tool_use_id?: string }).tool_use_id;
              const pending = toolUseId ? pendingToolUses.get(toolUseId) : undefined;
              if (pending) {
                // Firebat MCP render 도구 결과 → UI blocks 추가
                // content 는 array[{type:'text',text:'{"success":true,"component":"X","props":{...}}'}] 형식
                const rawContent = (c as unknown as { content?: unknown }).content;
                const textPayload = Array.isArray(rawContent)
                  ? (rawContent[0] as { text?: string })?.text
                  : typeof rawContent === 'string' ? rawContent : undefined;
                if (textPayload) {
                  try {
                    const payload = JSON.parse(textPayload) as Record<string, unknown>;
                    if (payload.success) {
                      // 1) render_* 결과 → blocks
                      if (pending.name === 'render_iframe' && typeof payload.htmlContent === 'string') {
                        renderedBlocks.push({ type: 'html', htmlContent: payload.htmlContent, htmlHeight: payload.htmlHeight as string | undefined });
                      } else if (typeof payload.component === 'string') {
                        renderedBlocks.push({ type: 'component', name: payload.component, props: (payload.props as Record<string, unknown>) ?? {} });
                      } else if (RENDER_COMPONENT_MAP[pending.name]) {
                        renderedBlocks.push({ type: 'component', name: RENDER_COMPONENT_MAP[pending.name], props: (pending.input as Record<string, unknown>) ?? {} });
                      }
                      // 2) 승인 대기 도구 (schedule_task/save_page/delete_page/delete_file) → pendingActions
                      if (payload.pending === true && typeof payload.planId === 'string') {
                        pendingActions.push({
                          planId: payload.planId,
                          name: pending.name,
                          summary: typeof payload.summary === 'string' ? payload.summary : pending.name,
                          args: pending.input as Record<string, unknown> | undefined,
                          ...(payload.status === 'past-runat' ? { status: 'past-runat' as const } : {}),
                          ...(typeof payload.originalRunAt === 'string' ? { originalRunAt: payload.originalRunAt } : {}),
                        });
                      }
                      // 3) suggest 도구 → suggestions
                      if ((pending.name === 'suggest' || pending.name === 'propose_plan') && Array.isArray(payload.suggestions)) {
                        for (const s of payload.suggestions) suggestions.push(s);
                      }
                    }
                  } catch { /* 파싱 실패 시 무시 */ }
                }
                pendingToolUses.delete(toolUseId!);
              }
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
            // CLI 는 진짜 스트리밍이 아니라 result 시점 일괄 emit — thinking 으로 보내서 thinkingText 에만 쌓음.
            // 최종 content 는 RESULT.reply 로 결정 (ai-manager 가 propose_plan trailing drop 등 판단).
            // text 로 보내면 "137자 content flash → RESULT(reply='')로 비워짐" 발생.
            if (finalText) options.onChunk?.({ type: 'thinking', content: finalText });
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
        resolve({ text: '', usedTools, renderedBlocks, pendingActions, suggestions, error: `Claude Code CLI 프로세스 에러: ${e.message}` });
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        if (!finalText && currentTextBuffer.trim()) finalText = currentTextBuffer;
        this.cleanupClaudeCacheFiles().catch(() => {});

        if (errored) {
          resolve({ text: finalText, usedTools, renderedBlocks, pendingActions, suggestions, sessionId, error: errorMsg });
          return;
        }
        if (code !== 0) {
          resolve({
            text: finalText, usedTools, renderedBlocks, pendingActions, suggestions, sessionId,
            error: `Claude Code 비정상 종료 (exit ${code}): ${stderrBuf.slice(0, 500)}`,
          });
          return;
        }
        resolve({ text: finalText, usedTools, renderedBlocks, pendingActions, suggestions, sessionId });
      });
    });
  }
}

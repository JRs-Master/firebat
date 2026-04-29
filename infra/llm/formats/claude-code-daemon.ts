/**
 * Claude Code Persistent Daemon
 *
 * 대화(conversationId)당 `claude` 서브프로세스 1개를 장시간 유지.
 * stdin stream-json 포맷으로 유저 메시지를 주입, stdout stream-json 이벤트로 응답 수집.
 *
 * 효과: 매 턴마다 spawn + MCP 연결 + 히스토리 로드를 반복하지 않음.
 *   2번째 턴부터 ~10초 이상 절약.
 *
 * 제약:
 *   - 모델/system prompt/MCP config 가 바뀌면 새 데몬 필요 (key 에 반영)
 *   - 전역 MAX_DAEMONS LRU
 *   - IDLE_TIMEOUT_MS 지나면 자동 종료
 */
import { spawn, ChildProcessByStdio } from 'child_process';
import type { Writable, Readable } from 'stream';
import type { LlmChunk } from '../../../core/ports';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_DAEMONS = 5;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

// render_* 도구 매핑은 lib/render-map.ts 단일 source 에서 import
import { RENDER_TOOL_MAP as RENDER_COMPONENT_MAP } from '../../../lib/render-map';

function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

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
  is_error?: boolean;
  result?: string;
}

export interface DaemonRunResult {
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

/** 요청 단위 이벤트 누적 상태 — 매 요청 시작 시 reset */
class RequestState {
  currentTextBuffer = '';
  finalText = '';
  usedTools: string[] = [];
  pendingToolUses = new Map<string, { name: string; input: unknown }>();
  renderedBlocks: DaemonRunResult['renderedBlocks'] = [];
  pendingActions: DaemonRunResult['pendingActions'] = [];
  suggestions: unknown[] = [];
  sessionId?: string;
  errored = false;
  errorMsg?: string;
  complete = false;

  flushIntermediateAsThinking(onChunk?: (c: LlmChunk) => void) {
    if (this.currentTextBuffer.trim() && onChunk) {
      onChunk({ type: 'thinking', content: this.currentTextBuffer });
    }
    this.currentTextBuffer = '';
  }

  processLine(line: string, onChunk?: (c: LlmChunk) => void): void {
    if (!line.trim()) return;
    let ev: ClaudeEvent;
    try { ev = JSON.parse(line) as ClaudeEvent; } catch { return; }

    if (ev.session_id && !this.sessionId) this.sessionId = ev.session_id;

    if (ev.is_error === true || ev.subtype === 'error') {
      this.errored = true;
      const detail = ev.result
        || (ev as unknown as { error?: string }).error
        || (ev as unknown as { message?: { content?: unknown } }).message?.content
        || JSON.stringify(ev).slice(0, 300);
      this.errorMsg = `Claude CLI: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}`;
      return;
    }

    if (ev.type === 'assistant' && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && typeof c.text === 'string') {
          this.currentTextBuffer += c.text;
        } else if (c.type === 'thinking') {
          const thinkingText = (c as unknown as { thinking?: string }).thinking;
          if (typeof thinkingText === 'string' && thinkingText) {
            onChunk?.({ type: 'thinking', content: thinkingText });
          }
        } else if (c.type === 'tool_use' && typeof c.name === 'string') {
          this.flushIntermediateAsThinking(onChunk);
          const bareName = stripMcpPrefix(c.name);
          this.usedTools.push(bareName);
          onChunk?.({ type: 'thinking', content: `[도구 호출: ${bareName}]` });
          const toolUseId = (c as unknown as { id?: string }).id;
          if (toolUseId) this.pendingToolUses.set(toolUseId, { name: bareName, input: c.input });
        }
      }
    }
    if (ev.type === 'user' && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_result') {
          this.flushIntermediateAsThinking(onChunk);
          const toolUseId = (c as unknown as { tool_use_id?: string }).tool_use_id;
          const pending = toolUseId ? this.pendingToolUses.get(toolUseId) : undefined;
          if (pending) {
            const rawContent = (c as unknown as { content?: unknown }).content;
            const textPayload = Array.isArray(rawContent)
              ? (rawContent[0] as { text?: string })?.text
              : typeof rawContent === 'string' ? rawContent : undefined;
            if (textPayload) {
              try {
                const payload = JSON.parse(textPayload) as Record<string, unknown>;
                if (payload.success) {
                  if (pending.name === 'render_iframe' && typeof payload.htmlContent === 'string') {
                    this.renderedBlocks.push({ type: 'html', htmlContent: payload.htmlContent, htmlHeight: payload.htmlHeight as string | undefined });
                  } else if (typeof payload.component === 'string') {
                    this.renderedBlocks.push({ type: 'component', name: payload.component, props: (payload.props as Record<string, unknown>) ?? {} });
                  } else if (RENDER_COMPONENT_MAP[pending.name]) {
                    this.renderedBlocks.push({ type: 'component', name: RENDER_COMPONENT_MAP[pending.name], props: (pending.input as Record<string, unknown>) ?? {} });
                  }
                  if (payload.pending === true && typeof payload.planId === 'string') {
                    this.pendingActions.push({
                      planId: payload.planId,
                      name: pending.name,
                      summary: typeof payload.summary === 'string' ? payload.summary : pending.name,
                      args: pending.input as Record<string, unknown> | undefined,
                      ...(payload.status === 'past-runat' ? { status: 'past-runat' as const } : {}),
                      ...(typeof payload.originalRunAt === 'string' ? { originalRunAt: payload.originalRunAt } : {}),
                    });
                  }
                  if ((pending.name === 'suggest' || pending.name === 'propose_plan') && Array.isArray(payload.suggestions)) {
                    for (const s of payload.suggestions) this.suggestions.push(s);
                  }
                }
              } catch { /* 파싱 실패 무시 */ }
            }
            this.pendingToolUses.delete(toolUseId!);
          }
        }
      }
    }
    if (ev.type === 'result') {
      if (ev.is_error) {
        this.errored = true;
        this.errorMsg = ev.result || '실행 오류';
      } else {
        this.finalText = this.currentTextBuffer;
        // thinking 으로 보내서 thinkingText 에만 쌓음 — 최종 content 는 RESULT.reply 로 결정
        // (cli-claude-code.ts 와 동일 이유: propose_plan turn 의 "flash → 비워짐" 방지)
        if (this.finalText) onChunk?.({ type: 'thinking', content: this.finalText });
      }
      this.complete = true;
    }
  }

  snapshot(): DaemonRunResult {
    return {
      text: this.finalText,
      sessionId: this.sessionId,
      usedTools: this.usedTools,
      renderedBlocks: this.renderedBlocks,
      pendingActions: this.pendingActions,
      suggestions: this.suggestions,
      ...(this.errored ? { error: this.errorMsg || 'Daemon 오류' } : {}),
    };
  }
}

export interface DaemonSpawnOptions {
  systemPrompt?: string;
  mcpConfigPath?: string;
  cliModel?: string;
  thinkingEffort?: string;
}

/** 한 대화에 대응하는 장시간 claude 서브프로세스 */
class ClaudeCodeDaemon {
  readonly key: string;
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private stdoutBuf = '';
  private stderrBuf = '';
  private currentState?: RequestState;
  private currentOnChunk?: (c: LlmChunk) => void;
  private currentResolve?: (r: DaemonRunResult) => void;
  private queue: Array<() => void> = [];
  private busy = false;
  private dead = false;
  private lastUsed = Date.now();
  /** 첫 send 여부 — 신규 spawn 된 데몬은 UI 의 prior history 를 모름. 첫 턴에 한해 호출자가 history 주입. */
  private firstSend = true;

  constructor(key: string, spawnOpts: DaemonSpawnOptions) {
    this.key = key;
    const args: string[] = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--allowed-tools', 'mcp__firebat__*',
      '--disallowed-tools', 'Agent,Task,TaskOutput,TaskStop,ToolSearch,SlashCommand,Bash,BashOutput,KillBash,KillShell,Read,Write,Edit,NotebookEdit,Glob,Grep,WebFetch,WebSearch,TodoWrite,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,Monitor,PushNotification,RemoteTrigger,ScheduleWakeup,Skill,AskUserQuestion,CronCreate,CronDelete,CronList,ListMcpResources,ReadMcpResource',
    ];
    if (spawnOpts.systemPrompt) args.push('--system-prompt', spawnOpts.systemPrompt);
    if (spawnOpts.mcpConfigPath) args.push('--mcp-config', spawnOpts.mcpConfigPath);
    if (spawnOpts.cliModel) args.push('--model', spawnOpts.cliModel);
    if (spawnOpts.thinkingEffort) args.push('--effort', spawnOpts.thinkingEffort);

    // PATH 보강 — pm2 가 시작될 때 nvm PATH 손실되는 환경 대응 (cron 발화 시 ENOENT 회피).
    // process.execPath = node binary 절대 경로 → 디렉토리 = nvm bin (claude symlink 박혀있음).
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    this.child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env }) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderrBuf += chunk.toString(); });
    this.child.on('error', (e) => this.onDeath(`프로세스 에러: ${e.message}`));
    this.child.on('close', (code) => this.onDeath(code === 0 ? 'closed' : `비정상 종료 (exit ${code}): ${this.stderrBuf.slice(0, 500)}`));
  }

  private onStdout(chunk: Buffer) {
    this.stdoutBuf += chunk.toString();
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      if (!this.currentState) continue;
      this.currentState.processLine(line, this.currentOnChunk);
      if (this.currentState.complete) {
        this.completeCurrent();
      }
    }
  }

  private completeCurrent() {
    const state = this.currentState;
    const resolve = this.currentResolve;
    this.currentState = undefined;
    this.currentOnChunk = undefined;
    this.currentResolve = undefined;
    this.busy = false;
    if (state && resolve) resolve(state.snapshot());
    // 큐의 다음 요청 처리
    const next = this.queue.shift();
    if (next) next();
  }

  private onDeath(reason: string) {
    if (this.dead) return;
    this.dead = true;
    const state = this.currentState;
    const resolve = this.currentResolve;
    this.currentState = undefined;
    this.currentOnChunk = undefined;
    this.currentResolve = undefined;
    this.busy = false;
    if (resolve) {
      const snap = state?.snapshot() ?? { text: '', usedTools: [], renderedBlocks: [], pendingActions: [], suggestions: [] };
      resolve({ ...snap, error: `Daemon ${reason}` });
    }
    // 큐의 나머지 요청들 에러로 해결
    for (const pending of this.queue) pending();
    this.queue = [];
  }

  isDead(): boolean { return this.dead; }
  getLastUsed(): number { return this.lastUsed; }
  /** 신규 spawn 여부 — 첫 send 에서만 true. 호출자가 history 주입 결정 시 참조. */
  isFirstSend(): boolean { return this.firstSend; }

  /** 1개 요청 전송 + 응답 대기. 동시 호출은 queue 로 직렬화. */
  async send(prompt: string, onChunk?: (c: LlmChunk) => void): Promise<DaemonRunResult> {
    this.lastUsed = Date.now();
    if (this.dead) {
      return { text: '', usedTools: [], renderedBlocks: [], pendingActions: [], suggestions: [], error: 'Daemon dead' };
    }
    return new Promise<DaemonRunResult>((resolve) => {
      const startRequest = () => {
        if (this.dead) {
          resolve({ text: '', usedTools: [], renderedBlocks: [], pendingActions: [], suggestions: [], error: 'Daemon dead' });
          return;
        }
        this.busy = true;
        this.firstSend = false; // 이후 send 는 warm
        this.currentState = new RequestState();
        this.currentOnChunk = onChunk;
        this.currentResolve = resolve;
        // stream-json 입력 포맷: user message 이벤트 1줄
        const userEvent = {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        };
        try {
          this.child.stdin.write(JSON.stringify(userEvent) + '\n');
        } catch (e) {
          this.onDeath(`stdin 쓰기 실패: ${(e as Error).message}`);
        }
      };
      if (this.busy) this.queue.push(startRequest);
      else startRequest();
    });
  }

  close(): void {
    if (this.dead) return;
    try { this.child.stdin.end(); } catch {}
    try { this.child.kill(); } catch {}
    this.onDeath('manually closed');
  }
}

/** 전역 데몬 매니저 — 대화 key 별 데몬 캐시 + LRU + idle cleanup */
class ClaudeDaemonManager {
  private daemons = new Map<string, ClaudeCodeDaemon>();
  private cleanupTimer?: NodeJS.Timeout;

  private startCleanupIfNeeded() {
    if (this.cleanupTimer || this.daemons.size === 0) return;
    this.cleanupTimer = setInterval(() => this.evictIdle(), 5 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  private evictIdle() {
    const now = Date.now();
    for (const [key, d] of this.daemons) {
      if (d.isDead() || now - d.getLastUsed() > IDLE_TIMEOUT_MS) {
        d.close();
        this.daemons.delete(key);
      }
    }
    if (this.daemons.size === 0 && this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private enforceLRU() {
    while (this.daemons.size > MAX_DAEMONS) {
      // Map 은 insertion 순서 유지 — 첫 번째(가장 오래된) 제거
      const oldestKey = this.daemons.keys().next().value;
      if (!oldestKey) break;
      const d = this.daemons.get(oldestKey);
      d?.close();
      this.daemons.delete(oldestKey);
    }
  }

  /** key = hash(conversationId + model + systemPrompt) — 구성 변경 시 새 데몬 */
  getOrCreate(key: string, spawnOpts: DaemonSpawnOptions): ClaudeCodeDaemon {
    let d = this.daemons.get(key);
    if (d && !d.isDead()) {
      // 재사용 시 Map 끝으로 이동 (LRU)
      this.daemons.delete(key);
      this.daemons.set(key, d);
      return d;
    }
    if (d) this.daemons.delete(key);
    d = new ClaudeCodeDaemon(key, spawnOpts);
    this.daemons.set(key, d);
    this.enforceLRU();
    this.startCleanupIfNeeded();
    return d;
  }

  invalidate(conversationId: string) {
    for (const [key, d] of this.daemons) {
      if (key.startsWith(conversationId + ':')) {
        d.close();
        this.daemons.delete(key);
      }
    }
  }

  closeAll() {
    for (const d of this.daemons.values()) d.close();
    this.daemons.clear();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

// 싱글톤 (프로세스 생애)
const g = globalThis as unknown as { __firebatClaudeDaemonMgr?: ClaudeDaemonManager };
if (!g.__firebatClaudeDaemonMgr) {
  g.__firebatClaudeDaemonMgr = new ClaudeDaemonManager();
  // 프로세스 종료 시 모든 데몬 정리
  const shutdown = () => { try { g.__firebatClaudeDaemonMgr?.closeAll(); } catch {} };
  process.on('exit', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
export const claudeDaemonManager = g.__firebatClaudeDaemonMgr!;

/** system prompt + MCP config 해시 — 구성 변경 감지용 (비암호학적, 빠른 FNV-1a) */
/**
 * systemPrompt 의 동적 라인 (매 turn 변동) strip — daemon hash 안정화.
 *
 * 기존 동작: hashSpawnConfig 가 systemPrompt 전체 hash → "현재 시각: 2026. 4. 30. 오후 2:13:25"
 * 의 시각이 1초만 변해도 hash 다름 → 매 turn cold spawn → 기억 상실.
 *
 * 동적 라인 패턴: prompt-builder.ts line 556 의 "현재 시각: ..." 는 매 호출 변동.
 * 다른 동적 라인 추가 시 여기 패턴 추가.
 */
function stripDynamicPromptLines(s: string): string {
  return s.replace(/현재 시각:[^\n]*/g, '현재 시각: <dynamic>');
}

export function hashSpawnConfig(systemPrompt?: string, mcpConfigPath?: string, cliModel?: string, thinkingEffort?: string): string {
  const stable = stripDynamicPromptLines(systemPrompt ?? '');
  const s = `${stable}|${mcpConfigPath ? fs.existsSync(mcpConfigPath) ? fs.readFileSync(mcpConfigPath, 'utf8') : mcpConfigPath : ''}|${cliModel ?? ''}|${thinkingEffort ?? ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** 데몬용 임시 mcp-config 파일 — 파일 경로가 바뀌면 해시도 바뀌어서 재spawn 유도 */
export function ensureDaemonMcpConfig(internalMcpToken?: string | null, baseUrl?: string): string {
  const configPath = path.join(os.tmpdir(), 'firebat-claude-daemon-mcp-config.json');
  const projectDir = process.cwd();
  let config: Record<string, unknown>;
  if (internalMcpToken) {
    const url = `${baseUrl || 'http://127.0.0.1:3000'}/api/mcp-internal`;
    config = {
      mcpServers: {
        firebat: { type: 'http', url, headers: { Authorization: `Bearer ${internalMcpToken}` } },
      },
    };
  } else {
    const stdioPath = path.join(projectDir, 'mcp', 'stdio-user-ai.ts');
    config = {
      mcpServers: { firebat: { command: 'npx', args: ['tsx', stdioPath], cwd: projectDir } },
    };
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

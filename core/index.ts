import { AiManager } from './managers/ai-manager';
import { StorageManager } from './managers/storage-manager';
import { PageManager } from './managers/page-manager';
import { ProjectManager } from './managers/project-manager';
import { TemplateManager, type TemplateConfig, type TemplateEntry } from './managers/template-manager';
import { ModuleManager } from './managers/module-manager';
import { ScheduleManager } from './managers/schedule-manager';
import { SecretManager } from './managers/secret-manager';
import { McpManager } from './managers/mcp-manager';
import { CapabilityManager } from './managers/capability-manager';
import { TaskManager } from './managers/task-manager';
import { AuthManager } from './managers/auth-manager';
import type { ApiTokenInfo } from './managers/auth-manager';
import { ConversationManager } from './managers/conversation-manager';
import { MediaManager } from './managers/media-manager';
import type { GenerateImageInput } from './managers/media-manager';
import { EventManager } from './managers/event-manager';
import { StatusManager } from './managers/status-manager';
import type { JobStatus, JobType, JobStatusKind, JobChangeEvent } from './managers/status-manager';
import { CostManager } from './managers/cost-manager';
import type { CostStatsFilter, CostStatsSummary } from './managers/cost-manager';
import { ToolManager } from './managers/tool-manager';
import type { ToolDefinition, ToolListFilter, ToolExecuteContext, ToolExecuteResult } from './managers/tool-manager';
import type { FirebatInfraContainer, LlmChunk, McpServerConfig, CronScheduleOptions, PipelineStep, AuthSession, ChatMessage, NetworkRequestOptions, NetworkResponse } from './ports';
import type { InfraResult } from './types';
import type { CapabilitySettings } from './capabilities';
import { VK_SYSTEM_TIMEZONE, VK_SYSTEM_AI_MODEL, VK_SYSTEM_AI_THINKING_LEVEL, VK_SYSTEM_USER_PROMPT, VK_SYSTEM_AI_ASSISTANT_MODEL, VK_SYSTEM_LAST_MODEL_BY_CATEGORY, VK_LLM_ANTHROPIC_CACHE, DEFAULT_AI_ASSISTANT_MODEL, AI_ASSISTANT_MODELS } from './vault-keys';
import { canonicalJson, unwrapJson, unwrapNestedPageSpec } from './utils/json-normalize';
import { captureException as _captureException } from './utils/error-capture';
import type { ErrorContext } from './utils/error-capture';

/** AI 요청 옵션 — 요청별 모델/이미지/멀티턴 컨텍스트 지정 */
export interface AiRequestOpts {
  model?: string;
  /** thinking/reasoning 강도 override (none/minimal/low/medium/high/xhigh/max) */
  thinkingLevel?: string;
  /** 현재 프롬프트에 첨부된 이미지 (Base64 data URL) */
  image?: string;
  /** 이전 응답 ID (OpenAI Responses API multi-turn state) */
  previousResponseId?: string;
  /** 현재 활성 대화 ID — search_history 도구에 전달, 현재 대화 우선 부스트용 */
  conversationId?: string;
  /** 대화 소유자 — search_history 실행 시 owner 스코프 */
  owner?: string;
  /** 플랜모드 — 3단계 토글:
   *   - 'off' (또는 false): AI 자유 판단, plan 강제 X
   *   - 'auto': AI 자율 판단으로 destructive·복합 작업만 propose_plan, 단순 작업은 즉시
   *   - 'always' (또는 true): 모든 요청에 propose_plan 강제 (인사·단답 포함)
   *  레거시 boolean 호환: true → 'always', false → 'off' */
  planMode?: 'off' | 'auto' | 'always' | boolean;
  /** 사용자가 직전 turn 의 propose_plan 카드에서 ✓실행 클릭 시 동봉되는 planId.
   *  AiManager 가 plan-store 에서 steps 조회 후 시스템 프롬프트에 강제 주입. */
  planExecuteId?: string;
  /** 사용자가 ⚙수정 제안 input 에 피드백 입력 시 동봉되는 planId.
   *  AiManager 가 직전 plan + 사용자 피드백 → propose_plan 재호출 강제. */
  planReviseId?: string;
  /** cron agent 모드 트리거 표시 — system prompt 에 cron 컨텍스트 주입 +
   *  schedule_task / propose_plan 등 메타 도구 차단 + 승인 게이트 우회 (save_page 즉시 발행). */
  cronAgent?: { jobId: string; title?: string };
}

/**
 * Firebat Core Facade (진입점) — 싱글톤
 *
 * 모든 비즈니스 로직의 유일한 오케스트레이터.
 * 내부 매니저에게 위임하고, SSE 이벤트를 일괄 관리한다.
 * app/api/ 라우트는 Core 메서드만 호출하고, 포트를 직접 사용하지 않는다.
 */
export class FirebatCore {
  private readonly ai: AiManager;
  private readonly storage: StorageManager;
  private readonly page: PageManager;
  private readonly project: ProjectManager;
  private readonly template: TemplateManager;
  private readonly module: ModuleManager;
  private readonly schedule: ScheduleManager;
  private readonly secret: SecretManager;
  private readonly mcp: McpManager;
  private readonly capability: CapabilityManager;
  private readonly task: TaskManager;
  private readonly authMgr: AuthManager;
  private readonly conversation: ConversationManager;
  private readonly media: MediaManager;
  private readonly event: EventManager;
  private readonly statusMgr: StatusManager;
  private readonly cost: CostManager;
  private readonly tool: ToolManager;

  constructor(private readonly infra: FirebatInfraContainer) {
    // 매니저 생성 — 각 매니저는 자기 도메인의 인프라 포트를 직접 받음
    this.storage = new StorageManager(infra.storage);
    this.page = new PageManager(infra.database, infra.storage);
    this.project = new ProjectManager(infra.storage, infra.database, infra.vault);
    this.template = new TemplateManager(infra.storage);
    this.module = new ModuleManager(infra.sandbox, infra.storage, infra.vault);
    this.secret = new SecretManager(infra.vault, infra.storage);
    this.mcp = new McpManager(infra.mcpClient);
    this.capability = new CapabilityManager(infra.storage, infra.vault, infra.log);
    this.authMgr = new AuthManager(infra.auth, infra.vault);
    this.conversation = new ConversationManager(infra.database, infra.embedder);
    this.media = new MediaManager(infra.imageGen, infra.media, infra.imageProcessor, infra.vault, infra.log);
    this.event = new EventManager(infra.log);
    this.statusMgr = new StatusManager(infra.log, this.event);

    // StatusManager error → 자동 captureException forward.
    // 일반 메커니즘 — 어떤 도메인 (이미지·cron·pipeline 등) 에서 statusMgr.error 호출되든
    // 자동으로 jsonl 누적 + (severity critical 일 때) Telegram 발송. 도메인별 enumerate X.
    this.statusMgr.subscribe((evt) => {
      if (evt.change !== 'failed') return;
      const job = evt.job;
      // severity 자동 결정 — cron·image 같은 사용자 가시 작업은 critical (Telegram), 나머지는 error.
      const severity: ErrorContext['severity'] = (job.type === 'cron' || job.type === 'image') ? 'critical' : 'error';
      void _captureException(this, new Error(job.error || 'job failed'), {
        source: `statusMgr:${job.type}`,
        identifier: job.id,
        meta: { jobMessage: job.message, parentJobId: job.parentJobId, ...(job.meta ?? {}) },
        severity,
      }).catch(() => { /* 에러 캡처 자체 실패는 silent — recursion 방지 */ });
    });

    // CostManager — LLM 호출 token·비용 누적. 가격 정보는 ILlmPort.getModelPricing 에서 lookup (미구현 어댑터는 null).
    // 일자 키는 사용자 timezone 기준 ISO YYYY-MM-DD.
    this.cost = new CostManager(
      infra.vault,
      infra.log,
      (model) => infra.llm.getModelPricing?.(model) ?? null,
      () => {
        const tz = this.getTimezone();
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date()); // en-CA → 'YYYY-MM-DD'
      },
    );
    // ToolManager — 도구 등록·dispatch 단일 source. Step 2~ 에서 정적·동적 도구 등록.
    this.tool = new ToolManager(infra.log);

    // 크로스 도메인 매니저 — Core 참조 필요
    this.task = new TaskManager(this, infra.llm, infra.log);
    this.schedule = new ScheduleManager(this, infra.cron, infra.log);
    this.ai = new AiManager(this, infra.llm, infra.log, infra.database, infra.toolRouter);

    // 공유 대화 만료 자동 정리 — 1시간마다 expired 삭제. unref 로 프로세스 종료 방해 안 함.
    const shareCleanupInterval = setInterval(() => {
      this.cleanupExpiredShares().then(r => {
        if (r.success && r.data && r.data.deleted > 0) {
          this.infra.log.info(`[Share] 만료 공유 ${r.data.deleted}개 정리`);
        }
      }).catch(() => {});
    }, 60 * 60_000);
    shareCleanupInterval.unref?.();

    // 만료 세션 sweep — 6시간마다. listSessions 가 만료된 세션 자동 삭제.
    // getSession 도 lazy 정리 하지만 호출 안 된 토큰은 Vault 에 남아 디스크 누적 가능.
    const sessionSweepInterval = setInterval(() => {
      try { this.authMgr.sweepExpiredSessions(); }
      catch (e) { this.infra.log.debug(`[Core] session sweep 실패 (silent): ${e instanceof Error ? e.message : String(e)}`); }
    }, 6 * 60 * 60_000);
    sessionSweepInterval.unref?.();
  }

  /**
   * Graceful shutdown — SIGTERM / 프로세스 종료 시 호출.
   *
   * 1) CostManager dirty 즉시 flush — 통계 손실 방지.
   * 2) 활성 status 작업 (running) 이 있으면 최대 timeoutMs 까지 대기.
   *    그 안에 끝나면 정상 종료, 안 끝나면 critical section 으로 간주하고 'error' 마크.
   * 3) StatusManager / CostManager GC 타이머 정리.
   *
   * BIBLE: 매니저 직접 호출 X — Core facade 가 매니저 정리 메서드 호출.
   * 일반 로직 — 특정 작업 분류별 분기 X. running 이면 동등하게 대기·강제 종료.
   */
  async gracefulShutdown(timeoutMs: number = 25_000): Promise<void> {
    this.infra.log.info('[Core] gracefulShutdown 시작');
    // 1) Cost flush — Vault 쓰기 동기 (await)
    try { await this.cost.flushNow(); } catch (err) {
      this.infra.log.warn(`[Core] cost flush 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 2) 활성 작업 대기 — 1초 폴링
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const running = this.statusMgr.list({ status: 'running' });
      if (running.length === 0) break;
      this.infra.log.info(`[Core] ${running.length}개 활성 작업 대기 중 (남은 ${Math.ceil((deadline - Date.now()) / 1000)}초)`);
      await new Promise(r => setTimeout(r, 1000));
    }
    // 3) timeout 후에도 남은 작업은 'error' 마크 — restart 후 재실행 결정용
    const stillRunning = this.statusMgr.list({ status: 'running' });
    for (const job of stillRunning) {
      this.statusMgr.error(job.id, 'shutdown timeout — 재시작 시 복구 검토');
    }
    if (stillRunning.length > 0) {
      this.infra.log.warn(`[Core] ${stillRunning.length}개 작업 timeout 으로 error 마크`);
    }
    // 4) GC 타이머 정리
    try { this.statusMgr.shutdown(); } catch {}
    try { (this.cost as { shutdown?: () => void }).shutdown?.(); } catch {}
    this.infra.log.info('[Core] gracefulShutdown 완료');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  AI 채팅 → AiManager
  // ══════════════════════════════════════════════════════════════════════════

  async requestActionWithTools(
    prompt: string,
    history: ChatMessage[] = [],
    opts?: AiRequestOpts,
    onToolCall?: (info: { name: string; status: 'start' | 'done' | 'error'; error?: string }) => void,
    onChunk?: (chunk: LlmChunk) => void,
  ) {
    return this.ai.processWithTools(prompt, history, opts, onToolCall, onChunk);
  }

  /** Sub-agent 단일 spawn — 메인 AI 가 spawn_subagent 도구 호출 시 진입. 빈 history (격리).
   *  자체 도구 사용 가능 (단 spawn_subagent 자기 호출 무한재귀 방지는 도구 schema 에서 — 본 메서드는 prompt 만 전달).
   *  결과는 메인 turn 의 도구 결과로 반환. 메인 conversation context 안 더럽힘.
   *  Vault 토글 (system:llm:sub-agent-enabled) 검사는 도구 schema 노출 단계에서 처리 — 본 메서드는 호출 시 무조건 실행. */
  async spawnSubAgent(prompt: string, opts?: { model?: string; taskType?: string }): Promise<{
    success: boolean;
    reply?: string;
    executedActions?: string[];
    error?: string;
  }> {
    if (!prompt || !prompt.trim()) {
      return { success: false, error: 'prompt 비어있음' };
    }
    try {
      const res = await this.ai.processWithTools(
        prompt,
        [], // 빈 history — sub-agent 는 독립 conversation context
        {
          owner: 'admin',
          ...(opts?.model ? { model: opts.model } : {}),
        },
      );
      if (!res.success) {
        return { success: false, error: res.error || 'sub-agent 실행 실패', executedActions: res.executedActions };
      }
      return {
        success: true,
        reply: res.reply,
        executedActions: res.executedActions,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  }

  /** Sub-agent 토글 — Vault `system:llm:sub-agent-enabled` (default false). API 비용 폭탄 방지 안전망. */
  isSubAgentEnabled(): boolean {
    return this.infra.vault.getSecret('system:llm:sub-agent-enabled') === 'true';
  }

  setSubAgentEnabled(enabled: boolean): void {
    this.infra.vault.setSecret('system:llm:sub-agent-enabled', enabled ? 'true' : 'false');
  }

  async codeAssist(params: { code: string; language: string; instruction: string; selectedCode?: string }, opts?: AiRequestOpts) {
    return this.ai.codeAssist(params, opts);
  }

  /** Cron agent 모드 트리거 — server-side Function Calling 한 사이클 실행.
   *  agentPrompt 를 user message 로 AI 에 전달, 풀 도구 사용 (schedule_task / propose_plan 제외),
   *  승인 게이트 우회 (save_page 즉시 발행). 결과: {reply, executedActions, blocks, error?}.
   *  ScheduleManager.handleTrigger 가 호출, 결과를 CronJobResult 로 변환해 cron-logs 에 기록. */
  async runAgentJob(jobId: string, agentPrompt: string, title?: string): Promise<{
    success: boolean;
    reply?: string;
    executedActions?: string[];
    blocks?: unknown[];
    error?: string;
  }> {
    if (!agentPrompt || !agentPrompt.trim()) {
      return { success: false, error: 'agentPrompt 가 비어있습니다.' };
    }
    // cron agent 컨텍스트 globalThis 에 set — MCP 서버 핸들러 (save_page 등) 가 이 flag 보고
    // createPending 우회하고 직접 DB write. 동시 cron 발화 race 는 단순 jobId 기반으로 인정.
    const g = globalThis as Record<string, unknown>;
    g['__firebatCronAgentJobId'] = jobId;
    try {
      // 사용자가 어드민에서 설정한 User AI 모델 사용 — 미설정 시 LlmRouter 의 default fallback.
      // 이 줄 없으면 DEFAULT_MODEL (gpt-5.4-mini) 로 떨어져 인증 안 된 OpenAI 호출 → 실패.
      const userModel = this.getAiModel();
      const res = await this.ai.processWithTools(
        agentPrompt,
        [], // 빈 history — cron 잡은 독립 실행, 어드민 채팅 컨텍스트 X
        {
          cronAgent: { jobId, title },
          owner: 'admin',
          ...(userModel ? { model: userModel } : {}),
        },
      );
      if (!res.success) {
        return { success: false, error: res.error || 'agent 실행 실패', executedActions: res.executedActions };
      }
      const data = res.data as { blocks?: unknown[] } | undefined;
      return {
        success: true,
        reply: res.reply,
        executedActions: res.executedActions,
        blocks: data?.blocks,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    } finally {
      // cron agent context 해제 — admin chat 의 후속 save_page 가 영향 받지 않게.
      const g = globalThis as Record<string, unknown>;
      if (g['__firebatCronAgentJobId'] === jobId) delete g['__firebatCronAgentJobId'];
    }
  }

  /** AI/pipeline 이 호출한 identifier (서버명·모듈명·sysmod_*·full path) → 실제 dispatch target.
   *  매니저 간 직접 호출 금지 원칙 — TaskManager 가 ai 매니저의 resolver 쓸 때 이 facade 경유. */
  async resolveCallTarget(identifier: string) {
    return this.ai.resolveCallTarget(identifier);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  파일 시스템 → StorageManager + SSE
  // ══════════════════════════════════════════════════════════════════════════

  async readFile(path: string) {
    return this.storage.read(path);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Firebat 자율 메모리 — data/firebat-memory/ 디렉토리. 사용자 룰·선호·도메인
  // 컨텍스트 영속 저장. AI 가 자율 호출. 매 turn prompt-builder 가 index.md 자동 prepend.
  // ══════════════════════════════════════════════════════════════════════════

  /** 메모리 인덱스 read — index.md (없으면 빈 string). 매 turn prompt-builder 가 호출. */
  async getMemoryIndex(): Promise<string> {
    const res = await this.storage.read('data/firebat-memory/index.md');
    return res.success && res.data ? res.data : '';
  }

  /** 메모리 본문 read — name 으로 파일 찾음 (4 카테고리 prefix 자동 시도). */
  async readMemoryFile(name: string): Promise<InfraResult<string>> {
    for (const cat of ['user', 'feedback', 'project', 'reference']) {
      const res = await this.storage.read(`data/firebat-memory/${cat}_${name}.md`);
      if (res.success && res.data) return { success: true, data: res.data };
    }
    return { success: false, error: `메모리 없음: ${name}` };
  }

  /** 메모리 저장 — 본문 + 인덱스 자동 갱신. */
  async saveMemoryFile(category: 'user' | 'feedback' | 'project' | 'reference', name: string, description: string, content: string): Promise<InfraResult<void>> {
    const filename = `${category}_${name}.md`;
    const filepath = `data/firebat-memory/${filename}`;
    // 본문 저장
    const body = `---\nname: ${name}\ndescription: ${description}\ncategory: ${category}\n---\n\n${content}\n`;
    const writeRes = await this.storage.write(filepath, body);
    if (!writeRes.success) return { success: false, error: writeRes.error };
    // 인덱스 갱신
    await this.refreshMemoryIndex();
    return { success: true };
  }

  /** 메모리 삭제 — 본문 + 인덱스 갱신. */
  async deleteMemoryFile(name: string): Promise<InfraResult<void>> {
    let deleted = false;
    for (const cat of ['user', 'feedback', 'project', 'reference']) {
      const res = await this.storage.delete(`data/firebat-memory/${cat}_${name}.md`);
      if (res.success) { deleted = true; break; }
    }
    if (!deleted) return { success: false, error: `메모리 없음: ${name}` };
    await this.refreshMemoryIndex();
    return { success: true };
  }

  /** 인덱스 자동 재생성 — 디렉토리 listing 후 각 파일 frontmatter 읽어서 인덱스 작성. */
  private async refreshMemoryIndex(): Promise<void> {
    const list = await this.storage.listDir('data/firebat-memory');
    if (!list.success || !list.data) return;
    const entries: Array<{ category: string; name: string; description: string }> = [];
    for (const e of list.data) {
      if (e.isDirectory || !e.name.endsWith('.md') || e.name === 'index.md') continue;
      const res = await this.storage.read(`data/firebat-memory/${e.name}`);
      if (!res.success || !res.data) continue;
      // frontmatter 파싱
      const fm = res.data.match(/^---\nname:\s*(.+)\ndescription:\s*(.+)\ncategory:\s*(.+)\n---/m);
      if (fm) entries.push({ name: fm[1].trim(), description: fm[2].trim(), category: fm[3].trim() });
    }
    // 카테고리별 그룹화
    const byCategory: Record<string, typeof entries> = { user: [], feedback: [], project: [], reference: [] };
    for (const e of entries) {
      if (byCategory[e.category]) byCategory[e.category].push(e);
    }
    const labels: Record<string, string> = {
      user: '사용자 (User)',
      feedback: '행동 룰 (Feedback)',
      project: '프로젝트 컨텍스트 (Project)',
      reference: '외부 참조 (Reference)',
    };
    let md = '# Firebat AI Memory Index\n\n';
    md += '> 매 대화 시작 시 자동 로드. 본문은 `memory_read(name)` 으로 필요 시 read.\n\n';
    for (const cat of ['user', 'feedback', 'project', 'reference']) {
      if (byCategory[cat].length === 0) continue;
      md += `## ${labels[cat]}\n`;
      for (const e of byCategory[cat]) {
        md += `- **${e.name}** — ${e.description}\n`;
      }
      md += '\n';
    }
    if (entries.length === 0) {
      md += '_아직 저장된 메모리 없음. AI 가 사용자 룰·선호 발견 시 memory_save 자동 호출._\n';
    }
    await this.storage.write('data/firebat-memory/index.md', md);
  }

  /** 바이너리 파일 읽기 — base64 로 반환 (read_image MCP 도구용) */
  async readFileBinary(path: string): Promise<InfraResult<{ base64: string; mimeType: string; size: number }>> {
    return this.storage.readBinary(path);
  }

  async writeFile(path: string, content: string) {
    const res = await this.storage.write(path, content);
    if (res.success) {
      this.event.notifySidebar();
      // 모듈 config.json 변경 시 AI 캐시 무효화
      if (path.endsWith('/config.json') && (path.includes('modules/') || path.includes('services/'))) {
        this.ai.invalidateCache();
      }
    }
    return res;
  }

  async deleteFile(path: string) {
    const res = await this.storage.delete(path);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  async listDir(path: string) {
    return this.storage.listDir(path);
  }

  async listFiles(path: string) {
    return this.storage.list(path);
  }

  async getFileTree(root: string) {
    return this.storage.getFileTree(root);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  페이지 → PageManager + SSE
  // ══════════════════════════════════════════════════════════════════════════

  async listPages() { return this.page.list(); }
  async getPage(slug: string) { return this.page.get(slug); }

  /** spec 은 string (JSON) 이든 object 든 받음 — Core facade 에서 canonical JSON 으로 정규화.
   *  호출자 (API / MCP / ai-manager) 는 타입 신경 쓸 필요 없음. 이중 인코딩 원천 차단.
   *
   *  allowOverwrite=false (기본) 시 slug 충돌이면 -2, -3 접미사 자동 할당 → 기존 페이지 보존.
   *  allowOverwrite=true 시 덮어쓰기 — AI 가 사용자의 명시적 "수정" 요청을 처리할 때만 true. */
  async savePage(slug: string, spec: string | Record<string, unknown>, opts?: { allowOverwrite?: boolean }): Promise<InfraResult<{ slug: string; renamed?: boolean }>> {
    // 1. 외부 입력 정규화 — string 이면 parse, 객체면 그대로
    let specObj: unknown;
    try { specObj = unwrapJson(spec); }
    catch (e: any) { return { success: false, error: `spec JSON 파싱 실패: ${e.message}` }; }
    // 2. 중첩 PageSpec 자동 평탄화 — AI 가 PageSpec 을 stringify 후 외부 body[0].content 에 박은 케이스
    specObj = unwrapNestedPageSpec(specObj);
    const specStr = canonicalJson(specObj);
    let finalSlug = slug;
    let renamed = false;
    if (!opts?.allowOverwrite) {
      // 기존 slug 존재 여부 확인 → 있으면 `-2`, `-3` ... 자동 증가
      const existing = await this.page.get(slug);
      if (existing.success) {
        for (let i = 2; i <= 100; i++) {
          const candidate = `${slug}-${i}`;
          const check = await this.page.get(candidate);
          if (!check.success) { finalSlug = candidate; renamed = true; break; }
        }
        if (!renamed) return { success: false, error: `slug 할당 실패 (${slug}-2 ~ ${slug}-100 모두 사용 중)` };
      }
    }
    // spec 의 slug 필드도 수정 (canonical JSON 재생성)
    if (finalSlug !== slug) {
      try {
        const parsed = JSON.parse(specStr);
        parsed.slug = finalSlug;
        const res = await this.page.save(finalSlug, JSON.stringify(parsed));
        if (res.success) this.event.notifySidebar();
        return res.success ? { success: true, data: { slug: finalSlug, renamed: true } } : { success: false, error: res.error };
      } catch (err: any) {
        return { success: false, error: `spec slug 갱신 실패: ${err.message}` };
      }
    }
    const res = await this.page.save(finalSlug, specStr);
    if (res.success) this.event.notifySidebar();
    return res.success ? { success: true, data: { slug: finalSlug, renamed: false } } : { success: false, error: res.error };
  }

  async deletePage(slug: string) {
    const res = await this.page.delete(slug);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  async renamePage(oldSlug: string, newSlug: string, opts?: { setRedirect?: boolean }) {
    const res = await this.page.rename(oldSlug, newSlug, opts ?? {});
    if (res.success) this.event.notifySidebar();
    return res;
  }

  async renameProject(oldName: string, newName: string, opts?: { setRedirect?: boolean }) {
    const res = await this.page.renameProject(oldName, newName, opts ?? {});
    if (res.success) this.event.notifySidebar();
    return res;
  }

  /** from_slug → to_slug 리디렉트 — (user)/[...slug]/page.tsx 에서 사용 */
  async getPageRedirect(fromSlug: string) { return this.page.getRedirect(fromSlug); }

  async listStaticPages() { return this.page.listStatic(); }

  /** 미디어 slug 의 사용처 — 갤러리 삭제 confirm·메타 표시에 사용.
   *  PageManager.save 시 자동 인덱스 갱신, delete 시 자동 정리. */
  async findMediaUsage(mediaSlug: string) { return this.page.findMediaUsage(mediaSlug); }

  /** 페이지 visibility 설정 */
  async setPageVisibility(slug: string, visibility: 'public' | 'password' | 'private', password?: string) {
    const res = await this.page.setVisibility(slug, visibility, password);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  /** 페이지 비밀번호 검증 */
  async verifyPagePassword(slug: string, password: string) {
    return this.page.verifyPassword(slug, password);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  프로젝트 → ProjectManager + SSE
  // ══════════════════════════════════════════════════════════════════════════

  async scanProjects() { return this.project.scan(); }

  /** 프로젝트 visibility 설정 */
  setProjectVisibility(project: string, visibility: 'public' | 'password' | 'private', password?: string) {
    this.project.setVisibility(project, visibility, password);
    this.event.notifySidebar();
    return { success: true };
  }

  /** 프로젝트 visibility 조회 */
  getProjectVisibility(project: string) {
    return this.project.getVisibility(project);
  }

  /** 프로젝트 설정 조회 — `user/projects/{name}/config.json` 의 theme override / customCss 등.
   *  CMS Phase 3 — 프로젝트별 디자인 override. 페이지 spec.project 매칭 시 적용. */
  async getProjectConfig(project: string) {
    return this.project.getProjectConfig(project);
  }

  /** 프로젝트 설정 저장 — config.json upsert. 어드민 UI 에서 호출. */
  async setProjectConfig(project: string, config: Record<string, unknown>) {
    return this.project.setProjectConfig(project, config);
  }

  // ── 태그 (CMS Phase 8a) ─────────────────────────────────────────────────
  /** 모든 published + public 페이지의 head.keywords 합집합 + 사용 빈도.
   *  CMS settings.tagAliases 적용 — case-insensitive normalize 후 aggregation.
   *  반환: [{ tag, count, slugs }] — count 내림차순. tag 는 canonical (alias 통합). */
  async listAllTags(): Promise<Array<{ tag: string; count: number; slugs: string[] }>> {
    const { normalizeTag } = await import('../lib/tag-utils');
    const aliases = this.getCmsSettings().tagAliases;
    const listRes = await this.listPages();
    if (!listRes.success || !listRes.data) return [];
    const visiblePages = listRes.data.filter(
      (p) => p.status === 'published' && (p.visibility ?? 'public') === 'public',
    );
    const tagMap = new Map<string, Set<string>>();
    for (const p of visiblePages) {
      const pageRes = await this.getPage(p.slug);
      if (!pageRes.success || !pageRes.data) continue;
      const keywords = (pageRes.data.head?.keywords ?? []) as unknown[];
      for (const kw of keywords) {
        if (typeof kw !== 'string') continue;
        const canonical = normalizeTag(kw, aliases);
        if (!canonical) continue;
        if (!tagMap.has(canonical)) tagMap.set(canonical, new Set());
        tagMap.get(canonical)!.add(p.slug);
      }
    }
    return [...tagMap.entries()]
      .map(([tag, slugSet]) => ({ tag, count: slugSet.size, slugs: [...slugSet] }))
      .sort((a, b) => b.count - a.count);
  }

  // ── 템플릿 (CMS Phase 8b) ───────────────────────────────────────────────
  /** 템플릿 목록 — user/templates 폴더 스캔. */
  async listTemplates(): Promise<TemplateEntry[]> {
    return this.template.list();
  }
  /** 템플릿 단건 조회 — config 객체 또는 null. */
  async getTemplate(slug: string): Promise<TemplateConfig | null> {
    return this.template.get(slug);
  }
  /** 템플릿 저장 — upsert. */
  async saveTemplate(slug: string, config: TemplateConfig) {
    return this.template.save(slug, config);
  }
  /** 템플릿 삭제. */
  async deleteTemplate(slug: string) {
    return this.template.delete(slug);
  }

  /** 프로젝트 비밀번호 검증 */
  verifyProjectPassword(project: string, password: string) {
    return this.project.verifyPassword(project, password);
  }

  async deleteProject(project: string) {
    const res = await this.project.delete(project);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  모듈 → ModuleManager
  // ══════════════════════════════════════════════════════════════════════════

  async runModule(moduleName: string, inputData: Record<string, unknown>) {
    return this.module.run(moduleName, inputData);
  }

  /** 경로 지정 직접 실행 (EXECUTE, 파이프라인 등).
   *  opts.onProgress: 모듈 stdout 의 `[STATUS] {progress?, message?, meta?}` 라인 파싱 콜백.
   *  Caller (Pipeline step·cron 등) 가 StatusManager 와 연결 가능.
   *  사용자 timezone (TZ + FIREBAT_TZ) 자동 주입 — sysmod 의 today()/daysAgo() 가 KST 기준 동작.
   *  caller 가 opts.extraEnv 명시하면 그 위에 timezone 추가 (caller 우선 X — timezone 은 Core 정책). */
  async sandboxExecute(targetPath: string, inputData: Record<string, unknown>, opts?: import('./ports').SandboxExecuteOpts) {
    const tz = this.getTimezone();
    return this.module.execute(targetPath, inputData, {
      ...opts,
      extraEnv: { ...(opts?.extraEnv ?? {}), TZ: tz, FIREBAT_TZ: tz },
    });
  }

  async getSystemModules() { return this.module.listSystem(); }
  /** 유저 모듈 목록 (user/modules/) — 외부 IDE MCP introspection. */
  async getUserModules() { return this.module.listUserModules(); }
  /** 모듈 config.json 파싱 응답 — sysmod / user 모듈 schema 직접 조회 (외부 MCP introspection 용). */
  async getModuleSchema(scope: 'system' | 'user', name: string) { return this.module.getModuleConfig(scope, name); }
  getModuleSettings(moduleName: string) { return this.module.getSettings(moduleName); }
  async getModuleConfig(moduleName: string) { return this.module.getConfig(moduleName); }
  setModuleSettings(moduleName: string, settings: Record<string, any>) { return this.module.setSettings(moduleName, settings); }
  isModuleEnabled(moduleName: string) { return this.module.isEnabled(moduleName); }
  setModuleEnabled(moduleName: string, enabled: boolean) { this.ai.invalidateCache(); return this.module.setEnabled(moduleName, enabled); }
  /** CMS 설정 조회 — 사이트 메타·테마·레이아웃·SEO·OG 통합. SEO 모듈에서 CMS 로 확장 (2026-04-28). */
  getCmsSettings() { return this.module.getCmsSettings(); }
  /** @deprecated 2026-04-28 — `getCmsSettings()` 사용. 호출처 점진 마이그레이션 위한 alias. */
  getSeoSettings() { return this.module.getCmsSettings(); }

  // ══════════════════════════════════════════════════════════════════════════
  //  태스크 → TaskManager (파이프라인 즉시 실행)
  // ══════════════════════════════════════════════════════════════════════════

  /** 파이프라인 즉시 실행 (RUN_TASK 액션).
   *  StatusManager 와 통합 — 각 step start/done 마다 진행도·메시지 갱신.
   *  parentJobId 옵션: 상위 job (예: cron 트리거) 이 있으면 sub-task 로 등록 → UI hierarchy. */
  async runTask(
    pipeline: PipelineStep[],
    onPipelineStep?: (index: number, status: 'start' | 'done' | 'error', error?: string) => void,
    opts?: { parentJobId?: string },
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const total = pipeline.length;
    const job = this.statusMgr.start({
      type: 'pipeline',
      message: `파이프라인 시작 (${total} steps)`,
      meta: { totalSteps: total },
      ...(opts?.parentJobId ? { parentJobId: opts.parentJobId } : {}),
    });
    // step detail summary — TaskManager.executePipeline 내부와 같은 형식 (UI 일관)
    const stepDetail = (step: PipelineStep): string => {
      switch (step.type) {
        case 'EXECUTE': return step.path ?? '';
        case 'MCP_CALL': return `${step.server ?? ''}/${step.tool ?? ''}`;
        case 'NETWORK_REQUEST': return step.url ?? '';
        case 'LLM_TRANSFORM': return step.instruction?.slice(0, 60) ?? '';
        case 'CONDITION': return `${step.field ?? ''} ${step.op ?? ''} ${String(step.value ?? '')}`.trim();
        case 'SAVE_PAGE': return String(step.slug ?? step.inputMap?.slug ?? '');
        default: return '';
      }
    };
    const wrappedCallback = (
      idx: number,
      status: 'start' | 'done' | 'error' | 'progress',
      error?: string,
      subUpdate?: { progress?: number; message?: string },
    ) => {
      const step = pipeline[idx];
      const detail = stepDetail(step);
      if (status === 'start') {
        this.statusMgr.update(job.id, {
          progress: total > 0 ? idx / total : 0,
          message: `Step ${idx + 1}/${total}: ${step.type}${detail ? ` → ${detail}` : ''}`,
        });
      } else if (status === 'progress' && subUpdate) {
        // 모듈 stdout [STATUS] 진행도를 step 수준 progress 에 반영.
        // 일반 로직 — sub.progress (0~1) 를 step idx 안의 비율로 환산해 전체 progress 갱신.
        const stepBase = total > 0 ? idx / total : 0;
        const stepWidth = total > 0 ? 1 / total : 0;
        const subProgress = typeof subUpdate.progress === 'number'
          ? Math.max(0, Math.min(1, subUpdate.progress))
          : undefined;
        this.statusMgr.update(job.id, {
          ...(typeof subProgress === 'number' ? { progress: stepBase + stepWidth * subProgress } : {}),
          ...(subUpdate.message ? { message: `Step ${idx + 1}/${total}: ${subUpdate.message}` } : {}),
        });
      } else if (status === 'done') {
        this.statusMgr.update(job.id, {
          progress: total > 0 ? (idx + 1) / total : 1,
          message: `Step ${idx + 1}/${total} 완료`,
        });
      } else if (status === 'error') {
        // 종료는 아래 res.success 분기에서 처리. 여기선 메시지 갱신만.
        this.statusMgr.update(job.id, {
          message: `Step ${idx + 1}/${total} 실패: ${error ?? 'unknown'}`,
        });
      }
      // 외부 caller 는 기존 시그니처 ('start' | 'done' | 'error') 만 받음 — 'progress' 는 status 내부 전용
      if (status !== 'progress') {
        onPipelineStep?.(idx, status, error);
      }
    };
    const res = await this.task.executePipeline(pipeline, wrappedCallback);
    if (res.success) {
      this.statusMgr.done(job.id, res.data);
    } else {
      this.statusMgr.error(job.id, res.error || '파이프라인 실패');
    }
    return res;
  }

  /** 파이프라인 검증 (ScheduleManager에서도 사용) */
  validatePipeline(pipeline: PipelineStep[]): string | null {
    return this.task.validatePipeline(pipeline);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  스케줄링 → ScheduleManager + SSE
  // ══════════════════════════════════════════════════════════════════════════

  async scheduleCronJob(jobId: string, targetPath: string, opts: CronScheduleOptions) {
    const res = await this.schedule.schedule(jobId, targetPath, opts);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  async cancelCronJob(jobId: string) {
    const res = await this.schedule.cancel(jobId);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  async updateCronJob(jobId: string, targetPath: string, opts: CronScheduleOptions) {
    const res = await this.schedule.update(jobId, targetPath, opts);
    if (res.success) this.event.notifySidebar();
    return res;
  }

  listCronJobs() { return this.schedule.list(); }
  getCronLogs(limit?: number) { return this.schedule.getLogs(limit); }
  clearCronLogs() { this.schedule.clearLogs(); }
  consumeCronNotifications() { return this.schedule.consumeNotifications(); }

  /** 기존 cron 잡을 즉시 1회 트리거 — infra/cron 의 triggerNow 경유.
   *  fireTrigger 가 cron-logs 기록 + triggerCallback (= handleCronTrigger) 호출 →
   *  정상 cron 발화와 완전히 동일한 흐름 (로그·SSE·StatusManager 모두 정상). */
  async runCronJobNow(jobId: string): Promise<InfraResult<void>> {
    return this.infra.cron.triggerNow(jobId);
  }

  /** Cron 비동기 트리거 콜백 — 시각 도달 시 cron 어댑터가 호출.
   *  Manager 직접 호출 안 하고 Core facade 경유 → SSE emit 단일 지점 (BIBLE 일관성).
   *  StatusManager 통합 — cron 트리거 가시화. pipeline 이 있으면 runTask 가 별도 sub-status 발행. */
  async handleCronTrigger(info: import('./ports').CronTriggerInfo) {
    // 사용자 가시화 — jobId raw 대신 title (있으면) + trigger 한국어 라벨
    const triggerLabel = info.trigger === 'CRON_SCHEDULER' ? '예약'
      : info.trigger === 'SCHEDULED_ONCE' ? '1회 예약'
      : '즉시 실행';
    const displayName = info.title || info.jobId;
    const job = this.statusMgr.start({
      type: 'cron',
      message: `${displayName} (${triggerLabel})`,
      meta: { jobId: info.jobId, trigger: info.trigger, targetPath: info.targetPath, hasPipeline: Boolean(info.pipeline?.length), title: info.title },
    });
    const result = await this.schedule.handleTrigger(info);
    if (result.success) {
      this.statusMgr.done(job.id, {
        jobId: result.jobId,
        durationMs: result.durationMs,
        ...(result.stepsExecuted != null ? { stepsExecuted: result.stepsExecuted } : {}),
        ...(result.stepsTotal != null ? { stepsTotal: result.stepsTotal } : {}),
      });
    } else {
      this.statusMgr.error(job.id, result.error || 'Cron 실행 실패');
    }
    this.event.notifyCronComplete({ jobId: result.jobId, success: result.success, durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}) });
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  대화 히스토리 (admin 다기기 동기화) → ConversationManager
  // ══════════════════════════════════════════════════════════════════════════

  listConversations(owner: string) { return this.conversation.list(owner); }
  getConversation(owner: string, id: string) { return this.conversation.get(owner, id); }
  saveConversation(owner: string, id: string, title: string, messages: unknown[], createdAt?: number) {
    return this.conversation.save(owner, id, title, messages, createdAt);
  }
  deleteConversation(owner: string, id: string) { return this.conversation.delete(owner, id); }
  isConversationDeleted(owner: string, id: string) { return this.conversation.isDeleted(owner, id); }
  searchConversationHistory(owner: string, query: string, opts?: { currentConvId?: string; limit?: number; withinDays?: number; minScore?: number; includeBlocks?: boolean }) {
    return this.conversation.searchHistory(owner, query, opts);
  }
  /** CLI 세션 resume — 대화의 현재 모델과 매칭 시에만 반환 */
  getCliSession(conversationId: string, currentModel: string) {
    return this.conversation.getCliSession(conversationId, currentModel);
  }
  /** CLI 세션 저장 (첫 턴 후) */
  setCliSession(conversationId: string, sessionId: string, model: string) {
    return this.conversation.setCliSession(conversationId, sessionId, model);
  }
  // ── 공유 대화 (shared conversations) ────────────────────────────────────
  // ChatGPT·Claude 스타일 공유. TTL 24시간. 만료는 cron 이 정리.
  /** 공유 생성 — 단일턴 (type='turn') or 전체대화 (type='full').
   *  messages 는 공유 시점 snapshot — 원본 변경 영향 X.
   *  dedupKey: 같은 키로 24h 내 여러번 요청 시 DB 가 기존 slug 반환 (동일 메시지 재공유 시 링크 유지). */
  async createShare(input: { type: 'turn' | 'full'; title: string; messages: unknown[]; owner?: string; sourceConvId?: string; ttlMs?: number; dedupKey?: string }) {
    const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000; // 기본 24시간
    return this.infra.database.createShare({ ...input, ttlMs });
  }
  /** 공유 조회 — 만료 시 null 반환 (404 처리용). 공개 API (인증 없음). */
  async getShare(slug: string) {
    return this.infra.database.getShare(slug);
  }
  /** 만료된 공유 정리 — cron 에서 호출. */
  async cleanupExpiredShares() {
    return this.infra.database.cleanupExpiredShares();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  텔레그램 양방향 봇 — webhook 등록·해제·메시지 처리
  // ══════════════════════════════════════════════════════════════════════════

  /** 텔레그램 webhook URL 등록.
   *  domain = 'https://firebat.co.kr' 형태 — webhook URL = `${domain}/api/telegram/webhook`.
   *  자동 secret 생성 + Vault 저장. setWebhook 응답 처리. */
  async setupTelegramWebhook(domain: string): Promise<{ success: boolean; webhookUrl?: string; error?: string }> {
    const token = this.infra.vault.getSecret('user:TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { success: false, error: 'TELEGRAM_BOT_TOKEN 미설정' };
    if (!/^https:\/\/.+/.test(domain)) return { success: false, error: 'domain 은 https:// 로 시작해야 합니다 (텔레그램 Bot API 요구)' };

    // secret 자동 생성 — 32자 hex
    let secret = this.infra.vault.getSecret('user:TELEGRAM_WEBHOOK_SECRET');
    if (!secret) {
      secret = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      this.infra.vault.setSecret('user:TELEGRAM_WEBHOOK_SECRET', secret);
    }

    const webhookUrl = `${domain.replace(/\/$/, '')}/api/telegram/webhook`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secret,
          allowed_updates: ['message'],
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        return { success: false, error: json.description || `HTTP ${res.status}` };
      }
      return { success: true, webhookUrl };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /** 텔레그램 webhook 해제 + secret 삭제 */
  async removeTelegramWebhook(): Promise<{ success: boolean; error?: string }> {
    const token = this.infra.vault.getSecret('user:TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { success: false, error: 'TELEGRAM_BOT_TOKEN 미설정' };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      this.infra.vault.deleteSecret('user:TELEGRAM_WEBHOOK_SECRET');
      if (!res.ok || !json.ok) {
        return { success: false, error: json.description || `HTTP ${res.status}` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /** 텔레그램 webhook 현재 상태 조회 — getWebhookInfo + Vault 확인 */
  async getTelegramWebhookStatus(): Promise<{ active: boolean; url?: string; configured: boolean; ownerCount: number; error?: string }> {
    const token = this.infra.vault.getSecret('user:TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN;
    const ownerIdsRaw = this.infra.vault.getSecret('user:TELEGRAM_OWNER_IDS') || '';
    const ownerCount = ownerIdsRaw.split(',').map(s => s.trim()).filter(Boolean).length;
    const configured = !!token && ownerCount > 0;
    if (!token) return { active: false, configured: false, ownerCount: 0, error: 'TELEGRAM_BOT_TOKEN 미설정' };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        return { active: false, configured, ownerCount, error: json.description || `HTTP ${res.status}` };
      }
      const url = json.result?.url || '';
      return { active: !!url, url: url || undefined, configured, ownerCount };
    } catch (err: any) {
      return { active: false, configured, ownerCount, error: err.message || String(err) };
    }
  }

  /** 텔레그램 user ID 가 owner whitelist 에 있는지 — webhook 진입점 권한 검사. */
  isTelegramOwner(userId: string | number): boolean {
    const ownerIdsRaw = this.infra.vault.getSecret('user:TELEGRAM_OWNER_IDS') || '';
    const owners = ownerIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
    return owners.includes(String(userId));
  }

  /** Webhook 보안 토큰 검증용 — X-Telegram-Bot-Api-Secret-Token 헤더와 비교. */
  getTelegramWebhookSecret(): string | null {
    return this.infra.vault.getSecret('user:TELEGRAM_WEBHOOK_SECRET');
  }

  /** 텔레그램 메시지 처리 — AI 호출 + sysmod_telegram 응답 발송.
   *  Stateless (history 없음 — v1.x 후속에서 chatId 별 conversation 추가 가능). */
  async processTelegramMessage(text: string, chatId: string | number): Promise<{ success: boolean; reply?: string; error?: string }> {
    try {
      // 1. AI 호출 (history 없음, stateless)
      const aiRes = await this.requestActionWithTools(text, []);
      if (!aiRes.success) {
        return { success: false, error: aiRes.error || 'AI 응답 실패' };
      }
      const reply = (aiRes.reply || '').trim();
      if (!reply) {
        return { success: false, error: 'AI 응답 비어있음' };
      }

      // 2. sysmod_telegram send-message 로 응답 (chatId 명시)
      const sendRes = await this.sandboxExecute('system/modules/telegram/index.mjs', {
        action: 'send-message',
        chatId: String(chatId),
        text: reply.slice(0, 4000), // 텔레그램 4096자 한도, 여유 96자
      });
      if (!sendRes.success) {
        this.infra.log.error(`[Telegram] 응답 전송 실패: ${sendRes.error}`);
        return { success: false, error: sendRes.error };
      }
      return { success: true, reply };
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.infra.log.error(`[Telegram] processMessage 실패: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  미디어 → MediaManager (생성·재생성·CRUD·갤러리·OG 안전성)
  //  Core facade 의 책임: StatusManager wrap + SSE emit. 도메인 로직은 모두 MediaManager.
  // ══════════════════════════════════════════════════════════════════════════

  /** AI image_gen 도구 → 비동기 시작. 즉시 placeholder URL 반환 → AI 가 page spec 박고 save_page 즉시 발행 가능.
   *  실제 생성은 백그라운드에서 진행 → 완료 시 placeholder 파일이 실제 이미지로 자동 교체 → 사용자 page reload 시 swap.
   *  StatusManager 통합 — 진행도 SSE + 갤러리 카드 status='rendering' → 'done' 전환.
   *  이전 sync `generateImage` 는 채팅 이미지 모드 (입력창 토글, /api/media/generate 직접 호출) 전용으로 유지. */
  async startImageGeneration(input: GenerateImageInput, corrId?: string) {
    const scope = input.scope ?? 'user';
    const job = this.statusMgr.start({
      type: 'image',
      message: '이미지 생성 시작 (백그라운드)...',
      meta: {
        promptPreview: input.prompt.slice(0, 80),
        model: input.model ?? this.media.getImageModel(),
        scope,
        async: true,
      },
    });
    const res = await this.media.startGenerate(input, {
      corrId,
      onComplete: (result) => {
        this.statusMgr.done(job.id, { slug: result.slug, url: result.url });
        // 백그라운드 완료 시 갤러리·페이지 자동 갱신 — placeholder 카드가 실제 이미지로 swap
        this.event.notifyGallery({ slug: result.slug, scope });
      },
      onError: (err) => {
        this.statusMgr.error(job.id, err);
        this.event.notifyGallery({ error: err, scope });
      },
    });
    if (res.success && res.data) {
      // placeholder 등장 즉시 갤러리 갱신 — 사용자가 "렌더링중" 카드 보게
      this.event.notifyGallery({ slug: res.data.slug, scope });
    } else {
      this.statusMgr.error(job.id, res.error || 'startGenerate 실패');
    }
    return res;
  }

  /** [Legacy / 채팅 이미지 모드 전용] sync 이미지 생성 — 60-90s await.
   *  AI image_gen 도구는 startImageGeneration 사용 권장 (CLI HTTP timeout 우회).
   *  /api/media/generate 직접 호출 (입력창 이미지 토글) 만 이 경로 — LLM 우회 흐름이라 사용자가 그 시간 자연스레 기다림. */
  async generateImage(input: GenerateImageInput, corrId?: string) {
    const job = this.statusMgr.start({
      type: 'image',
      message: '이미지 생성 시작...',
      meta: {
        promptPreview: input.prompt.slice(0, 80),
        model: input.model ?? this.media.getImageModel(),
        scope: input.scope ?? 'user',
      },
    });
    const res = await this.media.generateImage(input, {
      corrId,
      onProgress: (progress, message) => {
        this.statusMgr.update(job.id, { progress, message });
      },
    });
    if (res.success && res.data) {
      this.statusMgr.done(job.id, { slug: res.data.slug, url: res.data.url });
    } else {
      this.statusMgr.error(job.id, res.error || '이미지 생성 실패');
    }
    this.event.notifyGallery(
      res.success
        ? { slug: res.data?.slug, scope: input.scope ?? 'user' }
        : { error: res.error, scope: input.scope ?? 'user' },
    );
    return res;
  }

  /** 갤러리에서 재생성 — 기존 메타의 prompt/model/aspectRatio 등 그대로 재실행.
   *  성공 시 새 slug 발급 + 기존 slug 정리 (status='error' 청소).
   *  prompt 가 없는 레거시 레코드는 재생성 불가. */
  async regenerateImage(slug: string) {
    // 진행 가시화 — 도메인 로직은 MediaManager 가 처리, Core 는 StatusManager wrap 만.
    const job = this.statusMgr.start({
      type: 'image',
      message: '재생성 시작...',
      meta: { regenFrom: slug },
    });
    const res = await this.media.regenerateImageBySlug(slug, {
      onProgress: (progress, message) => {
        this.statusMgr.update(job.id, { progress, message });
      },
    });
    if (res.success && res.data) {
      this.statusMgr.done(job.id, { slug: res.data.slug, url: res.data.url, regenFrom: slug });
    } else {
      this.statusMgr.error(job.id, res.error || '재생성 실패');
    }
    // 새 slug 발급된 경우 기존 슬러그 정리 (실패 시 기존 에러 레코드 유지 — 히스토리 보존).
    if (res.success && res.data?.slug && res.data.slug !== slug) {
      await this.media.remove(slug).catch(() => undefined);
    }
    this.event.notifyGallery(
      res.success
        ? { slug: res.data?.slug, replacedSlug: slug }
        : { error: res.error },
    );
    return res;
  }

  /** 이미지 모델·기본값 — 설정 UI 에서 사용 */
  getImageModel() { return this.media.getImageModel(); }
  setImageModel(modelId: string) { return this.media.setImageModel(modelId); }
  getAvailableImageModels() { return this.media.listImageModels(); }
  getImageDefaultSize() { return this.media.getImageDefaultSize(); }
  setImageDefaultSize(size: string | null) { return this.media.setImageDefaultSize(size); }
  getImageDefaultQuality() { return this.media.getImageDefaultQuality(); }
  setImageDefaultQuality(quality: string | null) { return this.media.setImageDefaultQuality(quality); }
  getImageSettings() { return this.media.getImageSettings(); }

  /** /user/media/<slug>.<ext> 파일 서빙 — slug 로 binary + contentType */
  readMedia(slug: string) { return this.media.read(slug); }
  /** 갤러리용 미디어 목록 — scope/검색/페이징 */
  listMedia(opts?: { scope?: 'user' | 'system' | 'all'; limit?: number; offset?: number; search?: string }) {
    return this.media.list(opts);
  }
  /** 갤러리에서 수동 삭제. 성공 시 SSE `gallery:refresh` emit. */
  async removeMedia(slug: string) {
    const res = await this.media.remove(slug);
    if (res.success) this.event.notifyGallery({ slug, removed: true });
    return res;
  }

  /** og:image 등 외부 노출 안전성 판단 — SNS 캐싱·검색엔진 인덱스 보호.
   *  미디어 URL 아니면 true (외부 URL 통과). 미디어면 status='done' + bytes>0 만 true. */
  async isMediaReady(url: string | undefined | null): Promise<boolean> {
    return this.media.isMediaReady(url);
  }

  /** 사용자 업로드 이미지 → 갤러리 저장. 어드민 채팅의 첨부 토글 ON 상태일 때 호출.
   *  binary 는 Buffer 또는 base64 data URL 모두 받음. source='upload' 자동 마킹. */
  async saveUpload(opts: {
    binary: Buffer | string;  // Buffer 또는 'data:image/png;base64,...'
    contentType?: string;
    filenameHint?: string;
    scope?: 'user' | 'system';
  }): Promise<import('./types').InfraResult<{ slug: string; url: string }>> {
    let buf: Buffer;
    let contentType = opts.contentType ?? 'image/png';
    if (typeof opts.binary === 'string') {
      // data URL parse — 'data:image/png;base64,iVBOR...'
      const m = opts.binary.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return { success: false, error: 'data URL 파싱 실패' };
      contentType = m[1];
      buf = Buffer.from(m[2], 'base64');
    } else {
      buf = opts.binary;
    }
    const res = await this.infra.media.save(buf, contentType, {
      scope: opts.scope ?? 'user',
      ...(opts.filenameHint ? { filenameHint: opts.filenameHint } : {}),
      source: 'upload',
    });
    if (!res.success || !res.data) return { success: false, error: res.error || '업로드 저장 실패' };
    this.event.notifyGallery({ slug: res.data.slug, scope: opts.scope ?? 'user', source: 'upload' });
    return { success: true, data: { slug: res.data.slug, url: res.data.url } };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  이벤트 → EventManager
  //  lib/events.ts 의 eventBus 위에 wrap. audit log + filtered subscribe 추가.
  //  기존 호출자 (eventBus.emit) 무수정 — 점진 마이그레이션.
  // ══════════════════════════════════════════════════════════════════════════

  /** 디버깅·관리자 UI — 최근 발행된 이벤트 audit log */
  listEventAuditLog(limit = 50) {
    return this.event.listAuditLog(limit);
  }

  /** 외부에서 typed 이벤트 구독 (Backend 컨텍스트). filter:
   *   - '*' : 모든 이벤트
   *   - 문자열 배열 : 매칭 type 만
   *   - 함수 : (event) => boolean */
  subscribeEvents(
    filter: '*' | string[] | ((event: import('../lib/events').FirebatEvent) => boolean),
    handler: (event: import('../lib/events').FirebatEvent) => void,
  ) {
    return this.event.subscribe(filter, handler);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  작업 상태 → StatusManager
  //  Long-running 작업 (이미지 생성 · pipeline · cron · sandbox 등) 의 진행 상태를
  //  단일 source 에서 관리. UI 진행도 표시 + AI 비동기 도구 패턴 + 메트릭 forward 의 backbone.
  //  Step 1 — backbone facade. Step 2~ MediaManager·TaskManager·ScheduleManager 마이그레이션.
  // ══════════════════════════════════════════════════════════════════════════

  /** 작업 시작 등록. id 미지정 시 자동 발급. 반환값의 id 로 후속 update/done/error 호출. */
  startJob(opts: { id?: string; type: JobType; message?: string; parentJobId?: string; meta?: Record<string, unknown> }): JobStatus {
    return this.statusMgr.start(opts);
  }
  /** 진행도·메시지·메타 갱신 (terminal 상태에 호출 시 무시). */
  updateJobStatus(id: string, patch: { progress?: number; message?: string; meta?: Record<string, unknown> }): JobStatus | null {
    return this.statusMgr.update(id, patch);
  }
  /** 정상 완료 — result 는 도메인별 (이미지 slug · pipeline 결과 등) */
  completeJob(id: string, result?: unknown): JobStatus | null {
    return this.statusMgr.done(id, result);
  }
  /** 실패 종료 — error 메시지는 사용자 노출 가능 형태 권장 */
  failJob(id: string, msg: string): JobStatus | null {
    return this.statusMgr.error(id, msg);
  }
  /** 단일 조회 */
  getJobStatus(id: string): JobStatus | null {
    return this.statusMgr.get(id);
  }
  /** 활성·과거 작업 조회. filter: type/status/since/parentJobId/limit */
  listJobs(filter?: { type?: JobType; status?: JobStatusKind | JobStatusKind[]; since?: number; parentJobId?: string; limit?: number }): JobStatus[] {
    return this.statusMgr.list(filter);
  }
  /** 변화 감지 subscribe — Cost tracker·UI 인디케이터 등이 등록.
   *  unsubscribe handle 반환. */
  subscribeJobUpdates(handler: (event: JobChangeEvent) => void): () => void {
    return this.statusMgr.subscribe(handler);
  }
  /** 디버깅·관리자 UI — 현재 메모리 상태 요약 */
  getJobStats() {
    return this.statusMgr.getStats();
  }

  /** 에러 캡처 — try/catch 블록·콜백 실패 등 statusMgr 외부 에러도 동일 파이프라인 (jsonl + Telegram).
   *  StatusManager 통한 자동 forward 가 없는 경로 (예: API route 의 catch, 외부 콜백) 에서 명시 호출. */
  async captureException(err: unknown, ctx: ErrorContext = {}): Promise<void> {
    return _captureException(this, err, ctx);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  LLM 비용 추적 → CostManager
  //  AiManager 가 askWithTools 응답의 usage 받으면 recordLlmCost 호출.
  //  통계 페이지·관리자 모니터링은 getLlmCostStats 사용.
  // ══════════════════════════════════════════════════════════════════════════

  /** LLM 호출 1건 기록. Caller (AiManager) 가 usage 받으면 호출. */
  recordLlmCost(usage: import('./ports').LlmTokenUsage): void {
    this.cost.recordCall(usage);
  }
  /** 일별·모델별 비용 통계 — 어드민 통계 페이지·UI 차트용 */
  getLlmCostStats(filter?: CostStatsFilter): CostStatsSummary {
    return this.cost.getStats(filter);
  }
  /** 즉시 flush — Vault 영속 강제 */
  async flushLlmCost(): Promise<void> {
    return this.cost.flushNow();
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  도구 → ToolManager
  //  도구 등록·dispatch 단일 source. AiManager·MCP server·SDK 가 같은 registry 사용.
  //  Step 1: backbone facade. Step 2~ 에서 정적·동적 도구 등록 + executeToolCall 마이그레이션.
  // ══════════════════════════════════════════════════════════════════════════

  /** 도구 등록 (static·sysmod·mcp·render·meta 카테고리). 같은 이름 재등록 = 덮어씀. */
  registerTool(def: ToolDefinition): void {
    this.tool.register(def);
  }
  /** 일괄 등록 — 부팅 시 정적 도구 batch */
  registerTools(defs: ToolDefinition[]): void {
    this.tool.registerMany(defs);
  }
  /** 도구 등록 해제 */
  unregisterTool(name: string): boolean {
    return this.tool.unregister(name);
  }
  /** 단일 조회 */
  getToolDefinition(name: string): ToolDefinition | null {
    return this.tool.get(name);
  }
  /** 등록된 도구 목록 (필터 가능) */
  listTools(filter?: ToolListFilter): ToolDefinition[] {
    return this.tool.list(filter);
  }
  /** 도구 실행 — name·args·ctx 받아 handler 호출 */
  async executeTool(name: string, args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    return this.tool.execute(name, args, ctx);
  }
  /** AI Function Calling 용 도구 정의 빌드 — askWithTools 에 그대로 전달 */
  buildAiToolDefinitions(filter?: ToolListFilter) {
    return this.tool.buildAiToolDefinitions(filter);
  }
  /** MCP 서버 도구 description 빌드 — mcp/server.ts 에서 사용 */
  buildMcpToolDescriptions(filter?: ToolListFilter) {
    return this.tool.buildMcpToolDescriptions(filter);
  }
  /** 디버깅·관리자 UI — 도구 통계 */
  getToolStats() {
    return this.tool.getStats();
  }

  // Plan 실행 / 3-stage state (multi-turn 지속) — 대화 수준 JSON 유지
  getActivePlanState(conversationId: string) {
    return this.conversation.getActivePlanState(conversationId);
  }
  setActivePlanState(conversationId: string, state: Record<string, unknown> | null) {
    return this.conversation.setActivePlanState(conversationId, state);
  }
  clearActivePlanState(conversationId: string) {
    return this.conversation.clearActivePlanState(conversationId);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  시크릿 → SecretManager
  // ══════════════════════════════════════════════════════════════════════════

  listUserSecrets() { return this.secret.listUser(); }
  setUserSecret(name: string, value: string) { return this.secret.setUser(name, value); }
  getUserSecret(name: string) { return this.secret.getUser(name); }
  deleteUserSecret(name: string) { return this.secret.deleteUser(name); }
  async listUserModuleSecrets() { return this.secret.listModuleSecrets(); }
  getGeminiKey(key: string) { return this.secret.getSystem(key); }
  setGeminiKey(key: string, value: string) { return this.secret.setSystem(key, value); }

  // ══════════════════════════════════════════════════════════════════════════
  //  인증 → AuthManager
  // ══════════════════════════════════════════════════════════════════════════

  /** 로그인 — 세션 토큰 발급. 실패 시 null. 잠금 시 { locked, retryAfterSec }.
   *  attemptKey 는 IP 등 식별자 (rate limit 키) — 미전달 시 'global'. */
  login(id: string, password: string, attemptKey?: string): AuthSession | { locked: true; retryAfterSec: number } | null {
    return this.authMgr.login(id, password, attemptKey);
  }
  /** 세션 토큰 검증 */
  validateSession(token: string): AuthSession | null { return this.authMgr.validateSession(token); }
  /** 로그아웃 */
  logout(token: string): boolean { return this.authMgr.logout(token); }
  /** 모든 종류의 토큰 검증 (세션 + API) */
  validateToken(token: string): AuthSession | null { return this.authMgr.validateToken(token); }

  // ── API 토큰 (MCP 등) ──
  generateApiToken(label?: string): string { return this.authMgr.generateApiToken(label); }
  validateApiToken(token: string): AuthSession | null { return this.authMgr.validateApiToken(token); }
  revokeApiTokens(): number { return this.authMgr.revokeApiTokens(); }
  getApiTokenInfo(): ApiTokenInfo { return this.authMgr.getApiTokenInfo(); }

  // ── 관리자 자격증명 ──
  getAdminCredentials() { return this.authMgr.getAdminCredentials(); }
  setAdminCredentials(newId?: string, newPassword?: string) { this.authMgr.setAdminCredentials(newId, newPassword); }

  // ══════════════════════════════════════════════════════════════════════════
  //  시스템 설정 (얇은 패스스루 — 매니저 불필요)
  // ══════════════════════════════════════════════════════════════════════════

  getTimezone(): string {
    return this.infra.vault.getSecret(VK_SYSTEM_TIMEZONE) || 'Asia/Seoul';
  }

  setTimezone(tz: string): boolean {
    const ok = this.infra.vault.setSecret(VK_SYSTEM_TIMEZONE, tz);
    if (ok) this.infra.cron.setTimezone(tz);
    return ok;
  }

  getAiModel(): string | null {
    return this.infra.vault.getSecret(VK_SYSTEM_AI_MODEL);
  }

  setAiModel(model: string): boolean {
    return this.infra.vault.setSecret(VK_SYSTEM_AI_MODEL, model);
  }

  getAiThinkingLevel(): string {
    return this.infra.vault.getSecret(VK_SYSTEM_AI_THINKING_LEVEL) || 'low';
  }

  setAiThinkingLevel(level: string): boolean {
    return this.infra.vault.setSecret(VK_SYSTEM_AI_THINKING_LEVEL, level);
  }

  /** 사용자가 설정한 커스텀 프롬프트 (User AI 전용 — Vault 만, fallback 없음).
   *  비어있으면 빈 문자열 반환 → 시스템 프롬프트에 사용자 지시사항 섹션 자체 미주입.
   *  Code Assistant·AI Assistant 는 user prompt 미사용 — 코드 품질·라우팅 정확도 보호. */
  getUserPrompt(): string {
    return this.infra.vault.getSecret(VK_SYSTEM_USER_PROMPT) || '';
  }

  setUserPrompt(prompt: string): boolean {
    // 2000자 제한 (토큰 낭비 방지)
    const trimmed = (prompt || '').slice(0, 2000);
    return this.infra.vault.setSecret(VK_SYSTEM_USER_PROMPT, trimmed);
  }

  /** Anthropic API prompt caching 토글 — Claude API 모드 전용.
   *  기본 OFF (cache write 25% 비용 회피). 같은 prefix 5분 내 2회+ 호출 패턴일 때만 ON 권장.
   *  CLI 모드 (Claude Code 등) 는 백엔드 자동 caching → 토글 무관. */
  getAnthropicCacheEnabled(): boolean {
    return this.infra.vault.getSecret(VK_LLM_ANTHROPIC_CACHE) === 'true';
  }

  setAnthropicCacheEnabled(enabled: boolean): boolean {
    return this.infra.vault.setSecret(VK_LLM_ANTHROPIC_CACHE, enabled ? 'true' : 'false');
  }

  /** 설정 모달 "AI 카테고리별 마지막 선택 모델" — 멀티 기기 동기화용 Vault 저장.
   *  반환: { category: modelValue } 객체. 미설정 시 빈 객체. */
  getLastModelByCategory(): Record<string, string> {
    const raw = this.infra.vault.getSecret(VK_SYSTEM_LAST_MODEL_BY_CATEGORY);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  setLastModelByCategory(value: Record<string, string>): boolean {
    return this.infra.vault.setSecret(VK_SYSTEM_LAST_MODEL_BY_CATEGORY, JSON.stringify(value));
  }

  /** AI Assistant (도구 라우터 등 내부 서브 AI) 모델.
   *  미설정 시 DEFAULT_AI_ASSISTANT_MODEL 반환. */
  getAiAssistantModel(): string {
    return this.infra.vault.getSecret(VK_SYSTEM_AI_ASSISTANT_MODEL) || DEFAULT_AI_ASSISTANT_MODEL;
  }
  setAiAssistantModel(model: string): boolean {
    if (!AI_ASSISTANT_MODELS.includes(model)) return false;
    return this.infra.vault.setSecret(VK_SYSTEM_AI_ASSISTANT_MODEL, model);
  }
  getAiAssistantDefault(): string { return DEFAULT_AI_ASSISTANT_MODEL; }
  getAvailableAiAssistantModels(): readonly string[] { return AI_ASSISTANT_MODELS; }

  // ══════════════════════════════════════════════════════════════════════════
  //  네트워크 (얇은 패스스루 — 매니저 불필요)
  // ══════════════════════════════════════════════════════════════════════════

  async networkFetch(url: string, options?: NetworkRequestOptions): Promise<InfraResult<NetworkResponse>> {
    return this.infra.network.fetch(url, options);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  MCP → McpManager
  // ══════════════════════════════════════════════════════════════════════════

  listMcpServers() { return this.mcp.listServers(); }
  async addMcpServer(config: McpServerConfig) { return this.mcp.addServer(config); }
  async removeMcpServer(name: string) { return this.mcp.removeServer(name); }
  async listMcpTools(serverName: string) { return this.mcp.listTools(serverName); }
  async listAllMcpTools() { return this.mcp.listAllTools(); }
  async callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>) { return this.mcp.callTool(serverName, toolName, args); }

  // ══════════════════════════════════════════════════════════════════════════
  //  Capability → CapabilityManager
  // ══════════════════════════════════════════════════════════════════════════

  listCapabilities() { return this.capability.list(); }
  registerCapability(id: string, label: string, description: string) { this.capability.register(id, label, description); }
  async getCapabilityProviders(capId: string) { return this.capability.getProviders(capId); }
  async listCapabilitiesWithProviders() { return this.capability.listWithProviders(); }
  async resolveCapability(capId: string) { return this.capability.resolve(capId); }
  getCapabilitySettings(capId: string) { return this.capability.getSettings(capId); }
  setCapabilitySettings(capId: string, settings: CapabilitySettings) { return this.capability.setSettings(capId, settings); }

  // ══════════════════════════════════════════════════════════════════════════
  //  DB 쿼리 (얇은 패스스루 — 매니저 불필요)
  // ══════════════════════════════════════════════════════════════════════════

  async queryDatabase(sql: string, params?: unknown[]): Promise<InfraResult<Record<string, unknown>[]>> {
    return this.infra.database.query(sql, params);
  }
}

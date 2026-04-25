import { AiManager } from './managers/ai-manager';
import { StorageManager } from './managers/storage-manager';
import { PageManager } from './managers/page-manager';
import { ProjectManager } from './managers/project-manager';
import { ModuleManager } from './managers/module-manager';
import { ScheduleManager } from './managers/schedule-manager';
import { SecretManager } from './managers/secret-manager';
import { McpManager } from './managers/mcp-manager';
import { CapabilityManager } from './managers/capability-manager';
import { TaskManager } from './managers/task-manager';
import { AuthManager } from './managers/auth-manager';
import type { ApiTokenInfo } from './managers/auth-manager';
import { ConversationManager } from './managers/conversation-manager';
import type { ConversationSummary, ConversationRecord } from './managers/conversation-manager';
import { MediaManager } from './managers/media-manager';
import type { GenerateImageInput, GenerateImageResult } from './managers/media-manager';
import { EventManager } from './managers/event-manager';
import { StatusManager } from './managers/status-manager';
import type { JobStatus, JobType, JobStatusKind, JobChangeEvent } from './managers/status-manager';
import { CostManager } from './managers/cost-manager';
import type { CostStatsFilter, CostStatsSummary } from './managers/cost-manager';
import { ToolManager } from './managers/tool-manager';
import type { ToolDefinition, ToolListFilter, ToolExecuteContext, ToolExecuteResult } from './managers/tool-manager';
import type { FirebatInfraContainer, ILlmPort, LlmChunk, McpServerConfig, CronScheduleOptions, PipelineStep, AuthSession, ChatMessage, NetworkRequestOptions, NetworkResponse, ModuleOutput } from './ports';
import type { InfraResult } from './types';
import type { CapabilitySettings } from './capabilities';
import { VK_SYSTEM_TIMEZONE, VK_SYSTEM_AI_MODEL, VK_SYSTEM_AI_THINKING_LEVEL, VK_SYSTEM_USER_PROMPT, VK_SYSTEM_AI_ASSISTANT_MODEL, VK_SYSTEM_LAST_MODEL_BY_CATEGORY, DEFAULT_AI_ASSISTANT_MODEL, AI_ASSISTANT_MODELS } from './vault-keys';
import { eventBus } from '../lib/events';
import { canonicalJson } from './utils/json-normalize';

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
  /** 플랜모드 — true 면 AI 가 작업 전에 propose_plan 도구로 계획 카드를 먼저 제시 */
  planMode?: boolean;
  /** 사용자가 직전 turn 의 propose_plan 카드에서 ✓실행 클릭 시 동봉되는 planId.
   *  AiManager 가 plan-store 에서 steps 조회 후 시스템 프롬프트에 강제 주입. */
  planExecuteId?: string;
  /** 사용자가 ⚙수정 제안 input 에 피드백 입력 시 동봉되는 planId.
   *  AiManager 가 직전 plan + 사용자 피드백 → propose_plan 재호출 강제. */
  planReviseId?: string;
}

/** DSN 마스킹 헬퍼 — UI 노출용 (앞 8자 + ... + 뒤 4자). 토큰 풀 노출 방지. */
function maskDsn(dsn: string): string {
  if (!dsn || dsn.length < 16) return '****';
  return dsn.slice(0, 12) + '...' + dsn.slice(-8);
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
    this.module = new ModuleManager(infra.sandbox, infra.storage, infra.vault);
    this.secret = new SecretManager(infra.vault, infra.storage);
    this.mcp = new McpManager(infra.mcpClient);
    this.capability = new CapabilityManager(infra.storage, infra.vault, infra.log);
    this.authMgr = new AuthManager(infra.auth, infra.vault);
    this.conversation = new ConversationManager(infra.database, infra.embedder);
    this.media = new MediaManager(infra.imageGen, infra.media, infra.imageProcessor, infra.vault, infra.log);
    this.event = new EventManager(infra.log);
    this.statusMgr = new StatusManager(infra.log, this.event);
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

  async codeAssist(params: { code: string; language: string; instruction: string; selectedCode?: string }, opts?: AiRequestOpts) {
    return this.ai.codeAssist(params, opts);
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

  /** 바이너리 파일 읽기 — base64 로 반환 (read_image MCP 도구용) */
  async readFileBinary(path: string): Promise<InfraResult<{ base64: string; mimeType: string; size: number }>> {
    return this.storage.readBinary(path);
  }

  async writeFile(path: string, content: string) {
    const res = await this.storage.write(path, content);
    if (res.success) {
      eventBus.emit({ type: 'sidebar:refresh', data: {} });
      // 모듈 config.json 변경 시 AI 캐시 무효화
      if (path.endsWith('/config.json') && (path.includes('modules/') || path.includes('services/'))) {
        this.ai.invalidateCache();
      }
    }
    return res;
  }

  async deleteFile(path: string) {
    const res = await this.storage.delete(path);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
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
    const specStr = canonicalJson(spec);
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
        if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
        return res.success ? { success: true, data: { slug: finalSlug, renamed: true } } : { success: false, error: res.error };
      } catch (err: any) {
        return { success: false, error: `spec slug 갱신 실패: ${err.message}` };
      }
    }
    const res = await this.page.save(finalSlug, specStr);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res.success ? { success: true, data: { slug: finalSlug, renamed: false } } : { success: false, error: res.error };
  }

  async deletePage(slug: string) {
    const res = await this.page.delete(slug);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  async renamePage(oldSlug: string, newSlug: string, opts?: { setRedirect?: boolean }) {
    const res = await this.page.rename(oldSlug, newSlug, opts ?? {});
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  async renameProject(oldName: string, newName: string, opts?: { setRedirect?: boolean }) {
    const res = await this.page.renameProject(oldName, newName, opts ?? {});
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  /** from_slug → to_slug 리디렉트 — (user)/[...slug]/page.tsx 에서 사용 */
  async getPageRedirect(fromSlug: string) { return this.page.getRedirect(fromSlug); }

  async listStaticPages() { return this.page.listStatic(); }

  /** 페이지 visibility 설정 */
  async setPageVisibility(slug: string, visibility: 'public' | 'password' | 'private', password?: string) {
    const res = await this.page.setVisibility(slug, visibility, password);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
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
    eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return { success: true };
  }

  /** 프로젝트 visibility 조회 */
  getProjectVisibility(project: string) {
    return this.project.getVisibility(project);
  }

  /** 프로젝트 비밀번호 검증 */
  verifyProjectPassword(project: string, password: string) {
    return this.project.verifyPassword(project, password);
  }

  async deleteProject(project: string) {
    const res = await this.project.delete(project);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
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
   *  Caller (Pipeline step·cron 등) 가 StatusManager 와 연결 가능. */
  async sandboxExecute(targetPath: string, inputData: Record<string, unknown>, opts?: import('./ports').SandboxExecuteOpts) {
    return this.module.execute(targetPath, inputData, opts);
  }

  async getSystemModules() { return this.module.listSystem(); }
  getModuleSettings(moduleName: string) { return this.module.getSettings(moduleName); }
  async getModuleConfig(moduleName: string) { return this.module.getConfig(moduleName); }
  setModuleSettings(moduleName: string, settings: Record<string, any>) { return this.module.setSettings(moduleName, settings); }
  isModuleEnabled(moduleName: string) { return this.module.isEnabled(moduleName); }
  setModuleEnabled(moduleName: string, enabled: boolean) { this.ai.invalidateCache(); return this.module.setEnabled(moduleName, enabled); }
  getSeoSettings() { return this.module.getSeoSettings(); }

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
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  async cancelCronJob(jobId: string) {
    const res = await this.schedule.cancel(jobId);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  async updateCronJob(jobId: string, targetPath: string, opts: CronScheduleOptions) {
    const res = await this.schedule.update(jobId, targetPath, opts);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  listCronJobs() { return this.schedule.list(); }
  getCronLogs(limit?: number) { return this.schedule.getLogs(limit); }
  clearCronLogs() { this.schedule.clearLogs(); }
  consumeCronNotifications() { return this.schedule.consumeNotifications(); }

  /** Cron 비동기 트리거 콜백 — 시각 도달 시 cron 어댑터가 호출.
   *  Manager 직접 호출 안 하고 Core facade 경유 → SSE emit 단일 지점 (BIBLE 일관성).
   *  StatusManager 통합 — cron 트리거 가시화. pipeline 이 있으면 runTask 가 별도 sub-status 발행. */
  async handleCronTrigger(info: import('./ports').CronTriggerInfo) {
    const job = this.statusMgr.start({
      type: 'cron',
      message: `Cron 트리거: ${info.jobId} (${info.trigger})`,
      meta: { jobId: info.jobId, trigger: info.trigger, targetPath: info.targetPath, hasPipeline: Boolean(info.pipeline?.length) },
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
    eventBus.emit({ type: 'cron:complete', data: { jobId: result.jobId, success: result.success, durationMs: result.durationMs, error: result.error } });
    eventBus.emit({ type: 'sidebar:refresh', data: {} });
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
  //  미디어 → MediaManager (생성·재생성·CRUD·갤러리·OG 안전성)
  //  Core facade 의 책임: StatusManager wrap + SSE emit. 도메인 로직은 모두 MediaManager.
  // ══════════════════════════════════════════════════════════════════════════

  /** AI image_gen 도구 → 이미지 생성. 성공·실패 모두 갤러리 자동 갱신 (SSE).
   *  StatusManager 와 통합 — 진행도 'status:update' 자동 발행. */
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
    eventBus.emit({
      type: 'gallery:refresh',
      data: res.success ? { slug: res.data?.slug, scope: input.scope ?? 'user' } : { error: res.error, scope: input.scope ?? 'user' },
    });
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
    eventBus.emit({
      type: 'gallery:refresh',
      data: res.success
        ? { slug: res.data?.slug, replacedSlug: slug }
        : { error: res.error },
    });
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
    if (res.success) eventBus.emit({ type: 'gallery:refresh', data: { slug, removed: true } });
    return res;
  }

  /** og:image 등 외부 노출 안전성 판단 — SNS 캐싱·검색엔진 인덱스 보호.
   *  미디어 URL 아니면 true (외부 URL 통과). 미디어면 status='done' + bytes>0 만 true. */
  async isMediaReady(url: string | undefined | null): Promise<boolean> {
    return this.media.isMediaReady(url);
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
  //  단일 source 에서 관리. UI 진행도 표시 + AI 비동기 도구 패턴 + Sentry/메트릭 자동 forward 의 backbone.
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
  /** 변화 감지 subscribe — Sentry forward·Cost tracker·UI 인디케이터 등이 등록.
   *  unsubscribe handle 반환. */
  subscribeJobUpdates(handler: (event: JobChangeEvent) => void): () => void {
    return this.statusMgr.subscribe(handler);
  }
  /** 디버깅·관리자 UI — 현재 메모리 상태 요약 */
  getJobStats() {
    return this.statusMgr.getStats();
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

  /** Sentry DSN — env (SENTRY_DSN) 우선, 없으면 Vault.
   *  설정 변경 시 즉시 반영되지 않음 (런타임 init 됨) — 변경 후 PM2 restart 또는 dev 재시작 필요.
   *  반환은 마스킹된 형태 (UI 노출용) — 실제 DSN 은 boot 시점에만 사용. */
  getSentryDsn(): { configured: boolean; source: 'env' | 'vault' | 'none'; preview: string } {
    const envDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (envDsn && envDsn.startsWith('https://')) {
      return { configured: true, source: 'env', preview: maskDsn(envDsn) };
    }
    const vaultDsn = this.infra.vault.getSecret('system:sentry-dsn');
    if (vaultDsn && vaultDsn.startsWith('https://')) {
      return { configured: true, source: 'vault', preview: maskDsn(vaultDsn) };
    }
    return { configured: false, source: 'none', preview: '' };
  }

  setSentryDsn(dsn: string): boolean {
    const trimmed = (dsn || '').trim();
    if (trimmed && !trimmed.startsWith('https://')) return false;
    return this.infra.vault.setSecret('system:sentry-dsn', trimmed);
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

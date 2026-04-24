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
import { ImageManager } from './managers/image-manager';
import type { GenerateImageInput, GenerateImageResult } from './managers/image-manager';
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
  private readonly image: ImageManager;

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
    this.image = new ImageManager(infra.imageGen, infra.media, infra.vault, infra.log);

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

  /** 경로 지정 직접 실행 (EXECUTE, 파이프라인 등) */
  async sandboxExecute(targetPath: string, inputData: Record<string, unknown>) {
    return this.module.execute(targetPath, inputData);
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

  /** 파이프라인 즉시 실행 (RUN_TASK 액션) */
  async runTask(pipeline: PipelineStep[], onPipelineStep?: (index: number, status: 'start' | 'done' | 'error', error?: string) => void): Promise<{ success: boolean; data?: unknown; error?: string }> {
    return this.task.executePipeline(pipeline, onPipelineStep);
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
   *  Manager 직접 호출 안 하고 Core facade 경유 → SSE emit 단일 지점 (BIBLE 일관성). */
  async handleCronTrigger(info: import('./ports').CronTriggerInfo) {
    const result = await this.schedule.handleTrigger(info);
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
  //  이미지 생성 → ImageManager / 미디어 조회 → IMediaPort
  // ══════════════════════════════════════════════════════════════════════════

  /** AI 가 image_gen 도구 호출 → 이 메서드 → 생성 + 서버 저장 + URL 반환 */
  generateImage(input: GenerateImageInput, corrId?: string) {
    return this.image.generate(input, corrId);
  }
  /** 선택된 이미지 모델 ID (Vault 기반) */
  getImageModel() {
    return this.image.getModel();
  }
  /** 이미지 모델 변경 (설정 UI 에서 호출) */
  setImageModel(modelId: string) {
    return this.image.setModel(modelId);
  }
  /** 설정 UI 카스케이드용 — registry 에 등록된 모든 이미지 모델 목록 */
  getAvailableImageModels() {
    return this.image.listModels();
  }
  /** 기본 이미지 사이즈 — AI 미지정 시 폴백 (사용자 명령 우선) */
  getImageDefaultSize() { return this.image.getDefaultSize(); }
  setImageDefaultSize(size: string | null) { return this.image.setDefaultSize(size); }
  /** 기본 이미지 품질 — AI 미지정 시 폴백 */
  getImageDefaultQuality() { return this.image.getDefaultQuality(); }
  setImageDefaultQuality(quality: string | null) { return this.image.setDefaultQuality(quality); }
  /** /api/media/<slug>.<ext> 에서 파일 서빙용 — slug 로 binary + contentType 반환 */
  readMedia(slug: string) {
    return this.infra.media.read(slug);
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

  /** 로그인 — 세션 토큰 발급. 실패 시 null */
  login(id: string, password: string): AuthSession | null { return this.authMgr.login(id, password); }
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

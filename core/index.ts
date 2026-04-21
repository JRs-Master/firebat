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
import type { FirebatInfraContainer, ILlmPort, LlmChunk, McpServerConfig, CronScheduleOptions, PipelineStep, AuthSession, ChatMessage, NetworkRequestOptions, NetworkResponse, ModuleOutput } from './ports';
import type { InfraResult, FirebatPlan } from './types';
import type { CapabilitySettings } from './capabilities';
import { VK_SYSTEM_TIMEZONE, VK_SYSTEM_AI_MODEL, VK_SYSTEM_AI_THINKING_LEVEL, VK_SYSTEM_USER_PROMPT, VK_SYSTEM_AI_ASSISTANT_MODEL, DEFAULT_AI_ASSISTANT_MODEL, AI_ASSISTANT_MODELS } from './vault-keys';
import { DEFAULT_USER_PROMPT } from './default-user-prompt';
import { eventBus } from '../lib/events';

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

    // 크로스 도메인 매니저 — Core 참조 필요
    this.task = new TaskManager(this, infra.llm, infra.log);
    this.schedule = new ScheduleManager(this, infra.cron, infra.log);
    this.ai = new AiManager(this, infra.llm, infra.log, infra.database, infra.toolRouter);


  }

  // ══════════════════════════════════════════════════════════════════════════
  //  AI 채팅 → AiManager
  // ══════════════════════════════════════════════════════════════════════════

  async requestAction(prompt: string, history: ChatMessage[] = [], opts?: AiRequestOpts) {
    return this.ai.process(prompt, history, opts);
  }

  async requestActionWithTools(
    prompt: string,
    history: ChatMessage[] = [],
    opts?: AiRequestOpts,
    onToolCall?: (info: { name: string; status: 'start' | 'done' | 'error'; error?: string }) => void,
    onChunk?: (chunk: LlmChunk) => void,
  ) {
    return this.ai.processWithTools(prompt, history, opts, onToolCall, onChunk);
  }

  async planOnly(prompt: string, history: ChatMessage[] = [], opts?: AiRequestOpts) {
    return this.ai.planOnly(prompt, history, opts);
  }

  async executePlan(
    plan: FirebatPlan,
    corrId: string,
    opts?: AiRequestOpts,
    onStep?: (step: { index: number; total: number; type: string; status: 'start' | 'done' | 'error'; error?: string }) => void,
  ) {
    return this.ai.executePlan(plan, corrId, opts, onStep);
  }

  async codeAssist(params: { code: string; language: string; instruction: string; selectedCode?: string }, opts?: AiRequestOpts) {
    return this.ai.codeAssist(params, opts);
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

  async savePage(slug: string, spec: string) {
    const res = await this.page.save(slug, spec);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
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

  /** 사용자가 설정한 커스텀 프롬프트 (User AI 전용). Vault 비어있으면 DEFAULT_USER_PROMPT 폴백.
   *  Code Assistant·AI Assistant 는 사용자 취향 주입 안 함 — 코드 품질·라우팅 정확도 보호. */
  getUserPrompt(): string {
    const stored = this.infra.vault.getSecret(VK_SYSTEM_USER_PROMPT);
    if (stored && stored.trim()) return stored;
    return DEFAULT_USER_PROMPT;
  }

  /** 사용자가 직접 저장한 값만 반환 — UI textarea 초기값 표시용.
   *  값이 없으면 DEFAULT_USER_PROMPT 를 placeholder 로 보여주기 위함. */
  getUserPromptStored(): string {
    return this.infra.vault.getSecret(VK_SYSTEM_USER_PROMPT) || '';
  }

  /** 기본 사용자 프롬프트 (수정 안 했을 때 사용되는 값) — UI 가 placeholder 로 표시. */
  getUserPromptDefault(): string { return DEFAULT_USER_PROMPT; }

  setUserPrompt(prompt: string): boolean {
    // 2000자 제한 (토큰 낭비 방지)
    const trimmed = (prompt || '').slice(0, 2000);
    return this.infra.vault.setSecret(VK_SYSTEM_USER_PROMPT, trimmed);
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

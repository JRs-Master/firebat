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
import type { FirebatInfraContainer, ILlmPort, McpServerConfig, CronScheduleOptions, PipelineStep } from './ports';
import type { InfraResult } from './types';
import type { CapabilitySettings } from './capabilities';
import type { McpTokenInfo } from './managers/secret-manager';
import { eventBus } from '../lib/events';

/** AI 요청 옵션 — 요청별 모델/데모 모드 지정 */
export interface AiRequestOpts {
  model?: string;
  isDemo?: boolean;
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

  constructor(private readonly infra: FirebatInfraContainer) {
    // 매니저 생성 — 각 매니저는 자기 도메인의 인프라 포트를 직접 받음
    this.storage = new StorageManager(infra.storage);
    this.page = new PageManager(infra.database, infra.storage);
    this.project = new ProjectManager(infra.storage, infra.database);
    this.module = new ModuleManager(infra.sandbox, infra.storage, infra.vault);
    this.secret = new SecretManager(infra.vault, infra.storage);
    this.mcp = new McpManager(infra.mcpClient);
    this.capability = new CapabilityManager(infra.storage, infra.vault, infra.log);

    // 크로스 도메인 매니저 — Core 참조 필요
    this.task = new TaskManager(this, infra.llm, infra.log);
    this.schedule = new ScheduleManager(this, infra.cron, infra.log);
    this.ai = new AiManager(this, infra.llm, infra.log);

    infra.log.debug('[FirebatCore] Boot sequence initialized. 10 managers bound.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  AI 채팅 → AiManager
  // ══════════════════════════════════════════════════════════════════════════

  async requestAction(prompt: string, history: any[] = [], opts?: AiRequestOpts) {
    return this.ai.process(prompt, history, opts);
  }

  async planOnly(prompt: string, history: any[] = [], opts?: AiRequestOpts) {
    return this.ai.planOnly(prompt, history, opts);
  }

  async executePlan(
    plan: any,
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

  async writeFile(path: string, content: string) {
    const res = await this.storage.write(path, content);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
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

  async listStaticPages() { return this.page.listStatic(); }

  // ══════════════════════════════════════════════════════════════════════════
  //  프로젝트 → ProjectManager + SSE
  // ══════════════════════════════════════════════════════════════════════════

  async scanProjects() { return this.project.scan(); }

  async deleteProject(project: string) {
    const res = await this.project.delete(project);
    if (res.success) eventBus.emit({ type: 'sidebar:refresh', data: {} });
    return res;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  모듈 → ModuleManager
  // ══════════════════════════════════════════════════════════════════════════

  async runModule(moduleName: string, inputData: any) {
    return this.module.run(moduleName, inputData);
  }

  /** 경로 지정 직접 실행 (EXECUTE, 파이프라인 등) */
  async sandboxExecute(targetPath: string, inputData: any) {
    return this.module.execute(targetPath, inputData);
  }

  async getSystemModules() { return this.module.listSystem(); }
  getModuleSettings(moduleName: string) { return this.module.getSettings(moduleName); }
  setModuleSettings(moduleName: string, settings: Record<string, any>) { return this.module.setSettings(moduleName, settings); }
  getSeoSettings() { return this.module.getSeoSettings(); }

  // ══════════════════════════════════════════════════════════════════════════
  //  태스크 → TaskManager (파이프라인 즉시 실행)
  // ══════════════════════════════════════════════════════════════════════════

  /** 파이프라인 즉시 실행 (RUN_TASK 액션) */
  async runTask(pipeline: PipelineStep[], onPipelineStep?: (index: number, status: 'start' | 'done' | 'error', error?: string) => void): Promise<{ success: boolean; data?: any; error?: string }> {
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
  //  시크릿 → SecretManager
  // ══════════════════════════════════════════════════════════════════════════

  listUserSecrets() { return this.secret.listUser(); }
  setUserSecret(name: string, value: string) { return this.secret.setUser(name, value); }
  getUserSecret(name: string) { return this.secret.getUser(name); }
  deleteUserSecret(name: string) { return this.secret.deleteUser(name); }
  async listUserModuleSecrets() { return this.secret.listModuleSecrets(); }
  getVertexKey(key: string) { return this.secret.getSystem(key); }
  setVertexKey(key: string, value: string) { return this.secret.setSystem(key, value); }

  // ── 관리자 인증 ──
  getAdminCredentials() {
    const id       = this.secret.getSystem('FIREBAT_ADMIN_ID')       ?? process.env.FIREBAT_ADMIN_ID       ?? 'admin';
    const password = this.secret.getSystem('FIREBAT_ADMIN_PASSWORD') ?? process.env.FIREBAT_ADMIN_PASSWORD ?? 'admin';
    return { id, password };
  }
  setAdminCredentials(newId?: string, newPassword?: string) {
    if (newId)       this.secret.setSystem('FIREBAT_ADMIN_ID', newId);
    if (newPassword) this.secret.setSystem('FIREBAT_ADMIN_PASSWORD', newPassword);
  }

  // ── MCP 토큰 ──
  generateMcpToken(): string { return this.secret.generateMcpToken(); }
  validateMcpToken(token: string): boolean { return this.secret.validateMcpToken(token); }
  revokeMcpToken(): boolean { return this.secret.revokeMcpToken(); }
  getMcpTokenInfo(): McpTokenInfo { return this.secret.getMcpTokenInfo(); }

  // ══════════════════════════════════════════════════════════════════════════
  //  시스템 설정 (얇은 패스스루 — 매니저 불필요)
  // ══════════════════════════════════════════════════════════════════════════

  getTimezone(): string {
    return this.infra.vault.getSecret('system:timezone') || 'Asia/Seoul';
  }

  setTimezone(tz: string): boolean {
    const ok = this.infra.vault.setSecret('system:timezone', tz);
    if (ok) this.infra.cron.setTimezone(tz);
    return ok;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  네트워크 (얇은 패스스루 — 매니저 불필요)
  // ══════════════════════════════════════════════════════════════════════════

  async networkFetch(url: string, options?: any): Promise<InfraResult<any>> {
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
  async callMcpTool(serverName: string, toolName: string, args: any) { return this.mcp.callTool(serverName, toolName, args); }

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

  async queryDatabase(query: any, params?: any): Promise<InfraResult<any>> {
    return this.infra.database.query(query, params);
  }
}

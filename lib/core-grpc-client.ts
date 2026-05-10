/**
 * gRPC client (Node side) — Phase A 설정.
 *
 * Next.js API route (app/api/core/[method]/route.ts, 향후) 가 이 client 통해 Rust Core 호출.
 * Frontend 는 fetch → API route → gRPC 패턴이라 browser 에서 gRPC 직접 사용 X.
 *
 * Phase A: dynamic proto loading (`@grpc/proto-loader`) — codegen 없이 runtime 파싱.
 *          간단 + 빠른 prototype. 단 TypeScript 타입은 `any` (Phase B 후속에서 ts-proto 또는
 *          @bufbuild/protoc-gen-es 도입해 typed stub 으로 swap 가능).
 *
 * Phase B: 매니저별 typed message 설정된 후 codegen typed stub 활용 검토.
 */

import * as grpcModule from '@grpc/grpc-js';
import * as protoLoaderModule from '@grpc/proto-loader';
import path from 'path';

type GrpcClient = any;

let cachedRoot: any = null;
let cachedClients: Map<string, GrpcClient> = new Map();

const PROTO_PATH = path.resolve(process.cwd(), 'proto/firebat.proto');
const DEFAULT_TARGET = process.env.FIREBAT_CORE_GRPC_TARGET ?? 'localhost:50051';

function loadProto(): any {
  if (cachedRoot) return cachedRoot;
  const packageDef = protoLoaderModule.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  cachedRoot = grpcModule.loadPackageDefinition(packageDef) as any;
  return cachedRoot;
}

/**
 * 매니저별 service client 생성. 캐시 — 같은 service 의 client 재사용.
 *
 * @param serviceName - proto 의 service 이름 (예: 'AiService' / 'PageService' / 'AuthService')
 * @param target      - gRPC 서버 주소 (default: localhost:50051 또는 FIREBAT_CORE_GRPC_TARGET env)
 */
export function getGrpcClient(serviceName: string, target: string = DEFAULT_TARGET): GrpcClient {
  const cacheKey = `${serviceName}@${target}`;
  const hit = cachedClients.get(cacheKey);
  if (hit) return hit;

  const root = loadProto();
  const ServiceCtor = root?.firebat?.v1?.[serviceName];
  if (!ServiceCtor) {
    throw new Error(`[core-grpc-client] unknown service: firebat.v1.${serviceName}`);
  }
  const client = new ServiceCtor(target, grpcModule.credentials.createInsecure());
  cachedClients.set(cacheKey, client);
  return client;
}

/**
 * RPC 호출 — promise 기반 wrapper.
 * @param serviceName - proto service 이름
 * @param methodName  - RPC method (camelCase, generated stub 의 method 명 그대로)
 * @param request     - request message (JsonArgs / JsonValue 등)
 */
export function callGrpcMethod<T = any>(
  serviceName: string,
  methodName: string,
  request: any,
  target?: string
): Promise<T> {
  const client = getGrpcClient(serviceName, target);
  return new Promise((resolve, reject) => {
    if (typeof client[methodName] !== 'function') {
      reject(new Error(`[core-grpc-client] unknown method: ${serviceName}.${methodName}`));
      return;
    }
    client[methodName](request, (err: any, response: T) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

/**
 * 헬스 체크 — Phase A 검증용. Rust gRPC server 가 띄워져 있을 때 동작 확인.
 */
export async function pingCore(target?: string): Promise<{ version: string; ready: boolean; uptime_ms: number }> {
  return callGrpcMethod('LifecycleService', 'Health', {}, target);
}

/**
 * 단일 진입점 — facade method 명 → service / RPC 매핑 + 호출.
 * Phase A: JsonArgs / JsonValue 단일 schema 라 method 매핑 단순.
 * Phase B: 매니저별 typed RPC 설정될 때 정밀 매핑 도입.
 *
 * @param method - facade method (camelCase, 예: 'savePage' / 'login' / 'listConversations')
 * @param args   - JSON-serializable 인자 (단일 객체)
 */
export async function invokeCore<T = unknown>(method: string, args?: unknown): Promise<T> {
  const { service, rpc } = resolveMethodToRpc(method);
  const request = { raw: JSON.stringify(args ?? null) };  // JsonArgs schema
  let response: any;
  try {
    response = await callGrpcMethod(service, rpc, request);
  } catch (err) {
    // gRPC ServiceError → ApiError 변환 (status code + redactor 통과 메시지)
    const { fromGrpcError } = await import('./api-error');
    throw fromGrpcError(err);
  }
  // JsonValue.raw → parse
  if (response && typeof response.raw === 'string') {
    return JSON.parse(response.raw) as T;
  }
  // RawJsonPb.raw_json (proto-loader keepCase:false → rawJson) → parse
  if (response && typeof response.rawJson === 'string') {
    return JSON.parse(response.rawJson) as T;
  }
  return response as T;
}

/**
 * facade method (예: 'savePage') → { service, rpc } 매핑.
 *
 * 명시 매핑 table — 옛 TS Core facade 의 21 매니저 모든 메서드 1:1.
 * Phase B-4 에서 sample prefix 추정 → 명시 table 으로 swap (정확성 ↑).
 *
 * 새 facade method 추가 시:
 *   1. 매니저별 RPC 정의 (proto 추가)
 *   2. 본 table 에 entry 추가
 *   3. 옛 in-process Core method 그대로 사용 — 호출자 코드 변경 0
 */
const METHOD_TABLE: Record<string, { service: string; rpc: string }> = {
  // ── PageService (PageManager) ─────────────────────────────────
  savePage: { service: 'PageService', rpc: 'Save' },
  getPage: { service: 'PageService', rpc: 'Get' },
  listPages: { service: 'PageService', rpc: 'List' },
  deletePage: { service: 'PageService', rpc: 'Delete' },
  searchPages: { service: 'PageService', rpc: 'Search' },
  setPageVisibility: { service: 'PageService', rpc: 'SetVisibility' },
  verifyPagePassword: { service: 'PageService', rpc: 'VerifyPassword' },
  renamePage: { service: 'PageService', rpc: 'Rename' },
  getPageRedirect: { service: 'PageService', rpc: 'GetRedirect' },
  listStaticPages: { service: 'PageService', rpc: 'ListStatic' },
  findMediaUsage: { service: 'PageService', rpc: 'FindMediaUsage' },
  findRelatedPages: { service: 'PageService', rpc: 'FindRelated' },
  listAllTags: { service: 'PageService', rpc: 'ListAllTags' },

  // ── ProjectService (ProjectManager) ───────────────────────────
  listProjects: { service: 'ProjectService', rpc: 'List' },
  getProject: { service: 'ProjectService', rpc: 'Get' },
  saveProject: { service: 'ProjectService', rpc: 'Save' },
  deleteProject: { service: 'ProjectService', rpc: 'Delete' },
  setProjectVisibility: { service: 'ProjectService', rpc: 'SetVisibility' },
  verifyProjectPassword: { service: 'ProjectService', rpc: 'VerifyPassword' },
  renameProject: { service: 'ProjectService', rpc: 'Rename' },
  scanProjects: { service: 'ProjectService', rpc: 'Scan' },
  getProjectVisibility: { service: 'ProjectService', rpc: 'GetVisibility' },
  getProjectConfig: { service: 'ProjectService', rpc: 'GetConfig' },
  setProjectConfig: { service: 'ProjectService', rpc: 'SetConfig' },

  // ── ModuleService (ModuleManager) ─────────────────────────────
  listSystemModules: { service: 'ModuleService', rpc: 'ListSystem' },
  listUserModules: { service: 'ModuleService', rpc: 'ListUser' },
  getSystemModules: { service: 'ModuleService', rpc: 'ListSystem' },   // alias
  getUserModules: { service: 'ModuleService', rpc: 'ListUser' },       // alias
  getModuleSchema: { service: 'ModuleService', rpc: 'GetSchema' },
  getModuleConfig: { service: 'ModuleService', rpc: 'GetConfig' },
  runModule: { service: 'ModuleService', rpc: 'Run' },
  sandboxExecute: { service: 'ModuleService', rpc: 'Run' },            // path 기반 실행 — 같은 Run RPC 활용
  setModuleEnabled: { service: 'ModuleService', rpc: 'SetEnabled' },
  isModuleEnabled: { service: 'ModuleService', rpc: 'IsEnabled' },
  setModuleSettings: { service: 'ModuleService', rpc: 'SetSettings' },
  getModuleSettings: { service: 'ModuleService', rpc: 'GetSettings' },
  getCmsSettings: { service: 'ModuleService', rpc: 'GetCmsSettings' },
  getKakaoMapJsKey: { service: 'ModuleService', rpc: 'GetKakaoMapJsKey' },

  // ── AiService 의 Pending / Plan store (옛 TS lib/{pending-tools,plan-store}.ts 통합) ──
  createPending: { service: 'AiService', rpc: 'CreatePending' },
  getPending: { service: 'AiService', rpc: 'GetPending' },
  consumePending: { service: 'AiService', rpc: 'ConsumePending' },
  rejectPending: { service: 'AiService', rpc: 'RejectPending' },
  storePlan: { service: 'AiService', rpc: 'StorePlan' },

  // ── ScheduleService (ScheduleManager) ─────────────────────────
  listCronJobs: { service: 'ScheduleService', rpc: 'ListCron' },
  scheduleTask: { service: 'ScheduleService', rpc: 'ScheduleCron' },
  scheduleCronJob: { service: 'ScheduleService', rpc: 'ScheduleCron' },   // alias
  cancelCronJob: { service: 'ScheduleService', rpc: 'CancelCron' },
  updateCronJob: { service: 'ScheduleService', rpc: 'UpdateCron' },
  runCronJobNow: { service: 'ScheduleService', rpc: 'RunNow' },
  getCronLogs: { service: 'ScheduleService', rpc: 'GetLogs' },
  clearCronLogs: { service: 'ScheduleService', rpc: 'ClearLogs' },
  consumeCronNotifications: { service: 'ScheduleService', rpc: 'ConsumeNotifications' },
  validatePipeline: { service: 'ScheduleService', rpc: 'ValidatePipeline' },

  // ── TaskService (TaskManager) ─────────────────────────────────
  runTask: { service: 'TaskService', rpc: 'Run' },

  // ── SecretService (SecretManager) ─────────────────────────────
  listUserSecrets: { service: 'SecretService', rpc: 'ListUser' },
  setUserSecret: { service: 'SecretService', rpc: 'SetUser' },
  getUserSecret: { service: 'SecretService', rpc: 'GetUser' },
  deleteUserSecret: { service: 'SecretService', rpc: 'DeleteUser' },
  listUserModuleSecrets: { service: 'SecretService', rpc: 'ListUserModuleSecrets' },
  getVertexKey: { service: 'SecretService', rpc: 'GetSystem' },     // system:vertex-key Vault key
  setVertexKey: { service: 'SecretService', rpc: 'SetSystem' },
  getGeminiKey: { service: 'SecretService', rpc: 'GetSystem' },     // system:gemini-key Vault key
  setGeminiKey: { service: 'SecretService', rpc: 'SetSystem' },

  // ── McpService (McpManager) ───────────────────────────────────
  listMcpServers: { service: 'McpService', rpc: 'ListServers' },
  saveMcpServer: { service: 'McpService', rpc: 'SaveServer' },
  removeMcpServer: { service: 'McpService', rpc: 'RemoveServer' },
  listMcpTools: { service: 'McpService', rpc: 'ListTools' },
  callMcpTool: { service: 'McpService', rpc: 'CallTool' },
  generateMcpToken: { service: 'McpService', rpc: 'GenerateToken' },
  validateMcpToken: { service: 'McpService', rpc: 'ValidateToken' },
  revokeMcpToken: { service: 'McpService', rpc: 'RevokeToken' },
  getMcpTokenInfo: { service: 'McpService', rpc: 'GetTokenInfo' },

  // ── CapabilityService (CapabilityManager) ─────────────────────
  listCapabilities: { service: 'CapabilityService', rpc: 'List' },
  getCapabilityProviders: { service: 'CapabilityService', rpc: 'GetProviders' },
  listCapabilitiesWithProviders: {
    service: 'CapabilityService',
    rpc: 'ListWithProviders',
  },
  resolveCapability: { service: 'CapabilityService', rpc: 'Resolve' },
  registerCapability: { service: 'CapabilityService', rpc: 'Register' },
  getCapabilitySettings: { service: 'CapabilityService', rpc: 'GetSettings' },
  setCapabilitySettings: { service: 'CapabilityService', rpc: 'SetSettings' },

  // ── AuthService (AuthManager) ─────────────────────────────────
  login: { service: 'AuthService', rpc: 'Login' },
  logout: { service: 'AuthService', rpc: 'Logout' },
  validateSession: { service: 'AuthService', rpc: 'ValidateSession' },
  validateToken: { service: 'AuthService', rpc: 'ValidateToken' },
  generateApiToken: { service: 'AuthService', rpc: 'GenerateApiToken' },
  validateApiToken: { service: 'AuthService', rpc: 'ValidateApiToken' },
  revokeApiTokens: { service: 'AuthService', rpc: 'RevokeApiTokens' },
  getApiTokenInfo: { service: 'AuthService', rpc: 'GetApiTokenInfo' },
  getAdminCredentials: { service: 'AuthService', rpc: 'GetAdminCredentials' },
  setAdminCredentials: { service: 'AuthService', rpc: 'SetAdminCredentials' },
  isAdminSetup: { service: 'AuthService', rpc: 'IsAdminSetup' },
  verifyAdminPassword: { service: 'AuthService', rpc: 'VerifyAdminPassword' },
  validatePasswordPolicy: { service: 'AuthService', rpc: 'ValidatePasswordPolicy' },

  // ── ConversationService (ConversationManager) ─────────────────
  listConversations: { service: 'ConversationService', rpc: 'List' },
  getConversation: { service: 'ConversationService', rpc: 'Get' },
  saveConversation: { service: 'ConversationService', rpc: 'Save' },
  deleteConversation: { service: 'ConversationService', rpc: 'Delete' },
  isConversationDeleted: { service: 'ConversationService', rpc: 'IsDeleted' },
  searchHistory: { service: 'ConversationService', rpc: 'SearchHistory' },
  searchConversationHistory: { service: 'ConversationService', rpc: 'SearchHistory' },  // alias
  getCliSession: { service: 'ConversationService', rpc: 'GetCliSession' },
  setCliSession: { service: 'ConversationService', rpc: 'SetCliSession' },
  createShare: { service: 'ConversationService', rpc: 'CreateShare' },
  getShare: { service: 'ConversationService', rpc: 'GetShare' },

  // ── MediaService (MediaManager — image_gen + 갤러리) ──────────
  generateImage: { service: 'MediaService', rpc: 'Generate' },
  startImageGeneration: { service: 'MediaService', rpc: 'StartGeneration' },
  regenerateImage: { service: 'MediaService', rpc: 'Regenerate' },
  removeMedia: { service: 'MediaService', rpc: 'Remove' },
  readMedia: { service: 'MediaService', rpc: 'Read' },
  listMedia: { service: 'MediaService', rpc: 'List' },
  isMediaReady: { service: 'MediaService', rpc: 'IsReady' },
  saveUpload: { service: 'MediaService', rpc: 'Save' },
  getImageModel: { service: 'MediaService', rpc: 'GetImageModel' },
  setImageModel: { service: 'MediaService', rpc: 'SetImageModel' },
  listImageModels: { service: 'MediaService', rpc: 'GetAvailableImageModels' },
  getAvailableImageModels: { service: 'MediaService', rpc: 'GetAvailableImageModels' },
  getImageDefaultSize: { service: 'MediaService', rpc: 'GetImageDefaultSize' },
  setImageDefaultSize: { service: 'MediaService', rpc: 'SetImageDefaultSize' },
  getImageDefaultQuality: { service: 'MediaService', rpc: 'GetImageDefaultQuality' },
  setImageDefaultQuality: { service: 'MediaService', rpc: 'SetImageDefaultQuality' },
  getImageSettings: { service: 'MediaService', rpc: 'GetImageSettings' },

  // ── TemplateService (TemplateManager) ─────────────────────────
  listTemplates: { service: 'TemplateService', rpc: 'List' },
  getTemplate: { service: 'TemplateService', rpc: 'Get' },
  saveTemplate: { service: 'TemplateService', rpc: 'Save' },
  deleteTemplate: { service: 'TemplateService', rpc: 'Delete' },

  // ── EntityService (EntityManager — 메모리 4-tier Phase 1) ─────
  saveEntity: { service: 'EntityService', rpc: 'Save' },
  updateEntity: { service: 'EntityService', rpc: 'Update' },
  deleteEntity: { service: 'EntityService', rpc: 'Delete' },
  getEntity: { service: 'EntityService', rpc: 'Get' },
  findEntityByName: { service: 'EntityService', rpc: 'FindByName' },
  searchEntities: { service: 'EntityService', rpc: 'Search' },
  saveEntityFact: { service: 'EntityService', rpc: 'SaveFact' },
  updateEntityFact: { service: 'EntityService', rpc: 'UpdateFact' },
  deleteEntityFact: { service: 'EntityService', rpc: 'DeleteFact' },
  getEntityTimeline: { service: 'EntityService', rpc: 'GetTimeline' },
  searchEntityFacts: { service: 'EntityService', rpc: 'SearchFacts' },
  retrieveContext: { service: 'EntityService', rpc: 'RetrieveContext' },

  // ── EpisodicService (EpisodicManager — 메모리 4-tier Phase 2) ─
  saveEvent: { service: 'EpisodicService', rpc: 'Save' },
  updateEvent: { service: 'EpisodicService', rpc: 'Update' },
  deleteEvent: { service: 'EpisodicService', rpc: 'Delete' },
  getEvent: { service: 'EpisodicService', rpc: 'Get' },
  searchEvents: { service: 'EpisodicService', rpc: 'Search' },
  listRecentEvents: { service: 'EpisodicService', rpc: 'ListRecent' },
  listEventsByEntity: { service: 'EpisodicService', rpc: 'ListByEntity' },
  linkEventEntity: { service: 'EpisodicService', rpc: 'LinkEntity' },
  unlinkEventEntity: { service: 'EpisodicService', rpc: 'UnlinkEntity' },

  // ── ConsolidationService (ConsolidationManager — 메모리 4-tier Phase 4) ─
  consolidateConversation: { service: 'ConsolidationService', rpc: 'Consolidate' },
  consolidateInactive: { service: 'ConsolidationService', rpc: 'ConsolidateInactive' },
  getMemoryStats: { service: 'ConsolidationService', rpc: 'GetMemoryStats' },
  askLlmText: { service: 'ConsolidationService', rpc: 'AskLlmText' },

  // ── CostService (CostManager) ─────────────────────────────────
  getLlmCostStats: { service: 'CostService', rpc: 'GetStats' },
  flushCost: { service: 'CostService', rpc: 'Flush' },
  getCostBudget: { service: 'CostService', rpc: 'GetBudget' },
  setCostBudget: { service: 'CostService', rpc: 'SetBudget' },
  checkCostBudget: { service: 'CostService', rpc: 'CheckBudget' },

  // ── EventService (EventManager — SSE) ─────────────────────────
  listAuditLog: { service: 'EventService', rpc: 'ListAuditLog' },

  // ── StatusService (StatusManager — long-running 가시화) ───────
  startJob: { service: 'StatusService', rpc: 'Start' },
  updateJob: { service: 'StatusService', rpc: 'Update' },
  completeJob: { service: 'StatusService', rpc: 'Complete' },
  failJob: { service: 'StatusService', rpc: 'Fail' },
  getJob: { service: 'StatusService', rpc: 'Get' },
  listActiveJobs: { service: 'StatusService', rpc: 'List' },
  getJobStats: { service: 'StatusService', rpc: 'Stats' },

  // ── ToolService (ToolManager — 도구 dispatch) ─────────────────
  listTools: { service: 'ToolService', rpc: 'List' },
  getToolStats: { service: 'ToolService', rpc: 'GetStats' },
  executeTool: { service: 'ToolService', rpc: 'Execute' },

  // ── AiService (AiManager) ─────────────────────────────────────
  requestActionWithTools: { service: 'AiService', rpc: 'RequestActionWithTools' },
  codeAssist: { service: 'AiService', rpc: 'CodeAssist' },
  resolveCallTarget: { service: 'AiService', rpc: 'ResolveCallTarget' },
  spawnSubAgent: { service: 'AiService', rpc: 'SpawnSubAgent' },
  isSubAgentEnabled: { service: 'AiService', rpc: 'IsSubAgentEnabled' },
  setSubAgentEnabled: { service: 'AiService', rpc: 'SetSubAgentEnabled' },
  runAgentJob: { service: 'AiService', rpc: 'RunAgentJob' },

  // ── StorageService (IStoragePort 직접) ───────────────────────
  readFile: { service: 'StorageService', rpc: 'ReadFile' },
  readFileBinary: { service: 'StorageService', rpc: 'ReadFileBinary' },
  writeFile: { service: 'StorageService', rpc: 'WriteFile' },
  deleteFile: { service: 'StorageService', rpc: 'DeleteFile' },
  listDir: { service: 'StorageService', rpc: 'ListDir' },
  listFiles: { service: 'StorageService', rpc: 'ListFiles' },
  getFileTree: { service: 'StorageService', rpc: 'GetFileTree' },
  globFiles: { service: 'StorageService', rpc: 'GlobFiles' },

  // ── DatabaseService (IDatabasePort 직접) ──────────────────────
  queryDatabase: { service: 'DatabaseService', rpc: 'Query' },

  // ── NetworkService (INetworkPort 직접) ────────────────────────
  networkFetch: { service: 'NetworkService', rpc: 'Fetch' },

  // ── SettingsService (Vault flat key 헬퍼) ────────────────────
  getTimezone: { service: 'SettingsService', rpc: 'GetTimezone' },
  setTimezone: { service: 'SettingsService', rpc: 'SetTimezone' },
  getAiModel: { service: 'SettingsService', rpc: 'GetAiModel' },
  setAiModel: { service: 'SettingsService', rpc: 'SetAiModel' },
  getAiThinkingLevel: { service: 'SettingsService', rpc: 'GetAiThinkingLevel' },
  setAiThinkingLevel: { service: 'SettingsService', rpc: 'SetAiThinkingLevel' },
  getUserPrompt: { service: 'SettingsService', rpc: 'GetUserPrompt' },
  setUserPrompt: { service: 'SettingsService', rpc: 'SetUserPrompt' },
  getAnthropicCacheEnabled: { service: 'SettingsService', rpc: 'GetAnthropicCacheEnabled' },
  setAnthropicCacheEnabled: { service: 'SettingsService', rpc: 'SetAnthropicCacheEnabled' },
  getLastModelByCategory: { service: 'SettingsService', rpc: 'GetLastModelByCategory' },
  setLastModelByCategory: { service: 'SettingsService', rpc: 'SetLastModelByCategory' },
  getAiAssistantModel: { service: 'SettingsService', rpc: 'GetAiAssistantModel' },
  setAiAssistantModel: { service: 'SettingsService', rpc: 'SetAiAssistantModel' },
  getAiAssistantDefault: { service: 'SettingsService', rpc: 'GetAiAssistantDefault' },
  getAvailableAiAssistantModels: { service: 'SettingsService', rpc: 'GetAvailableAiAssistantModels' },
  getAvailableAiModels: { service: 'SettingsService', rpc: 'GetAvailableAiModels' },

  // ── CacheService (Phase 2 sysmod result cache) ───────────────
  cacheData: { service: 'CacheService', rpc: 'Read' },     // proto: 'Read' RPC
  cacheRead: { service: 'CacheService', rpc: 'Read' },
  cacheGrep: { service: 'CacheService', rpc: 'Grep' },
  cacheAggregate: { service: 'CacheService', rpc: 'Aggregate' },
  cacheDrop: { service: 'CacheService', rpc: 'Drop' },

  // ── TelegramService (sysmod_telegram bot webhook) ────────────
  processTelegramMessage: { service: 'TelegramService', rpc: 'ProcessMessage' },
  setupTelegramWebhook: { service: 'TelegramService', rpc: 'SetupWebhook' },
  removeTelegramWebhook: { service: 'TelegramService', rpc: 'RemoveWebhook' },
  getTelegramWebhookStatus: { service: 'TelegramService', rpc: 'GetWebhookStatus' },
  getTelegramWebhookSecret: { service: 'TelegramService', rpc: 'GetWebhookSecret' },
  isTelegramOwner: { service: 'TelegramService', rpc: 'IsOwner' },

  // ── McpService — 추가 매핑 (옛 entry 보강) ───────────────────
  addMcpServer: { service: 'McpService', rpc: 'AddServer' },
  listAllMcpTools: { service: 'McpService', rpc: 'ListAllTools' },

  // ── EpisodicService — 추가 매핑 ───────────────────────────────
  cleanupExpiredEvents: { service: 'EpisodicService', rpc: 'CleanupExpired' },

  // ── EntityService — 추가 매핑 ─────────────────────────────────
  getEntityFact: { service: 'EntityService', rpc: 'GetFact' },
  cleanupExpiredFacts: { service: 'EntityService', rpc: 'CleanupExpiredFacts' },

  // ── MemoryService (memory file) ──────────────────────────────
  getMemoryIndex: { service: 'MemoryService', rpc: 'GetIndex' },
  readMemoryFile: { service: 'MemoryService', rpc: 'ReadFile' },
  listMemoryFiles: { service: 'MemoryService', rpc: 'ListFiles' },
  saveMemoryFile: { service: 'MemoryService', rpc: 'SaveFile' },
  deleteMemoryFile: { service: 'MemoryService', rpc: 'DeleteFile' },

  // ── ConversationService — 추가 매핑 ──────────────────────────
  cleanupExpiredShares: { service: 'ConversationService', rpc: 'CleanupExpiredShares' },

  // ── LifecycleService (Health / Shutdown) ─────────────────────
  health: { service: 'LifecycleService', rpc: 'Health' },
  captureException: { service: 'LifecycleService', rpc: 'CaptureException' },
  gracefulShutdown: { service: 'LifecycleService', rpc: 'GracefulShutdown' },
};

function resolveMethodToRpc(method: string): { service: string; rpc: string } {
  const direct = METHOD_TABLE[method];
  if (direct) return direct;
  // fallback — table 미등록 method. PascalCase 으로 LifecycleService 폴백.
  // 새 facade method 추가 시 본 table 에 등록 필요 — 폴백은 안전망.
  return {
    service: 'LifecycleService',
    rpc: method.charAt(0).toUpperCase() + method.slice(1),
  };
}

/**
 * gRPC typed client (Phase B-typed cutover, 2026-05-12).
 *
 * proto-loader dynamic schema 폐기 + @connectrpc/connect-node 의 typed client 사용.
 * 자동 생성된 lib/proto-gen/firebat_pb.ts 의 28 GenService descriptor 활용.
 *
 * 사용 패턴 (옛 `getCore().savePage(slug, spec)` 대신):
 *   ```ts
 *   import { pageClient } from "@/lib/grpc-typed-client";
 *   const res = await pageClient.save({ slug, spec, status: "published" });
 *   ```
 *
 * 각 client 호출 시 typed Request message + camelCase field 명. TypeScript 가 컴파일 단
 * 에서 field 명 mismatch / 타입 mismatch 즉시 차단. 옛 ARGS_TABLE manual wrapper 의
 * silent fail 패턴 영구 차단.
 *
 * Phase E 와 무관 — gRPC :50051 직접 호출 (MCP 와 별개 channel).
 */

import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  AiService,
  AuthService,
  CacheService,
  CapabilityService,
  ConsolidationService,
  ConversationService,
  CostService,
  DatabaseService,
  EntityService,
  EpisodicService,
  EventService,
  LifecycleService,
  McpService,
  MediaService,
  MemoryService,
  ModuleService,
  NetworkService,
  PageService,
  ProjectService,
  ScheduleService,
  SecretService,
  SettingsService,
  StatusService,
  StorageService,
  TaskService,
  TelegramService,
  TemplateService,
  ToolService,
} from "./proto-gen/firebat_pb";

/**
 * gRPC transport — firebat-core Rust binary (default 127.0.0.1:50051).
 * FIREBAT_CORE_GRPC env 으로 호스트:포트 override (docker compose 등에서 firebat-core:50051).
 */
const grpcBaseUrl = process.env.FIREBAT_CORE_GRPC
  ? `http://${process.env.FIREBAT_CORE_GRPC}`
  : "http://127.0.0.1:50051";

const transport = createGrpcTransport({
  baseUrl: grpcBaseUrl,
});

/**
 * 28 service typed client. 각 client 의 메서드는 자동 생성된 typed message 받음.
 * 예: `pageClient.save({slug, spec, status, project, visibility, password})`.
 * Optional field 는 undefined / 생략 모두 OK.
 */
// ────────────────────────────────────────────────────────────────────────────
// facade method (옛 `getCore().savePage()`) → typed client routing.
// METHOD_TABLE 박지 않고 service × method 명 직접 매핑 — 일반 로직.
// ────────────────────────────────────────────────────────────────────────────

/**
 * 옛 facade method (예: 'savePage') → { service, rpc } 매핑.
 * Phase B-typed cutover (2026-05-12) — 호출 site 변경 0 으로 옛 패턴 유지.
 */
const METHOD_TABLE: Record<string, { service: string; rpc: string }> = {
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
  listProjects: { service: 'ProjectService', rpc: 'Scan' },
  scanProjects: { service: 'ProjectService', rpc: 'Scan' },
  getProjectVisibility: { service: 'ProjectService', rpc: 'GetVisibility' },
  setProjectVisibility: { service: 'ProjectService', rpc: 'SetVisibility' },
  getProjectConfig: { service: 'ProjectService', rpc: 'GetConfig' },
  setProjectConfig: { service: 'ProjectService', rpc: 'SetConfig' },
  verifyProjectPassword: { service: 'ProjectService', rpc: 'VerifyPassword' },
  deleteProject: { service: 'ProjectService', rpc: 'Delete' },
  renameProject: { service: 'ProjectService', rpc: 'Rename' },
  listSystemModules: { service: 'ModuleService', rpc: 'ListSystem' },
  listUserModules: { service: 'ModuleService', rpc: 'ListUser' },
  getSystemModules: { service: 'ModuleService', rpc: 'ListSystem' },
  getUserModules: { service: 'ModuleService', rpc: 'ListUser' },
  getModuleSchema: { service: 'ModuleService', rpc: 'GetSchema' },
  getModuleConfig: { service: 'ModuleService', rpc: 'GetConfig' },
  runModule: { service: 'ModuleService', rpc: 'Run' },
  sandboxExecute: { service: 'ModuleService', rpc: 'Run' },
  setModuleEnabled: { service: 'ModuleService', rpc: 'SetEnabled' },
  isModuleEnabled: { service: 'ModuleService', rpc: 'IsEnabled' },
  setModuleSettings: { service: 'ModuleService', rpc: 'SetSettings' },
  getModuleSettings: { service: 'ModuleService', rpc: 'GetSettings' },
  getCmsSettings: { service: 'ModuleService', rpc: 'GetCmsSettings' },
  getKakaoMapJsKey: { service: 'ModuleService', rpc: 'GetKakaoMapJsKey' },
  runTask: { service: 'TaskService', rpc: 'Run' },
  listCronJobs: { service: 'ScheduleService', rpc: 'ListCron' },
  scheduleTask: { service: 'ScheduleService', rpc: 'ScheduleCron' },
  scheduleCronJob: { service: 'ScheduleService', rpc: 'ScheduleCron' },
  cancelCronJob: { service: 'ScheduleService', rpc: 'CancelCron' },
  updateCronJob: { service: 'ScheduleService', rpc: 'UpdateCron' },
  runCronJobNow: { service: 'ScheduleService', rpc: 'RunNow' },
  getCronLogs: { service: 'ScheduleService', rpc: 'GetLogs' },
  clearCronLogs: { service: 'ScheduleService', rpc: 'ClearLogs' },
  consumeCronNotifications: { service: 'ScheduleService', rpc: 'ConsumeNotifications' },
  validatePipeline: { service: 'ScheduleService', rpc: 'ValidatePipeline' },
  listUserSecrets: { service: 'SecretService', rpc: 'ListUser' },
  setUserSecret: { service: 'SecretService', rpc: 'SetUser' },
  getUserSecret: { service: 'SecretService', rpc: 'GetUser' },
  deleteUserSecret: { service: 'SecretService', rpc: 'DeleteUser' },
  listUserModuleSecrets: { service: 'SecretService', rpc: 'ListUserModuleSecrets' },
  getVertexKey: { service: 'SecretService', rpc: 'GetSystem' },
  setVertexKey: { service: 'SecretService', rpc: 'SetSystem' },
  getGeminiKey: { service: 'SecretService', rpc: 'GetSystem' },
  setGeminiKey: { service: 'SecretService', rpc: 'SetSystem' },
  listMcpServers: { service: 'McpService', rpc: 'ListServers' },
  saveMcpServer: { service: 'McpService', rpc: 'AddServer' },
  addMcpServer: { service: 'McpService', rpc: 'AddServer' },
  removeMcpServer: { service: 'McpService', rpc: 'RemoveServer' },
  listMcpTools: { service: 'McpService', rpc: 'ListTools' },
  listAllMcpTools: { service: 'McpService', rpc: 'ListAllTools' },
  callMcpTool: { service: 'McpService', rpc: 'CallTool' },
  listCapabilities: { service: 'CapabilityService', rpc: 'List' },
  getCapabilityProviders: { service: 'CapabilityService', rpc: 'GetProviders' },
  listCapabilitiesWithProviders: { service: 'CapabilityService', rpc: 'ListWithProviders' },
  resolveCapability: { service: 'CapabilityService', rpc: 'Resolve' },
  registerCapability: { service: 'CapabilityService', rpc: 'Register' },
  getCapabilitySettings: { service: 'CapabilityService', rpc: 'GetSettings' },
  setCapabilitySettings: { service: 'CapabilityService', rpc: 'SetSettings' },
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
  listConversations: { service: 'ConversationService', rpc: 'List' },
  getConversation: { service: 'ConversationService', rpc: 'Get' },
  saveConversation: { service: 'ConversationService', rpc: 'Save' },
  deleteConversation: { service: 'ConversationService', rpc: 'Delete' },
  isConversationDeleted: { service: 'ConversationService', rpc: 'IsDeleted' },
  searchHistory: { service: 'ConversationService', rpc: 'SearchHistory' },
  searchConversationHistory: { service: 'ConversationService', rpc: 'SearchHistory' },
  getCliSession: { service: 'ConversationService', rpc: 'GetCliSession' },
  setCliSession: { service: 'ConversationService', rpc: 'SetCliSession' },
  createShare: { service: 'ConversationService', rpc: 'CreateShare' },
  getShare: { service: 'ConversationService', rpc: 'GetShare' },
  listDeletedConversations: { service: 'ConversationService', rpc: 'ListDeleted' },
  restoreConversation: { service: 'ConversationService', rpc: 'Restore' },
  permanentDeleteConversation: { service: 'ConversationService', rpc: 'PermanentDelete' },
  cleanupOldDeletedConversations: { service: 'ConversationService', rpc: 'CleanupOldDeleted' },
  cleanupExpiredShares: { service: 'ConversationService', rpc: 'CleanupExpiredShares' },
  generateImage: { service: 'MediaService', rpc: 'Generate' },
  startImageGeneration: { service: 'MediaService', rpc: 'StartGeneration' },
  regenerateImage: { service: 'MediaService', rpc: 'Regenerate' },
  removeMedia: { service: 'MediaService', rpc: 'Remove' },
  readMedia: { service: 'MediaService', rpc: 'Read' },
  listMedia: { service: 'MediaService', rpc: 'List' },
  isMediaReady: { service: 'MediaService', rpc: 'IsReady' },
  saveUpload: { service: 'MediaService', rpc: 'Save' },
  saveTempAttachment: { service: 'MediaService', rpc: 'SaveTempAttachment' },
  cleanupOldAttachments: { service: 'MediaService', rpc: 'CleanupOldAttachments' },
  getImageModel: { service: 'MediaService', rpc: 'GetImageModel' },
  setImageModel: { service: 'MediaService', rpc: 'SetImageModel' },
  listImageModels: { service: 'MediaService', rpc: 'GetAvailableImageModels' },
  getAvailableImageModels: { service: 'MediaService', rpc: 'GetAvailableImageModels' },
  getImageDefaultSize: { service: 'MediaService', rpc: 'GetImageDefaultSize' },
  setImageDefaultSize: { service: 'MediaService', rpc: 'SetImageDefaultSize' },
  getImageDefaultQuality: { service: 'MediaService', rpc: 'GetImageDefaultQuality' },
  setImageDefaultQuality: { service: 'MediaService', rpc: 'SetImageDefaultQuality' },
  getImageSettings: { service: 'MediaService', rpc: 'GetImageSettings' },
  processAi: { service: 'AiService', rpc: 'Process' },
  requestActionWithTools: { service: 'AiService', rpc: 'RequestActionWithTools' },
  codeAssist: { service: 'AiService', rpc: 'CodeAssist' },
  runAgentJob: { service: 'AiService', rpc: 'RunAgentJob' },
  resolveCallTarget: { service: 'AiService', rpc: 'ResolveCallTarget' },
  spawnSubAgent: { service: 'AiService', rpc: 'SpawnSubAgent' },
  isSubAgentEnabled: { service: 'AiService', rpc: 'IsSubAgentEnabled' },
  setSubAgentEnabled: { service: 'AiService', rpc: 'SetSubAgentEnabled' },
  createPending: { service: 'AiService', rpc: 'CreatePending' },
  getPending: { service: 'AiService', rpc: 'GetPending' },
  consumePending: { service: 'AiService', rpc: 'ConsumePending' },
  rejectPending: { service: 'AiService', rpc: 'RejectPending' },
  storePlan: { service: 'AiService', rpc: 'StorePlan' },
  readFile: { service: 'StorageService', rpc: 'ReadFile' },
  readFileBinary: { service: 'StorageService', rpc: 'ReadFileBinary' },
  writeFile: { service: 'StorageService', rpc: 'WriteFile' },
  appendFile: { service: 'StorageService', rpc: 'WriteFile' },
  deleteFile: { service: 'StorageService', rpc: 'DeleteFile' },
  listDir: { service: 'StorageService', rpc: 'ListDir' },
  listFiles: { service: 'StorageService', rpc: 'ListFiles' },
  getFileTree: { service: 'StorageService', rpc: 'GetFileTree' },
  globFiles: { service: 'StorageService', rpc: 'GlobFiles' },
  saveEntity: { service: 'EntityService', rpc: 'Save' },
  updateEntity: { service: 'EntityService', rpc: 'Update' },
  deleteEntity: { service: 'EntityService', rpc: 'Delete' },
  getEntity: { service: 'EntityService', rpc: 'Get' },
  findEntityByName: { service: 'EntityService', rpc: 'FindByName' },
  searchEntities: { service: 'EntityService', rpc: 'Search' },
  saveEntityFact: { service: 'EntityService', rpc: 'SaveFact' },
  updateEntityFact: { service: 'EntityService', rpc: 'UpdateFact' },
  deleteEntityFact: { service: 'EntityService', rpc: 'DeleteFact' },
  getEntityFact: { service: 'EntityService', rpc: 'GetFact' },
  getEntityTimeline: { service: 'EntityService', rpc: 'GetTimeline' },
  searchEntityFacts: { service: 'EntityService', rpc: 'SearchFacts' },
  retrieveContext: { service: 'EntityService', rpc: 'RetrieveContext' },
  cleanupExpiredFacts: { service: 'EntityService', rpc: 'CleanupExpiredFacts' },
  saveEvent: { service: 'EpisodicService', rpc: 'SaveEvent' },
  updateEvent: { service: 'EpisodicService', rpc: 'UpdateEvent' },
  deleteEvent: { service: 'EpisodicService', rpc: 'DeleteEvent' },
  getEvent: { service: 'EpisodicService', rpc: 'GetEvent' },
  searchEvents: { service: 'EpisodicService', rpc: 'SearchEvents' },
  listRecentEvents: { service: 'EpisodicService', rpc: 'ListRecent' },
  listEventsByEntity: { service: 'EpisodicService', rpc: 'ListByEntity' },
  linkEventEntity: { service: 'EpisodicService', rpc: 'LinkEntity' },
  unlinkEventEntity: { service: 'EpisodicService', rpc: 'UnlinkEntity' },
  cleanupExpiredEvents: { service: 'EpisodicService', rpc: 'CleanupExpired' },
  askLlmText: { service: 'ConsolidationService', rpc: 'AskLlmText' },
  consolidate: { service: 'ConsolidationService', rpc: 'Consolidate' },
  consolidateInactive: { service: 'ConsolidationService', rpc: 'ConsolidateInactive' },
  getMemoryStats: { service: 'ConsolidationService', rpc: 'GetMemoryStats' },
  listTemplates: { service: 'TemplateService', rpc: 'List' },
  getTemplate: { service: 'TemplateService', rpc: 'Get' },
  saveTemplate: { service: 'TemplateService', rpc: 'Save' },
  deleteTemplate: { service: 'TemplateService', rpc: 'Delete' },
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
  networkFetch: { service: 'NetworkService', rpc: 'Fetch' },
  cacheRead: { service: 'CacheService', rpc: 'Read' },
  cacheGrep: { service: 'CacheService', rpc: 'Grep' },
  cacheAggregate: { service: 'CacheService', rpc: 'Aggregate' },
  cacheDrop: { service: 'CacheService', rpc: 'Drop' },
  setupTelegramWebhook: { service: 'TelegramService', rpc: 'SetupWebhook' },
  removeTelegramWebhook: { service: 'TelegramService', rpc: 'RemoveWebhook' },
  getTelegramWebhookStatus: { service: 'TelegramService', rpc: 'GetWebhookStatus' },
  isTelegramOwner: { service: 'TelegramService', rpc: 'IsOwner' },
  getTelegramWebhookSecret: { service: 'TelegramService', rpc: 'GetWebhookSecret' },
  processTelegramMessage: { service: 'TelegramService', rpc: 'ProcessMessage' },
  queryDatabase: { service: 'DatabaseService', rpc: 'Query' },
  getMemoryIndex: { service: 'MemoryService', rpc: 'GetIndex' },
  readMemoryFile: { service: 'MemoryService', rpc: 'ReadFile' },
  listMemoryFiles: { service: 'MemoryService', rpc: 'ListFiles' },
  saveMemoryFile: { service: 'MemoryService', rpc: 'SaveFile' },
  deleteMemoryFile: { service: 'MemoryService', rpc: 'DeleteFile' },
  health: { service: 'LifecycleService', rpc: 'Health' },
  captureException: { service: 'LifecycleService', rpc: 'CaptureException' },
  gracefulShutdown: { service: 'LifecycleService', rpc: 'GracefulShutdown' },
  getCostStats: { service: 'CostService', rpc: 'GetStats' },
  flushCost: { service: 'CostService', rpc: 'Flush' },
  getCostBudget: { service: 'CostService', rpc: 'GetBudget' },
  setCostBudget: { service: 'CostService', rpc: 'SetBudget' },
  checkCostBudget: { service: 'CostService', rpc: 'CheckBudget' },
  registerTool: { service: 'ToolService', rpc: 'Register' },
  registerToolsMany: { service: 'ToolService', rpc: 'RegisterMany' },
  unregisterTool: { service: 'ToolService', rpc: 'Unregister' },
  getToolDefinition: { service: 'ToolService', rpc: 'GetDefinition' },
  listTools: { service: 'ToolService', rpc: 'List' },
  executeTool: { service: 'ToolService', rpc: 'Execute' },
  buildAiToolDefinitions: { service: 'ToolService', rpc: 'BuildAiDefinitions' },
  buildMcpToolDescriptions: { service: 'ToolService', rpc: 'BuildMcpDescriptions' },
  getToolStats: { service: 'ToolService', rpc: 'GetStats' },
  getActivePlanState: { service: 'ToolService', rpc: 'GetActivePlanState' },
  setActivePlanState: { service: 'ToolService', rpc: 'SetActivePlanState' },
  clearActivePlanState: { service: 'ToolService', rpc: 'ClearActivePlanState' },
  listAuditLog: { service: 'EventService', rpc: 'ListAuditLog' },
  startJob: { service: 'StatusService', rpc: 'Start' },
  updateJob: { service: 'StatusService', rpc: 'Update' },
  completeJob: { service: 'StatusService', rpc: 'Complete' },
  failJob: { service: 'StatusService', rpc: 'Fail' },
  getJob: { service: 'StatusService', rpc: 'Get' },
  listJobs: { service: 'StatusService', rpc: 'List' },
  getJobStats: { service: 'StatusService', rpc: 'Stats' },
};

const CLIENT_MAP: Record<string, any> = {};

function getClient(service: string): any {
  if (CLIENT_MAP[service]) return CLIENT_MAP[service];
  const key = service.charAt(0).toLowerCase() + service.slice(1).replace(/Service$/, 'Client');
  const all = exportedClients();
  const client = all[key];
  if (!client) throw new Error(`[grpc-typed-client] unknown service: ${service}`);
  CLIENT_MAP[service] = client;
  return client;
}

/** facade method (예: 'savePage') → typed client method 직접 호출. */
export async function callTypedClient<T = unknown>(method: string, args: unknown): Promise<T> {
  const entry = METHOD_TABLE[method];
  if (!entry) throw new Error(`[callTypedClient] unknown facade method: ${method}`);
  const client = getClient(entry.service);
  const methodName = entry.rpc.charAt(0).toLowerCase() + entry.rpc.slice(1);
  const fn = client[methodName];
  if (typeof fn !== 'function') {
    throw new Error(`[callTypedClient] no method ${entry.service}.${methodName}`);
  }
  let request: any;
  if (args === undefined || args === null) request = {};
  else if (typeof args === 'string') request = { value: args };
  else if (typeof args === 'number') request = { value: args };
  else if (typeof args === 'boolean') request = { value: args };
  else request = args;
  let response: any;
  try {
    response = await fn.call(client, request);
  } catch (err) {
    const { fromGrpcError } = await import('./api-error');
    throw fromGrpcError(err);
  }
  // RawJsonPb / OptionalStringPb / 단일 value wrapper 자동 unwrap.
  if (response && typeof response.rawJson === 'string') {
    return JSON.parse(response.rawJson) as T;
  }
  if (response && typeof response === 'object' && 'present' in response && 'value' in response) {
    return (response.present ? response.value : null) as T;
  }
  if (
    response &&
    typeof response === 'object' &&
    Object.keys(response).length === 1 &&
    'value' in response
  ) {
    return response.value as T;
  }
  // 옛 ProjectListPb {projects} / ConversationListPb {conversations} 등 — 단일 array field 자동 unwrap.
  // proto 의 repeated 필드 message 가 호출자 입장에선 array 자체로 보여야 자연 — 호출 site cutover 부담 0.
  if (response && typeof response === 'object') {
    const keys = Object.keys(response);
    if (keys.length === 1) {
      const onlyVal = (response as Record<string, unknown>)[keys[0]!];
      if (Array.isArray(onlyVal)) return onlyVal as T;
    }
  }
  return response as T;
}

// ────────────────────────────────────────────────────────────────────────────
// typed client instances — 28 services. callTypedClient 가 자동 dispatch.
// 호출 site 에서 직접 import 가능 (예: pageClient.save({...})).
// ────────────────────────────────────────────────────────────────────────────

export const aiClient = createClient(AiService, transport);
export const authClient = createClient(AuthService, transport);
export const cacheClient = createClient(CacheService, transport);
export const capabilityClient = createClient(CapabilityService, transport);
export const consolidationClient = createClient(ConsolidationService, transport);
export const conversationClient = createClient(ConversationService, transport);
export const costClient = createClient(CostService, transport);
export const databaseClient = createClient(DatabaseService, transport);
export const entityClient = createClient(EntityService, transport);
export const episodicClient = createClient(EpisodicService, transport);
export const eventClient = createClient(EventService, transport);
export const lifecycleClient = createClient(LifecycleService, transport);
export const mcpClient = createClient(McpService, transport);
export const mediaClient = createClient(MediaService, transport);
export const memoryClient = createClient(MemoryService, transport);
export const moduleClient = createClient(ModuleService, transport);
export const networkClient = createClient(NetworkService, transport);
export const pageClient = createClient(PageService, transport);
export const projectClient = createClient(ProjectService, transport);
export const scheduleClient = createClient(ScheduleService, transport);
export const secretClient = createClient(SecretService, transport);
export const settingsClient = createClient(SettingsService, transport);
export const statusClient = createClient(StatusService, transport);
export const storageClient = createClient(StorageService, transport);
export const taskClient = createClient(TaskService, transport);
export const telegramClient = createClient(TelegramService, transport);
export const templateClient = createClient(TemplateService, transport);
export const toolClient = createClient(ToolService, transport);

function exportedClients(): Record<string, any> {
  return {
    aiClient,
    authClient,
    cacheClient,
    capabilityClient,
    consolidationClient,
    conversationClient,
    costClient,
    databaseClient,
    entityClient,
    episodicClient,
    eventClient,
    lifecycleClient,
    mcpClient,
    mediaClient,
    memoryClient,
    moduleClient,
    networkClient,
    pageClient,
    projectClient,
    scheduleClient,
    secretClient,
    settingsClient,
    statusClient,
    storageClient,
    taskClient,
    telegramClient,
    templateClient,
    toolClient,
  };
}

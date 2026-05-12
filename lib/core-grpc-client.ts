/**
 * gRPC client (Node side) — Phase B-typed cutover 후 정공 (2026-05-12).
 *
 * 옛 proto-loader dynamic schema 폐기. 자동 생성 typed client (lib/grpc-typed-client.ts) 위임.
 * METHOD_TABLE 은 옛 facade method 명 (`savePage`) → {service, rpc} 매핑만 유지 (호출 site 호환).
 *
 * 호출 흐름:
 *   getCore().savePage(slug, spec, opts)
 *   → RustCoreProxy (ARGS_TABLE wrapper — slug/spec/status/project/visibility/password 매핑)
 *   → invokeCore('savePage', wrappedArgs)
 *   → resolveMethodToRpc → {service: 'PageService', rpc: 'Save'}
 *   → pageClient.save(wrappedArgs)  // @connectrpc/connect-node typed client
 *   → Rust PageService.Save(PageSaveRequest)
 *
 * Frontend 는 직접 호출 X — API route 경유. browser 에서 gRPC 직접 못 함.
 */

/**
 * 옛 facade method (예: 'savePage') → { service, rpc } 매핑.
 * Phase B-4 까지 명시 매핑 — Phase B-typed cutover 후 호출 site 가 typed client 직접 사용 시 점진 폐기.
 */
const METHOD_TABLE: Record<string, { service: string; rpc: string }> = {
  // ── PageService ─────────────────────────────────────────────
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

  // ── ProjectService ──────────────────────────────────────────
  listProjects: { service: 'ProjectService', rpc: 'Scan' },
  scanProjects: { service: 'ProjectService', rpc: 'Scan' },
  getProjectVisibility: { service: 'ProjectService', rpc: 'GetVisibility' },
  setProjectVisibility: { service: 'ProjectService', rpc: 'SetVisibility' },
  getProjectConfig: { service: 'ProjectService', rpc: 'GetConfig' },
  setProjectConfig: { service: 'ProjectService', rpc: 'SetConfig' },
  verifyProjectPassword: { service: 'ProjectService', rpc: 'VerifyPassword' },
  deleteProject: { service: 'ProjectService', rpc: 'Delete' },
  renameProject: { service: 'ProjectService', rpc: 'Rename' },

  // ── ModuleService ───────────────────────────────────────────
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

  // ── TaskService / ScheduleService ───────────────────────────
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

  // ── SecretService ──────────────────────────────────────────
  listUserSecrets: { service: 'SecretService', rpc: 'ListUser' },
  setUserSecret: { service: 'SecretService', rpc: 'SetUser' },
  getUserSecret: { service: 'SecretService', rpc: 'GetUser' },
  deleteUserSecret: { service: 'SecretService', rpc: 'DeleteUser' },
  listUserModuleSecrets: { service: 'SecretService', rpc: 'ListUserModuleSecrets' },
  getVertexKey: { service: 'SecretService', rpc: 'GetSystem' },
  setVertexKey: { service: 'SecretService', rpc: 'SetSystem' },
  getGeminiKey: { service: 'SecretService', rpc: 'GetSystem' },
  setGeminiKey: { service: 'SecretService', rpc: 'SetSystem' },

  // ── McpService ─────────────────────────────────────────────
  listMcpServers: { service: 'McpService', rpc: 'ListServers' },
  saveMcpServer: { service: 'McpService', rpc: 'AddServer' },
  addMcpServer: { service: 'McpService', rpc: 'AddServer' },
  removeMcpServer: { service: 'McpService', rpc: 'RemoveServer' },
  listMcpTools: { service: 'McpService', rpc: 'ListTools' },
  listAllMcpTools: { service: 'McpService', rpc: 'ListAllTools' },
  callMcpTool: { service: 'McpService', rpc: 'CallTool' },

  // ── CapabilityService ──────────────────────────────────────
  listCapabilities: { service: 'CapabilityService', rpc: 'List' },
  getCapabilityProviders: { service: 'CapabilityService', rpc: 'GetProviders' },
  listCapabilitiesWithProviders: { service: 'CapabilityService', rpc: 'ListWithProviders' },
  resolveCapability: { service: 'CapabilityService', rpc: 'Resolve' },
  registerCapability: { service: 'CapabilityService', rpc: 'Register' },
  getCapabilitySettings: { service: 'CapabilityService', rpc: 'GetSettings' },
  setCapabilitySettings: { service: 'CapabilityService', rpc: 'SetSettings' },

  // ── AuthService ────────────────────────────────────────────
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

  // ── ConversationService ────────────────────────────────────
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

  // ── MediaService ───────────────────────────────────────────
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

  // ── AiService ──────────────────────────────────────────────
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

  // ── StorageService ─────────────────────────────────────────
  readFile: { service: 'StorageService', rpc: 'ReadFile' },
  readFileBinary: { service: 'StorageService', rpc: 'ReadFileBinary' },
  writeFile: { service: 'StorageService', rpc: 'WriteFile' },
  appendFile: { service: 'StorageService', rpc: 'WriteFile' },
  deleteFile: { service: 'StorageService', rpc: 'DeleteFile' },
  listDir: { service: 'StorageService', rpc: 'ListDir' },
  listFiles: { service: 'StorageService', rpc: 'ListFiles' },
  getFileTree: { service: 'StorageService', rpc: 'GetFileTree' },
  globFiles: { service: 'StorageService', rpc: 'GlobFiles' },

  // ── EntityService ──────────────────────────────────────────
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

  // ── EpisodicService ────────────────────────────────────────
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

  // ── ConsolidationService ──────────────────────────────────
  askLlmText: { service: 'ConsolidationService', rpc: 'AskLlmText' },
  consolidate: { service: 'ConsolidationService', rpc: 'Consolidate' },
  consolidateInactive: { service: 'ConsolidationService', rpc: 'ConsolidateInactive' },
  getMemoryStats: { service: 'ConsolidationService', rpc: 'GetMemoryStats' },

  // ── TemplateService ───────────────────────────────────────
  listTemplates: { service: 'TemplateService', rpc: 'List' },
  getTemplate: { service: 'TemplateService', rpc: 'Get' },
  saveTemplate: { service: 'TemplateService', rpc: 'Save' },
  deleteTemplate: { service: 'TemplateService', rpc: 'Delete' },

  // ── Cross-cutting ─────────────────────────────────────────
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

function resolveMethodToRpc(method: string): { service: string; rpc: string } {
  const entry = METHOD_TABLE[method];
  if (!entry) {
    throw new Error(`[invokeCore] unknown facade method: ${method}`);
  }
  return entry;
}

/**
 * Core 메서드 단일 진입점 — typed client routing.
 *
 * Phase B-typed (2026-05-12) — proto-loader dynamic schema 폐기. 자동 생성 typed client 사용.
 * 호출 site 변경 0 (transparent cutover).
 */
export async function invokeCore<T = unknown>(method: string, args?: unknown): Promise<T> {
  const { service, rpc } = resolveMethodToRpc(method);
  let response: any;
  try {
    response = await callTypedClient(service, rpc, args);
  } catch (err) {
    const { fromGrpcError } = await import('./api-error');
    throw fromGrpcError(err);
  }
  // RawJsonPb.rawJson — 동적 schema 응답 자동 unwrap.
  if (response && typeof response.rawJson === 'string') {
    return JSON.parse(response.rawJson) as T;
  }
  // OptionalStringPb {value, present} — get_* RPC 의 옵셔널 응답.
  if (response && typeof response === 'object' && 'present' in response && 'value' in response) {
    return (response.present ? response.value : null) as T;
  }
  // StringRequest / NumberRequest / BoolRequest — 단순 wrapper 자동 unwrap.
  if (response && typeof response === 'object' && Object.keys(response).length === 1 && 'value' in response) {
    return response.value as T;
  }
  return response as T;
}

/**
 * typed client routing — service + rpc (PascalCase) → camelCase method 호출.
 * args 자동 분기:
 *   - undefined / null → Empty
 *   - string → StringRequest
 *   - number → NumberRequest
 *   - boolean → BoolRequest
 *   - object → typed Request 직접 (field 명 camelCase 매핑)
 */
async function callTypedClient(service: string, rpc: string, args: unknown): Promise<any> {
  const clients = await import('./grpc-typed-client');
  const clientKey =
    service.charAt(0).toLowerCase() + service.slice(1).replace(/Service$/, 'Client');
  const client = (clients as any)[clientKey];
  if (!client) {
    throw new Error(`[invokeCore] typed client 없음: ${service} → ${clientKey}`);
  }
  const methodName = rpc.charAt(0).toLowerCase() + rpc.slice(1);
  const method = client[methodName];
  if (typeof method !== 'function') {
    throw new Error(`[invokeCore] typed client method 없음: ${service}.${methodName}`);
  }
  let request: any;
  if (args === undefined || args === null) request = {};
  else if (typeof args === 'string') request = { value: args };
  else if (typeof args === 'number') request = { value: args };
  else if (typeof args === 'boolean') request = { value: args };
  else request = args;
  return await method.call(client, request);
}

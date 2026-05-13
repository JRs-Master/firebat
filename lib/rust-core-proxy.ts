/**
 * RustCoreProxy — Phase B-4 C 설정.
 *
 * 옛 in-process FirebatCore 와 같은 메서드 시그니처를 Proxy + Reflect 패턴으로 노출.
 * 메서드 호출 → callCore('methodName', wrapped_args) → gRPC → Rust Core (port 50051).
 *
 * 2026-05-12 정공 변환:
 *   - proto schema 의 93+ untyped RPC (JsonArgs) → typed Request message 으로 변환됨.
 *   - ARGS_TABLE 의 모든 wrapper 가 새 typed Request 의 field 명과 1:1 매칭 (camelCase, proto-loader keepCase:false 호환).
 *   - 사용자 후속: `npm run gen:proto` 으로 protoc-gen-es 자동 생성 후 점진 typed client cutover.
 *
 * 사용 패턴 (호출 site 변경 0):
 *   ```ts
 *   const core = new RustCoreProxy() as any;
 *   await core.savePage(slug, spec);
 *   await core.listPages();
 *   ```
 */
import { callTypedClient } from './grpc-typed-client';

/**
 * 다인자 method 의 args → typed Request 매핑.
 * 매핑 안 설정된 method 는 첫 인자만 그대로 전달.
 *
 * 새 proto schema 의 typed Request field 명 (camelCase) 과 1:1 매칭.
 */
const ARGS_TABLE: Record<string, (...args: any[]) => unknown> = {
  // ── PageService ─────────────────────────────────────────────────────────
  // PageSaveRequest { slug, spec, status?, project?, visibility?, password? }
  savePage: (slug: string, spec: unknown, opts?: { status?: string; project?: string; visibility?: string; password?: string }) => {
    const o = opts ?? {};
    return { slug, spec, status: o.status, project: o.project, visibility: o.visibility, password: o.password };
  },
  searchPages: (query: string, limit?: number) => ({ query, limit }),
  // PageRenameRequest { oldSlug, newSlug, setRedirect? }
  renamePage: (oldSlug: string, newSlug: string, opts?: { setRedirect?: boolean }) => ({
    oldSlug, newSlug, setRedirect: opts?.setRedirect,
  }),
  setPageVisibility: (slug: string, visibility: string, password?: string) => ({ slug, visibility, password }),
  verifyPagePassword: (slug: string, password: string) => ({ slug, password }),
  // PageFindRelatedRequest { slug, limit?, tagAliasesRaw? }
  findRelatedPages: (slug: string, limit?: number, tagAliasesRaw?: string) => ({ slug, limit, tagAliasesRaw }),

  // ── ProjectService ──────────────────────────────────────────────────────
  // ProjectRenameRequest { oldName, newName }
  renameProject: (oldName: string, newName: string) => ({ oldName, newName }),
  setProjectVisibility: (project: string, visibility: string, password?: string) => ({ project, visibility, password }),
  // ProjectSetConfigRequest { project, configJson }
  setProjectConfig: (project: string, config: unknown) => ({ project, configJson: JSON.stringify(config ?? null) }),
  verifyProjectPassword: (project: string, password: string) => ({ project, password }),

  // ── ModuleService ───────────────────────────────────────────────────────
  // ModuleRunRequest { module, dataJson } — module 이 path 형태 ('/' 포함) 면 Rust 가 sandboxExecute 분기.
  runModule: (path: string, input: unknown) => ({ module: path, dataJson: JSON.stringify(input ?? {}) }),
  sandboxExecute: (path: string, input: unknown) => ({ module: path, dataJson: JSON.stringify(input ?? {}) }),
  // ModuleGetSchemaRequest { scope, name }
  getModuleSchema: (scope: string, name: string) => ({ scope, name }),
  // ModuleSetSettingsRequest { name, settingsJson }
  setModuleSettings: (name: string, settings: unknown) => ({ name, settingsJson: JSON.stringify(settings ?? {}) }),
  setModuleEnabled: (name: string, enabled: boolean) => ({ name, enabled }),

  // ── TaskService ─────────────────────────────────────────────────────────
  // TaskRunRequest { pipelineJson }
  runTask: (steps: unknown[]) => ({ pipelineJson: JSON.stringify(steps ?? []) }),

  // ── ScheduleService ─────────────────────────────────────────────────────
  // ScheduleCronRequest — flat field, 동적 JSON field 는 string 으로 직렬화.
  scheduleCronJob: (input: any) => makeScheduleRequest(input),
  updateCronJob: (input: any) => makeScheduleRequest(input),
  // ValidatePipelineRequest { pipelineJson }
  validatePipeline: (steps: unknown[]) => ({ pipelineJson: JSON.stringify(steps ?? []) }),

  // ── SecretService ───────────────────────────────────────────────────────
  // SecretSetUserRequest { name, value } / SecretSetSystemRequest { key, value }
  setUserSecret: (name: string, value: string) => ({ name, value }),
  setSystemSecret: (key: string, value: string) => ({ key, value }),
  // 옛 호출자 호환 — Vertex / Gemini / Anthropic 등 system secret 박힌 게 setSystemSecret 으로 통합.
  setVertexKey: (key: string, value: string) => ({ key, value }),
  setGeminiKey: (key: string, value: string) => ({ key, value }),

  // ── McpService ──────────────────────────────────────────────────────────
  // McpAddServerRequest { name, transport, command?, args, envJson, url?, enabled }
  saveMcpServer: (server: any) => ({
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    envJson: JSON.stringify(server.env ?? {}),
    url: server.url,
    enabled: server.enabled ?? true,
  }),
  // McpCallToolRequest { server, tool, argumentsJson }
  callMcpTool: (server: string, tool: string, args?: unknown) => ({
    server, tool, argumentsJson: JSON.stringify(args ?? {}),
  }),

  // ── CapabilityService ───────────────────────────────────────────────────
  // CapabilityRegisterRequest { id, label, description }
  registerCapability: (id: string, label: string, description: string) => ({ id, label, description }),
  // CapabilitySetSettingsRequest { capId, providers[] }
  setCapabilitySettings: (capId: string, settings: { providers: string[] }) => ({
    capId, providers: settings?.providers ?? [],
  }),

  // ── AuthService ─────────────────────────────────────────────────────────
  // AuthLoginRequest { id, password, attemptKey? }
  login: (id: string, password: string, attemptKey?: string) => ({ id, password, attemptKey }),
  // GenerateApiToken: StringRequest 단일 (label)
  generateApiToken: (label?: string) => label ?? '',
  // AuthSetAdminCredentialsRequest { id?, password? }
  setAdminCredentials: (id?: string, password?: string) => ({ id, password }),
  // AuthValidatePasswordPolicyRequest { password, id? }
  validatePasswordPolicy: (password: string, id?: string) => (id !== undefined ? { password, id } : { password }),

  // ── ConversationService ─────────────────────────────────────────────────
  // ConversationOwnerIdRequest { owner, id }
  getConversation: (owner: string, id: string) => ({ owner, id }),
  deleteConversation: (owner: string, id: string) => ({ owner, id }),
  isConversationDeleted: (owner: string, id: string) => ({ owner, id }),
  restoreConversation: (owner: string, id: string) => ({ owner, id }),
  permanentDeleteConversation: (owner: string, id: string) => ({ owner, id }),
  // ConversationSaveRequest { owner, id, title, messagesJson, createdAt? }
  saveConversation: (owner: string, id: string, title: string, messages: unknown[], createdAt?: number) => ({
    owner, id, title, messagesJson: JSON.stringify(messages ?? []), createdAt,
  }),
  // ConversationSearchHistoryRequest { owner, query, currentConvId?, limit?, withinDays?, minScore?, includeBlocks? }
  searchHistory: (owner: string, query: string, opts?: any) => ({
    owner, query,
    currentConvId: opts?.currentConvId,
    limit: opts?.limit,
    withinDays: opts?.withinDays,
    minScore: opts?.minScore,
    includeBlocks: opts?.includeBlocks,
  }),
  // ConversationGetCliSessionRequest { conversationId, currentModel }
  getCliSession: (conversationId: string, currentModel: string) => ({ conversationId, currentModel }),
  // ConversationSetCliSessionRequest { conversationId, sessionId, model }
  setCliSession: (conversationId: string, sessionId: string, model: string) => ({ conversationId, sessionId, model }),
  // ConversationCreateShareRequest { shareType, title, messagesJson, owner?, sourceConvId?, ttlMs?, dedupKey? }
  createShare: (input: any) => ({
    shareType: input?.shareType ?? input?.type,
    title: input?.title,
    messagesJson: JSON.stringify(input?.messages ?? []),
    owner: input?.owner,
    sourceConvId: input?.sourceConvId,
    ttlMs: input?.ttlMs,
    dedupKey: input?.dedupKey,
  }),

  // ── EntityService ───────────────────────────────────────────────────────
  // EntitySaveRequest { name, entityType, aliases[], metadataJson?, sourceConvId? }
  saveEntity: (input: any) => ({
    name: input?.name,
    entityType: input?.type ?? input?.entityType,
    aliases: input?.aliases ?? [],
    metadataJson: input?.metadata !== undefined ? JSON.stringify(input.metadata) : undefined,
    sourceConvId: input?.sourceConvId,
  }),
  // EntityUpdateRequest { id, name?, entityType?, aliasesJson?, metadataJson? }
  updateEntity: (id: number, patch: any) => ({
    id,
    name: patch?.name,
    entityType: patch?.type ?? patch?.entityType,
    aliasesJson: patch?.aliases !== undefined ? JSON.stringify(patch.aliases) : undefined,
    metadataJson: patch?.metadata !== undefined ? JSON.stringify(patch.metadata) : undefined,
  }),
  // EntitySearchRequest { optsJson }
  searchEntities: (opts: unknown) => ({ optsJson: JSON.stringify(opts ?? {}) }),
  // EntityFactSaveRequest { entityId, content, factType?, occurredAt?, tags[], sourceConvId?, ttlDays?, dedupThreshold? }
  saveEntityFact: (input: any) => ({
    entityId: input?.entityId,
    content: input?.content,
    factType: input?.factType,
    occurredAt: input?.occurredAt,
    tags: input?.tags ?? [],
    sourceConvId: input?.sourceConvId,
    ttlDays: input?.ttlDays,
    dedupThreshold: input?.dedupThreshold,
  }),
  // EntityFactUpdateRequest { id, content?, factType?, occurredAt?, tagsJson?, ttlDays? }
  updateEntityFact: (id: number, patch: any) => ({
    id,
    content: patch?.content,
    factType: patch?.factType,
    occurredAt: patch?.occurredAt,
    tagsJson: patch?.tags !== undefined ? JSON.stringify(patch.tags) : undefined,
    ttlDays: patch?.ttlDays,
  }),
  // EntityTimelineRequest { entityId, limit?, offset?, orderBy? }
  getEntityTimeline: (entityId: number, opts?: any) => ({
    entityId, limit: opts?.limit, offset: opts?.offset, orderBy: opts?.orderBy,
  }),
  searchEntityFacts: (opts: unknown) => ({ optsJson: JSON.stringify(opts ?? {}) }),
  // EntityRetrieveContextRequest { query, entityLimit?, factsPerEntity? }
  retrieveContext: (query: string, opts?: any) => ({
    query, entityLimit: opts?.entityLimit, factsPerEntity: opts?.factsPerEntity,
  }),

  // ── EpisodicService ─────────────────────────────────────────────────────
  // EpisodicSaveEventRequest — flat field, context 가 동적 JSON.
  saveEvent: (input: any) => ({
    eventType: input?.type ?? input?.eventType,
    title: input?.title,
    description: input?.description,
    who: input?.who,
    contextJson: input?.context !== undefined ? JSON.stringify(input.context) : undefined,
    occurredAt: input?.occurredAt,
    entityIds: input?.entityIds ?? [],
    sourceConvId: input?.sourceConvId,
    ttlDays: input?.ttlDays,
    dedupThreshold: input?.dedupThreshold,
  }),
  updateEvent: (id: number, patch: any) => ({
    id,
    eventType: patch?.type ?? patch?.eventType,
    title: patch?.title,
    description: patch?.description,
    who: patch?.who,
    contextJson: patch?.context !== undefined ? JSON.stringify(patch.context) : undefined,
    occurredAt: patch?.occurredAt,
    entityIdsJson: patch?.entityIds !== undefined ? JSON.stringify(patch.entityIds) : undefined,
    ttlDays: patch?.ttlDays,
  }),
  searchEvents: (opts: unknown) => ({ optsJson: JSON.stringify(opts ?? {}) }),
  listRecentEvents: (opts: unknown) => ({ optsJson: JSON.stringify(opts ?? {}) }),
  listEventsByEntity: (entityId: number, opts?: any) => ({
    entityId, limit: opts?.limit, offset: opts?.offset,
  }),
  linkEventEntity: (eventId: number, entityId: number) => ({ eventId, entityId }),
  unlinkEventEntity: (eventId: number, entityId: number) => ({ eventId, entityId }),

  // ── MediaService ────────────────────────────────────────────────────────
  // MediaListRequest { optsJson }
  listMedia: (opts: unknown) => ({ optsJson: JSON.stringify(opts ?? {}) }),
  // MediaStartGenerationRequest / MediaGenerateRequest { inputJson }
  generateImage: (input: unknown) => ({ inputJson: JSON.stringify(input ?? {}) }),
  startImageGeneration: (input: unknown) => ({ inputJson: JSON.stringify(input ?? {}) }),
  // MediaSaveRequest { binaryBase64, contentType, optsJson }
  saveUpload: (binaryBase64: string, contentType: string, opts?: unknown) => ({
    binaryBase64, contentType, optsJson: JSON.stringify(opts ?? {}),
  }),
  // MediaSaveTempAttachmentRequest { dataUrl }
  saveTempAttachment: (dataUrl: string) => ({ dataUrl }),
  setImageModel: (modelId: string) => modelId,

  // ── StorageService ──────────────────────────────────────────────────────
  // StorageWriteFileRequest { path, content }
  writeFile: (path: string, content: string) => ({ path, content }),
  // StorageGlobFilesRequest { pattern, limit? }
  globFiles: (pattern: string, limit?: number) => ({ pattern, limit }),

  // ── AiService ───────────────────────────────────────────────────────────
  // AiProcessRequest / AiCodeAssistRequest { prompt, opts: { optsJson } }
  // AiRequestActionWithToolsRequest { prompt, tools: { toolsJson }, opts: { optsJson } }
  requestActionWithTools: (prompt: string, _history?: unknown, opts?: unknown) => ({
    prompt,
    tools: { toolsJson: '[]' },
    opts: { optsJson: JSON.stringify(opts ?? {}) },
  }),
  codeAssist: (prompt: string, opts?: unknown) => ({
    prompt,
    opts: { optsJson: JSON.stringify(opts ?? {}) },
  }),
  // AiCreatePendingRequest { name, argsJson, summary }
  createPending: (name: string, args: Record<string, unknown>, summary: string) => ({
    name, argsJson: JSON.stringify(args ?? {}), summary,
  }),
  // AiStorePlanRequest { planId, title, steps: [{stepJson}], estimatedTime?, risks[] }
  storePlan: (plan: any) => ({
    planId: plan?.planId,
    title: plan?.title,
    steps: (plan?.steps ?? []).map((s: unknown) => ({ stepJson: JSON.stringify(s) })),
    estimatedTime: plan?.estimatedTime,
    risks: plan?.risks ?? [],
  }),

  // ── SettingsService ─────────────────────────────────────────────────────
  // SettingsSetLastModelByCategoryRequest { byCategoryJson }
  setLastModelByCategory: (byCategory: Record<string, string>) => ({
    byCategoryJson: JSON.stringify(byCategory ?? {}),
  }),
  setAiAssistantModel: (modelId: string) => modelId,

  // ── TemplateService ─────────────────────────────────────────────────────
  // TemplateSaveRequest { slug, configJson }
  saveTemplate: (slug: string, config: unknown) => ({ slug, configJson: JSON.stringify(config ?? {}) }),

  // ── CostService ─────────────────────────────────────────────────────────
  // CostGetStatsRequest { since?, until?, model?, purpose? }
  getCostStats: (filter?: any) => ({
    since: filter?.since, until: filter?.until, model: filter?.model, purpose: filter?.purpose,
  }),
  // CostSetBudgetRequest { dailyUsd, monthlyUsd, dailyCalls, monthlyCalls, alertAtPercent }
  setCostBudget: (budget: any) => ({
    dailyUsd: budget?.dailyUsd ?? 0,
    monthlyUsd: budget?.monthlyUsd ?? 0,
    dailyCalls: budget?.dailyCalls ?? 0,
    monthlyCalls: budget?.monthlyCalls ?? 0,
    alertAtPercent: budget?.alertAtPercent ?? 80,
  }),

  // ── ToolService ─────────────────────────────────────────────────────────
  // ToolRegisterRequest { definitionJson }
  registerTool: (def: unknown) => ({ definitionJson: JSON.stringify(def ?? {}) }),
  registerToolsMany: (defs: unknown[]) => ({ definitionsJson: JSON.stringify(defs ?? []) }),
  // ToolListRequest { sourceFilter? }
  listTools: (opts?: any) => ({ sourceFilter: opts?.source }),
  // ToolExecuteRequest { name, argsJson }
  executeTool: (name: string, args?: unknown) => ({ name, argsJson: JSON.stringify(args ?? {}) }),
  // ToolBuildAi/McpDefinitions { sourceFilter? }
  buildAiToolDefinitions: (opts?: any) => ({ sourceFilter: opts?.source }),
  buildMcpToolDescriptions: (opts?: any) => ({ sourceFilter: opts?.source }),
  // ToolSetActivePlanStateRequest { conversationId, stateJson }
  setActivePlanState: (conversationId: string, state: unknown) => ({
    conversationId, stateJson: JSON.stringify(state ?? null),
  }),

  // ── StatusService ───────────────────────────────────────────────────────
  // StatusStartRequest { id?, jobType, message?, parentJobId?, metaJson }
  startJob: (input: any) => ({
    id: input?.id,
    jobType: input?.type ?? input?.jobType,
    message: input?.message,
    parentJobId: input?.parentJobId,
    metaJson: input?.meta !== undefined ? JSON.stringify(input.meta) : '',
  }),
  // StatusUpdateRequest { id, progress?, message?, metaJson? }
  updateJob: (input: any) => ({
    id: input?.id,
    progress: input?.progress,
    message: input?.message,
    metaJson: input?.meta !== undefined ? JSON.stringify(input.meta) : undefined,
  }),
  // StatusCompleteRequest { id, resultJson? }
  completeJob: (id: string, result?: unknown) => ({
    id, resultJson: result !== undefined ? JSON.stringify(result) : undefined,
  }),
  // StatusFailRequest { id, error }
  failJob: (id: string, error: string) => ({ id, error }),
  // StatusListRequest { jobType?, status?, since?, parentJobId?, limit? }
  listJobs: (filter?: any) => ({
    jobType: filter?.type ?? filter?.jobType,
    status: filter?.status,
    since: filter?.since,
    parentJobId: filter?.parentJobId,
    limit: filter?.limit,
  }),

  // ── CacheService ────────────────────────────────────────────────────────
  // CacheReadRequest { key, offset?, limit? }
  cacheRead: (key: string, opts?: any) => ({ key, offset: opts?.offset, limit: opts?.limit }),
  // CacheGrepRequest { key, field, op, valueJson }
  cacheGrep: (key: string, field: string, op: string, value: unknown) => ({
    key, field, op, valueJson: JSON.stringify(value),
  }),
  // CacheAggregateRequest { key, field, op }
  cacheAggregate: (key: string, field: string, op: string) => ({ key, field, op }),

  // ── TelegramService ─────────────────────────────────────────────────────
  // TelegramProcessMessageRequest { text, chatId }
  processTelegramMessage: (text: string, chatId: string | number) => ({ text, chatId: String(chatId) }),

  // ── DatabaseService ─────────────────────────────────────────────────────
  // DatabaseQueryRequest { sql, paramsJson }
  queryDatabase: (sql: string, params?: unknown[]) => ({
    sql, paramsJson: JSON.stringify(params ?? []),
  }),

  // ── MemoryService ───────────────────────────────────────────────────────
  // MemorySaveFileRequest { name, content }
  saveMemoryFile: (name: string, content: string) => ({ name, content }),

  // ── LifecycleService ────────────────────────────────────────────────────
  // LifecycleCaptureExceptionRequest { message, stack?, severity?, metaJson? }
  captureException: (input: any) => ({
    message: input?.message ?? String(input),
    stack: input?.stack,
    severity: input?.severity,
    metaJson: input?.meta !== undefined ? JSON.stringify(input.meta) : undefined,
  }),

  // ── NetworkService ──────────────────────────────────────────────────────
  // NetworkFetchRequest { url, method?, headersJson?, body?, timeoutMs? }
  networkFetch: (input: any) => ({
    url: input?.url,
    method: input?.method,
    headersJson: input?.headers ? JSON.stringify(input.headers) : undefined,
    body: typeof input?.body === 'string' ? input.body : (input?.body !== undefined ? JSON.stringify(input.body) : undefined),
    timeoutMs: input?.timeoutMs,
  }),
};

/**
 * ScheduleCronRequest 빌더 — 동적 JSON field (inputData / pipeline / runWhen / retry / notify) 를 string 으로 직렬화.
 */
function makeScheduleRequest(input: any): unknown {
  if (!input) return {};
  return {
    jobId: input.jobId ?? input.id,
    targetPath: input.targetPath ?? '',
    mode: input.mode ?? 'cron',
    cronTime: input.cronTime,
    runAt: input.runAt,
    delaySec: input.delaySec,
    startAt: input.startAt,
    endAt: input.endAt,
    inputDataJson: input.inputData !== undefined ? JSON.stringify(input.inputData) : undefined,
    pipelineJson: input.pipeline !== undefined ? JSON.stringify(input.pipeline) : undefined,
    title: input.title,
    description: input.description,
    oneShot: input.oneShot,
    runWhenJson: input.runWhen !== undefined ? JSON.stringify(input.runWhen) : undefined,
    retryJson: input.retry !== undefined ? JSON.stringify(input.retry) : undefined,
    notifyJson: input.notify !== undefined ? JSON.stringify(input.notify) : undefined,
    executionMode: input.executionMode,
    agentPrompt: input.agentPrompt,
  };
}

/**
 * autoWrap 설정할 메서드 — API route 가 `res.success / res.data` 가정 설정.
 */
const WRAP_METHODS = new Set([
  'savePage', 'deletePage', 'renamePage', 'getPage', 'listPages', 'searchPages',
  'verifyPagePassword', 'setPageVisibility', 'getPageRedirect',
  'listStaticPages', 'findMediaUsage', 'findRelatedPages', 'listAllTags',
  'saveProject', 'deleteProject', 'renameProject',
  'verifyProjectPassword', 'setProjectVisibility',
  'listConversations', 'getConversation', 'saveConversation', 'deleteConversation',
  'searchHistory', 'searchConversationHistory',
  'getCliSession', 'createShare', 'getShare',
  'listDeletedConversations', 'restoreConversation', 'permanentDeleteConversation',
  'saveEntity', 'updateEntity', 'deleteEntity', 'getEntity',
  'findEntityByName', 'searchEntities',
  'saveEntityFact', 'updateEntityFact', 'deleteEntityFact', 'getEntityFact',
  'getEntityTimeline', 'searchEntityFacts', 'retrieveContext',
  'saveEvent', 'updateEvent', 'deleteEvent', 'getEvent',
  'searchEvents', 'listRecentEvents', 'listEventsByEntity',
  'linkEventEntity', 'unlinkEventEntity',
  'listMedia', 'readMedia', 'removeMedia', 'searchMedia', 'isMediaReady',
  'generateImage', 'startImageGeneration', 'regenerateImage', 'saveUpload',
  'saveTempAttachment',
  'getTemplate', 'saveTemplate', 'deleteTemplate',
  'resolveCapability',
  'callMcpTool', 'generateApiToken',
  'validateSession', 'validateToken',
  'scheduleTask', 'scheduleCronJob', 'cancelCronJob', 'updateCronJob', 'runCronJobNow',
  'runTask',
  'runModule', 'sandboxExecute',
  'getUserSecret', 'setUserSecret', 'deleteUserSecret',
  'listUserModuleSecrets',
  'readFile', 'readFileBinary', 'writeFile', 'deleteFile', 'globFiles',
  'getMemoryIndex', 'readMemoryFile', 'listMemoryFiles', 'saveMemoryFile', 'deleteMemoryFile',
  'executeTool',
  'codeAssist',
  'getTelegramWebhookStatus', 'setupTelegramWebhook', 'removeTelegramWebhook',
  'cacheRead', 'cacheGrep', 'cacheAggregate', 'cacheData',
  'queryDatabase',
]);

/**
 * 결과를 `{success, data, error}` 형식으로 자동 wrap.
 */
function autoWrapResult(method: string, result: any): any {
  if (!WRAP_METHODS.has(method)) return result;
  if (result === null || result === undefined) return { success: false, error: 'Not found' };
  if (typeof result === 'object' && 'success' in result) return result;
  return { success: true, data: result };
}

/**
 * RustCoreProxy 생성자 — 옛 FirebatCore method 호출을 typed client RPC 로 forward.
 * Proxy + Reflect 패턴이라 class 가 아닌 factory 로 export.
 * 옛 callCore / invokeCore layer 폐기 — typed client 직접 호출.
 */
export function createRustCoreProxy(): unknown {
  const target = {};
  return new Proxy(target, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined;
      return async (...args: unknown[]) => {
        if (typeof window !== 'undefined') {
          throw new Error('[RustCoreProxy] Node side 전용 — Frontend 에서 직접 호출 X. API route 경유 필요');
        }
        const wrapper = ARGS_TABLE[prop];
        const wrappedArgs = wrapper ? wrapper(...args) : args[0];
        const result = await callTypedClient(prop, wrappedArgs);
        // login 은 LoginResponsePb {ok, session, error, code, retryAfterSec} 반환 — 호출자 (api/auth/route.ts) 형식 으로 unwrap.
        // 성공 → AuthSession, 실패 → null, 잠금 → {locked, retryAfterSec}
        if (prop === 'login') {
          const r = result as { ok?: boolean; session?: unknown; code?: string; retryAfterSec?: number } | null;
          if (r?.ok && r.session) return r.session;
          if (r && r.code === 'LOGIN_LOCKED') return { locked: true, retryAfterSec: r.retryAfterSec ?? 60 };
          return null;
        }
        return autoWrapResult(prop, result);
      };
    },
  });
}

/** @deprecated — `createRustCoreProxy()` 사용. */
export class RustCoreProxy {
  constructor() {
    return createRustCoreProxy() as RustCoreProxy;
  }
}

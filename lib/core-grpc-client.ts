/**
 * gRPC client (Node side) — Phase A 박힘.
 *
 * Next.js API route (app/api/core/[method]/route.ts, 향후) 가 이 client 통해 Rust Core 호출.
 * Frontend 는 fetch → API route → gRPC 패턴이라 browser 에서 gRPC 직접 사용 X.
 *
 * Phase A: dynamic proto loading (`@grpc/proto-loader`) — codegen 없이 runtime 파싱.
 *          간단 + 빠른 prototype. 단 TypeScript 타입은 `any` (Phase B 후속에서 ts-proto 또는
 *          @bufbuild/protoc-gen-es 도입해 typed stub 으로 swap 가능).
 *
 * Phase B: 매니저별 typed message 박힌 후 codegen typed stub 활용 검토.
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
 * Phase B: 매니저별 typed RPC 박힐 때 정밀 매핑 도입.
 *
 * @param method - facade method (camelCase, 예: 'savePage' / 'login' / 'listConversations')
 * @param args   - JSON-serializable 인자 (단일 객체)
 */
export async function invokeCore<T = unknown>(method: string, args?: unknown): Promise<T> {
  const { service, rpc } = resolveMethodToRpc(method);
  const request = { raw: JSON.stringify(args ?? null) };  // JsonArgs schema
  const response: any = await callGrpcMethod(service, rpc, request);
  // JsonValue.raw → parse
  if (response && typeof response.raw === 'string') {
    return JSON.parse(response.raw) as T;
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

  // ── ProjectService (ProjectManager) ───────────────────────────
  listProjects: { service: 'ProjectService', rpc: 'List' },
  getProject: { service: 'ProjectService', rpc: 'Get' },
  saveProject: { service: 'ProjectService', rpc: 'Save' },
  deleteProject: { service: 'ProjectService', rpc: 'Delete' },
  setProjectVisibility: { service: 'ProjectService', rpc: 'SetVisibility' },
  verifyProjectPassword: { service: 'ProjectService', rpc: 'VerifyPassword' },

  // ── ModuleService (ModuleManager) ─────────────────────────────
  listSystemModules: { service: 'ModuleService', rpc: 'ListSystem' },
  listUserModules: { service: 'ModuleService', rpc: 'ListUser' },
  getModuleSchema: { service: 'ModuleService', rpc: 'GetSchema' },
  runModule: { service: 'ModuleService', rpc: 'Run' },
  setModuleEnabled: { service: 'ModuleService', rpc: 'SetEnabled' },
  setModuleSettings: { service: 'ModuleService', rpc: 'SetSettings' },
  getModuleSettings: { service: 'ModuleService', rpc: 'GetSettings' },

  // ── ScheduleService (ScheduleManager) ─────────────────────────
  listCronJobs: { service: 'ScheduleService', rpc: 'List' },
  scheduleTask: { service: 'ScheduleService', rpc: 'Schedule' },
  cancelCronJob: { service: 'ScheduleService', rpc: 'Cancel' },
  getCronLogs: { service: 'ScheduleService', rpc: 'GetLogs' },
  setTimezone: { service: 'ScheduleService', rpc: 'SetTimezone' },
  getTimezone: { service: 'ScheduleService', rpc: 'GetTimezone' },

  // ── TaskService (TaskManager) ─────────────────────────────────
  runTask: { service: 'TaskService', rpc: 'Run' },

  // ── SecretService (SecretManager) ─────────────────────────────
  listUserSecrets: { service: 'SecretService', rpc: 'ListUser' },
  setUserSecret: { service: 'SecretService', rpc: 'SetUser' },
  deleteUserSecret: { service: 'SecretService', rpc: 'DeleteUser' },
  getVertexKey: { service: 'SecretService', rpc: 'GetVertexKey' },
  setVertexKey: { service: 'SecretService', rpc: 'SetVertexKey' },

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
  generateApiToken: { service: 'AuthService', rpc: 'GenerateApiToken' },
  validateApiToken: { service: 'AuthService', rpc: 'ValidateApiToken' },
  revokeApiTokens: { service: 'AuthService', rpc: 'RevokeApiTokens' },
  listApiTokens: { service: 'AuthService', rpc: 'ListApiTokens' },
  getAdminCredentials: { service: 'AuthService', rpc: 'GetAdminCredentials' },
  setAdminCredentials: { service: 'AuthService', rpc: 'SetAdminCredentials' },
  sweepExpiredSessions: { service: 'AuthService', rpc: 'SweepExpiredSessions' },

  // ── ConversationService (ConversationManager) ─────────────────
  listConversations: { service: 'ConversationService', rpc: 'List' },
  getConversation: { service: 'ConversationService', rpc: 'Get' },
  saveConversation: { service: 'ConversationService', rpc: 'Save' },
  deleteConversation: { service: 'ConversationService', rpc: 'Delete' },
  isConversationDeleted: { service: 'ConversationService', rpc: 'IsDeleted' },
  searchHistory: { service: 'ConversationService', rpc: 'SearchHistory' },
  getCliSession: { service: 'ConversationService', rpc: 'GetCliSession' },
  setCliSession: { service: 'ConversationService', rpc: 'SetCliSession' },
  createShare: { service: 'ConversationService', rpc: 'CreateShare' },
  getShare: { service: 'ConversationService', rpc: 'GetShare' },

  // ── MediaService (MediaManager — image_gen + 갤러리) ──────────
  generateImage: { service: 'MediaService', rpc: 'Generate' },
  startImageGeneration: { service: 'MediaService', rpc: 'StartGenerate' },
  regenerateImage: { service: 'MediaService', rpc: 'Regenerate' },
  removeMedia: { service: 'MediaService', rpc: 'Remove' },
  readMedia: { service: 'MediaService', rpc: 'Read' },
  statMedia: { service: 'MediaService', rpc: 'Stat' },
  listMedia: { service: 'MediaService', rpc: 'List' },
  searchMedia: { service: 'MediaService', rpc: 'Search' },
  isMediaReady: { service: 'MediaService', rpc: 'IsReady' },
  getImageModel: { service: 'MediaService', rpc: 'GetModel' },
  setImageModel: { service: 'MediaService', rpc: 'SetModel' },
  listImageModels: { service: 'MediaService', rpc: 'ListModels' },

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
  getMemoryStats: { service: 'ConsolidationService', rpc: 'GetStats' },

  // ── CostService (CostManager) ─────────────────────────────────
  recordLlmCost: { service: 'CostService', rpc: 'Record' },
  getCostSummary: { service: 'CostService', rpc: 'GetSummary' },
  getCostHistory: { service: 'CostService', rpc: 'GetHistory' },

  // ── EventService (EventManager — SSE) ─────────────────────────
  notifySidebar: { service: 'EventService', rpc: 'NotifySidebar' },
  notifyGallery: { service: 'EventService', rpc: 'NotifyGallery' },
  notifyCronComplete: { service: 'EventService', rpc: 'NotifyCronComplete' },
  subscribeEvents: { service: 'EventService', rpc: 'Subscribe' },

  // ── StatusService (StatusManager — long-running 가시화) ───────
  startJob: { service: 'StatusService', rpc: 'Start' },
  updateJob: { service: 'StatusService', rpc: 'Update' },
  completeJob: { service: 'StatusService', rpc: 'Complete' },
  failJob: { service: 'StatusService', rpc: 'Fail' },
  listActiveJobs: { service: 'StatusService', rpc: 'ListActive' },
  getJob: { service: 'StatusService', rpc: 'Get' },

  // ── ToolService (ToolManager — 도구 dispatch) ─────────────────
  listTools: { service: 'ToolService', rpc: 'List' },
  getToolStats: { service: 'ToolService', rpc: 'GetStats' },
  dispatchTool: { service: 'ToolService', rpc: 'Dispatch' },

  // ── AiService (AiManager) ─────────────────────────────────────
  requestActionWithTools: { service: 'AiService', rpc: 'RequestActionWithTools' },
  codeAssist: { service: 'AiService', rpc: 'CodeAssist' },
  getUserPrompt: { service: 'AiService', rpc: 'GetUserPrompt' },
  setUserPrompt: { service: 'AiService', rpc: 'SetUserPrompt' },
  getAiAssistantModel: { service: 'AiService', rpc: 'GetAssistantModel' },
  setAiAssistantModel: { service: 'AiService', rpc: 'SetAssistantModel' },
  getAvailableAiAssistantModels: {
    service: 'AiService',
    rpc: 'GetAvailableAssistantModels',
  },

  // ── StorageService (IStoragePort 직접 — Rust 측 매니저 없음) ──
  readFile: { service: 'StorageService', rpc: 'Read' },
  readBinaryFile: { service: 'StorageService', rpc: 'ReadBinary' },
  writeFile: { service: 'StorageService', rpc: 'Write' },
  appendFile: { service: 'StorageService', rpc: 'Append' },
  deleteFile: { service: 'StorageService', rpc: 'Delete' },
  listDir: { service: 'StorageService', rpc: 'ListDir' },
  treeDir: { service: 'StorageService', rpc: 'Tree' },

  // ── DatabaseService (IDatabasePort 직접) ──────────────────────
  dbQuery: { service: 'DatabaseService', rpc: 'Query' },

  // ── NetworkService (INetworkPort 직접) ────────────────────────
  networkRequest: { service: 'NetworkService', rpc: 'Request' },

  // ── SettingsService (Vault flat key 헬퍼) ────────────────────
  getSettings: { service: 'SettingsService', rpc: 'Get' },
  setSetting: { service: 'SettingsService', rpc: 'Set' },

  // ── CacheService (Phase 2 sysmod result cache) ───────────────
  cacheData: { service: 'CacheService', rpc: 'Data' },
  cacheRead: { service: 'CacheService', rpc: 'Read' },
  cacheGrep: { service: 'CacheService', rpc: 'Grep' },
  cacheAggregate: { service: 'CacheService', rpc: 'Aggregate' },
  cacheDrop: { service: 'CacheService', rpc: 'Drop' },

  // ── TelegramService (sysmod_telegram bot webhook) ────────────
  processTelegramMessage: { service: 'TelegramService', rpc: 'ProcessMessage' },

  // ── LifecycleService (Health / Shutdown) ─────────────────────
  health: { service: 'LifecycleService', rpc: 'Health' },
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

/**
 * RustCoreProxy — Phase B-4 C 설정.
 *
 * 옛 in-process FirebatCore 와 같은 메서드 시그니처를 Proxy + Reflect 패턴으로 노출.
 * 메서드 호출 → callCore('methodName', wrapped_args) → gRPC → Rust Core (port 50051).
 *
 * 사용 패턴:
 *   ```ts
 *   const core = new RustCoreProxy() as any;  // FirebatCore-shaped
 *   await core.savePage(slug, spec);          // → callCore('savePage', { slug, spec })
 *   await core.listPages();                   // → callCore('listPages')
 *   ```
 *
 * Frontend route 의 `getCore()` 호출자 코드 변경 0건 — 옛 시그니처 그대로.
 *
 * 다인자 → 단일 객체 wrap 매핑 (ARGS_TABLE):
 *   - 옛 facade method 가 다인자 받는 경우 (예: savePage(slug, spec)) 명시 매핑.
 *   - 매핑 안 설정된 method 는 args[0] 단일 인자 그대로 전달 (옛 옛 default).
 *   - frontend 의 `getCore().writeFile(path, content)` 같은 호출 → wrap 자동.
 *
 * 새 다인자 method 추가 시 본 table 에 entry 추가.
 */
import { callCore } from './core-client';

/**
 * 다인자 method 의 args → single object wrap 매핑.
 * 매핑 안 설정된 method 는 첫 인자만 그대로 전달.
 *
 * Rust 측 service handler 가 받는 JSON 구조와 1:1 매칭 — handler `JsonArgs.raw` 안 단일 객체.
 */
const ARGS_TABLE: Record<string, (...args: any[]) => unknown> = {
  // PageService
  savePage: (slug: string, spec: unknown, opts?: unknown) => ({ slug, spec, opts }),
  searchPages: (query: string, limit?: number) => ({ query, limit }),
  renamePage: (oldSlug: string, newSlug: string, opts?: unknown) => ({ oldSlug, newSlug, opts }),
  setPageVisibility: (slug: string, visibility: string, password?: string) => ({
    slug,
    visibility,
    password,
  }),
  verifyPagePassword: (slug: string, password: string) => ({ slug, password }),

  // ProjectService
  renameProject: (oldName: string, newName: string, opts?: unknown) => ({ oldName, newName, opts }),
  setProjectVisibility: (project: string, visibility: string, password?: string) => ({
    project,
    visibility,
    password,
  }),
  verifyProjectPassword: (project: string, password: string) => ({ project, password }),

  // ModuleService
  runModule: (path: string, input: unknown, opts?: unknown) => ({ path, input, opts }),
  setModuleEnabled: (name: string, enabled: boolean) => ({ name, enabled }),
  setModuleSettings: (name: string, settings: unknown) => ({ name, settings }),

  // ConversationService
  deleteConversation: (owner: string, id: string) => ({ owner, id }),
  searchHistory: (owner: string, query: string, opts?: unknown) => ({ owner, query, opts }),

  // StorageService
  writeFile: (path: string, content: string) => ({ path, content }),
  appendFile: (path: string, content: string) => ({ path, content }),

  // EntityService
  searchEntities: (opts: unknown) => opts, // 단일 객체 — 그대로
  updateEntity: (id: number, patch: unknown) => ({ id, patch }),
  getEntityTimeline: (entityId: number, opts?: unknown) => ({ entityId, opts }),
  updateEntityFact: (id: number, patch: unknown) => ({ id, patch }),
  searchEntityFacts: (opts: unknown) => opts,
  retrieveContext: (query: string, opts?: unknown) => ({ query, opts }),
  findRelatedPages: (slug: string, limit?: number) => ({ slug, limit }),

  // EpisodicService
  updateEvent: (id: number, patch: unknown) => ({ id, patch }),
  searchEvents: (opts: unknown) => opts,
  listEventsByEntity: (entityId: number, opts?: unknown) => ({ entityId, opts }),
  linkEventEntity: (eventId: number, entityId: number) => ({ eventId, entityId }),
  unlinkEventEntity: (eventId: number, entityId: number) => ({ eventId, entityId }),

  // MediaService
  generateImage: (input: unknown, opts?: unknown) => ({ input, opts }),
  startImageGeneration: (input: unknown, opts?: unknown) => ({ input, opts }),
  regenerateImage: (slug: string, opts?: unknown) => ({ slug, opts }),
  listMedia: (opts: unknown) => opts,
  searchMedia: (query: string, opts?: unknown) => ({ query, opts }),
  setImageModel: (modelId: string) => ({ modelId }),

  // AuthService — Rust args: { id, password, attempt_key } (옛 TS 의 username → id rename)
  login: (id: string, password: string, attemptKey?: string) => ({
    id,
    password,
    attempt_key: attemptKey ?? '',
  }),
  generateApiToken: (label?: string, expiresAt?: number) => ({ label, expiresAt }),
  setAdminCredentials: (id: string, password: string) => ({ id, password }),

  // CapabilityService
  resolveCapability: (capId: string, opts?: unknown) => ({ capId, opts }),
  setCapabilitySettings: (capId: string, settings: unknown) => ({ capId, settings }),

  // McpService
  saveMcpServer: (server: unknown) => server,
  callMcpTool: (server: string, tool: string, args?: unknown) => ({ server, tool, args }),

  // ScheduleService
  scheduleTask: (input: unknown) => input,
  cancelCronJob: (id: string) => ({ id }),

  // SecretService
  setUserSecret: (key: string, value: string) => ({ key, value }),
  setVertexKey: (key: string, value: string) => ({ key, value }),

  // TemplateService
  saveTemplate: (template: unknown) => template,

  // CostService
  recordLlmCost: (input: unknown) => input,

  // CacheService
  cacheData: (input: unknown) => input,
  cacheRead: (cacheKey: string, opts?: unknown) => ({ cacheKey, opts }),
  cacheGrep: (cacheKey: string, query: unknown, opts?: unknown) => ({ cacheKey, query, opts }),
  cacheAggregate: (cacheKey: string, op: string, field: string, by?: string) => ({
    cacheKey,
    op,
    field,
    by,
  }),
  cacheDrop: (cacheKey: string) => ({ cacheKey }),

  // AiService — Rust args: { prompt, tools, opts } (옛 TS history / callback 인자 무시)
  // 채팅 streaming 의 진짜 callback 흐름은 gRPC bidirectional streaming 설정한 후 재구현 필요 (별 commit).
  // 우선 unary call — prompt + opts 만 전송 후 결과 받음 (callback 없이).
  requestActionWithTools: (prompt: string, _history?: unknown, opts?: unknown) => ({
    prompt,
    tools: [],
    opts: opts ?? {},
  }),
  codeAssist: (params: unknown, opts?: unknown) => ({ params, opts }),
  setUserPrompt: (prompt: string) => ({ prompt }),
  setAiAssistantModel: (modelId: string) => ({ modelId }),
};

/**
 * 옛 TS Core 가 `{success, data, error}` wrap 형식으로 반환하던 메서드.
 * Rust gRPC 가 raw 값 반환 → RustCoreProxy 가 자동 wrap 저장.
 *
 *  - null / undefined → `{success: false, error: 'Not found'}`
 *  - object (단 'success' 필드 미설정) → `{success: true, data: <object>}`
 *  - array → `{success: true, data: <array>}`
 *  - 이미 'success' 설정된 object → 그대로 (Rust 측에서 wrap 한 응답)
 */
// autoWrap 설정할 메서드 — API route 가 `res.success / res.data` 가정 설정한 거.
// 옛 TS Core 의 거의 모든 메서드 wrap 설정했음. raw 가정 설정한 거 (API route 가 그대로 통과)
// 만 하지 마라.
const WRAP_METHODS = new Set([
  // PageService — 거의 모든 wrap (savePage / deletePage / getPage / listPages / searchPages)
  'savePage', 'deletePage', 'renamePage', 'getPage', 'listPages', 'searchPages',
  'verifyPagePassword', 'setPageVisibility', 'getPageRedirect',
  'listStaticPages', 'findMediaUsage', 'findRelatedPages', 'listAllTags',

  // ProjectService — wrap (mutation) + raw (scanProjects / getProjectVisibility / getProjectConfig 일부 raw)
  'saveProject', 'deleteProject', 'renameProject',
  'verifyProjectPassword', 'setProjectVisibility',

  // ConversationService — wrap (모두)
  'listConversations', 'getConversation', 'saveConversation', 'deleteConversation',
  'searchHistory', 'searchConversationHistory', 'isConversationDeleted',
  'getCliSession', 'createShare', 'getShare',

  // EntityService — wrap (모두)
  'saveEntity', 'updateEntity', 'deleteEntity', 'getEntity',
  'findEntityByName', 'searchEntities',
  'saveEntityFact', 'updateEntityFact', 'deleteEntityFact', 'getEntityFact',
  'getEntityTimeline', 'searchEntityFacts', 'retrieveContext',

  // EpisodicService — wrap (모두)
  'saveEvent', 'updateEvent', 'deleteEvent', 'getEvent',
  'searchEvents', 'listRecentEvents', 'listEventsByEntity',
  'linkEventEntity', 'unlinkEventEntity',

  // MediaService — wrap (모두)
  'listMedia', 'readMedia', 'removeMedia', 'searchMedia', 'isMediaReady',
  'generateImage', 'startImageGeneration', 'regenerateImage', 'saveUpload',

  // TemplateService — getTemplate / saveTemplate / deleteTemplate wrap. listTemplates 는 raw
  'getTemplate', 'saveTemplate', 'deleteTemplate',

  // CapabilityService — listCapabilities / getCapabilityProviders raw, mutation 만 wrap
  // resolveCapability 만 wrap (옛 패턴)
  'resolveCapability',

  // McpService — listMcpServers / addMcpServer / removeMcpServer raw. token 류 wrap
  'callMcpTool', 'generateApiToken',

  // AuthService — login / validate / token 류 wrap
  'login', 'validateSession', 'validateToken',

  // ScheduleService — scheduleTask / cancelCron 등 mutation wrap. listCronJobs / getCronLogs raw
  'scheduleTask', 'scheduleCronJob', 'cancelCronJob', 'updateCronJob', 'runCronJobNow',

  // TaskService
  'runTask',

  // ModuleService — runModule wrap, list 류 raw
  'runModule', 'sandboxExecute',

  // SecretService — get/set/delete 류 wrap. listUserSecrets raw
  'getUserSecret', 'setUserSecret', 'deleteUserSecret',
  'listUserModuleSecrets',

  // StorageService — readFile / writeFile 류 wrap. listDir / listFiles raw
  'readFile', 'readFileBinary', 'writeFile', 'deleteFile', 'globFiles',

  // MemoryService — wrap (모두)
  'getMemoryIndex', 'readMemoryFile', 'listMemoryFiles', 'saveMemoryFile', 'deleteMemoryFile',

  // ToolService
  'executeTool',

  // AiService
  'codeAssist',

  // Telegram
  'getTelegramWebhookStatus', 'setupTelegramWebhook', 'removeTelegramWebhook',

  // Cache
  'cacheRead', 'cacheGrep', 'cacheAggregate', 'cacheData',

  // Database
  'queryDatabase',

  // Network
  'networkFetch',

  // Status
  'getJob', 'getJobStats',
]);

/** Rust 응답 자동 wrap — 옛 TS `{success, data, error}` 형식 호환. */
function autoWrap(method: string, result: unknown): unknown {
  // login — Rust LoginOutcome → 옛 TS 형식 (성공 = session / 실패 = null / 잠금 = {locked, retryAfterSec})
  if (method === 'login') return unwrapLogin(result);
  if (!WRAP_METHODS.has(method)) return result;
  // 이미 success 설정된 응답 (Rust 측에서 wrap 한 경우) → 그대로
  if (
    result !== null &&
    typeof result === 'object' &&
    'success' in (result as Record<string, unknown>)
  ) {
    return result;
  }
  // null / undefined → not found
  if (result === null || result === undefined) {
    return { success: false, error: 'Not found' };
  }
  // raw value → wrap
  return { success: true, data: result };
}

/** Rust login 응답 → 옛 TS 형식.
 *  Rust: { ok: true, session } | { ok: false, error, code } | { ok: false, locked: true, retryAfterSec }
 *  옛 TS: AuthSession 객체 | null (실패) | { locked: true, retryAfterSec } (잠금)
 *
 *  **보안 critical** — 실패 시 null 반환 안 설정하면 API route 가 모든 비번 통과시킴.
 */
function unwrapLogin(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  // 잠금 상태
  if (r.locked === true) {
    return { locked: true, retryAfterSec: r.retryAfterSec ?? r.retry_after_sec ?? 60 };
  }
  // 성공
  if (r.ok === true && r.session) {
    return r.session;
  }
  // 실패 (ok: false 또는 session 없음) — null 반환 (API route 의 if (!result) 분기 잡힘)
  return null;
}

/**
 * RustCoreProxy — Proxy + Reflect 패턴.
 * 옛 FirebatCore 와 같은 메서드 호출 인터페이스 → callCore 라우팅.
 *
 * 메서드 미인식 (callCore 내부에서 RPC 매핑 못 찾으면) → fallback Lifecycle service 의
 * PascalCase RPC. table 등록 안 설정된 method 도 동작 시도 (안전망).
 *
 * WRAP_METHODS 설정된 메서드는 응답 자동 `{success, data, error}` 형식 wrap.
 * 옛 TS Core 호환성 유지 — frontend 코드 변경 0.
 */
export function createRustCoreProxy(): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop !== 'string') return undefined;
        // promise 패턴 호환 — `core.then` 등은 undefined 반환 (Proxy 가 thenable 로 잘못 인식 방지)
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return undefined;
        }
        // method call 캡처
        return async (...args: unknown[]) => {
          const wrapper = ARGS_TABLE[prop];
          const wrappedArgs = wrapper
            ? wrapper(...args)
            : args.length === 0
              ? undefined
              : args[0];
          const result = await callCore(prop, wrappedArgs);
          return autoWrap(prop, result);
        };
      },
      // setProperty 차단 — Proxy 는 read-only
      set() {
        return false;
      },
    },
  );
}

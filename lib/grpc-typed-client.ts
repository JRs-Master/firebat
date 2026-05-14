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
import { METHOD_TABLE_AUTO } from "./proto-gen/adapter-tables";
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

/**
 * facade method (예: 'savePage') → typed client method 직접 호출.
 *
 * Phase 4 정공 (2026-05-13) — 옛 manual METHOD_TABLE + RESPONSE_UNWRAP_TABLE 폐기.
 * `METHOD_TABLE_AUTO` (lib/proto-gen/adapter-tables.ts) = single source. proto schema
 * 가 source of truth, 자동 생성됨. 새 RPC 추가 시 `npm run gen:adapter` 만 박으면 됨.
 */
export async function callTypedClient<T = unknown>(method: string, args: unknown): Promise<T> {
  const entry = METHOD_TABLE_AUTO[method];
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
  // RawJsonPb / OptionalStringPb / {value} wrapper — generic 처리 (proto schema 표준).
  if (response && typeof response.rawJson === 'string') {
    return JSON.parse(response.rawJson) as T;
  }
  if (response && typeof response === 'object' && 'present' in response && 'value' in response) {
    return (response.present ? response.value : null) as T;
  }
  // BoolRequest / StringRequest / NumberRequest / IdRequest 같은 단일 value field wrapper unwrap.
  // 2026-05-14 회귀 fix: protoc-gen-es 의 Message base 가 `$typeName` 같은 메타 키 박음 →
  // 옛 `Object.keys.length === 1` 검사가 length ≥ 2 false → unwrap 실패 → 객체 자체 반환 →
  // route.ts 의 `if (await core.isConversationDeleted(...))` 가 객체 truthy → 무조건 409.
  // protobuf field name 에 `$` 금지 (syntax 제약) — 메타 키 안전 제외.
  if (response && typeof response === 'object' && 'value' in response) {
    const userKeys = Object.keys(response).filter((k) => !k.startsWith('$'));
    if (userKeys.length === 1) {
      return (response as Record<string, unknown>).value as T;
    }
  }
  // 자동 unwrap — METHOD_TABLE_AUTO entry.unwrapField (codegen 산출, proto schema 기반).
  const unwrapField = entry.unwrapField;
  if (unwrapField && response && typeof response === 'object' && unwrapField in response) {
    return (response as Record<string, unknown>)[unwrapField] as T;
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

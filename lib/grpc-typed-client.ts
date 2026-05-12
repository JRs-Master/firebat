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
} from "./proto-gen/firebat_pb.js";

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

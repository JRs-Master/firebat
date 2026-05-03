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
 * Phase A: 컨벤션 기반 — facade method 의 prefix 로 service 추정.
 * Phase B: 매니저별 typed RPC 박히면 명시 매핑 table 박음.
 */
function resolveMethodToRpc(method: string): { service: string; rpc: string } {
  // Phase A 의 sample 매핑 (Phase B 에서 21 매니저 전부 박힘)
  const prefixToService: Record<string, string> = {
    page: 'PageService',
    project: 'ProjectService',
    module: 'ModuleService',
    schedule: 'ScheduleService',
    secret: 'SecretService',
    mcp: 'McpService',
    capability: 'CapabilityService',
    auth: 'AuthService',
    conversation: 'ConversationService',
    media: 'MediaService',
    image: 'MediaService',
    cron: 'ScheduleService',
    template: 'TemplateService',
    entity: 'EntityService',
    fact: 'EntityService',
    event: 'EpisodicService',
  };
  // facade method 의 prefix 로 service 추출 (예: 'savePage' → 'page' → 'PageService')
  // RPC 이름은 PascalCase + service prefix 제거 (예: 'savePage' → 'Save')
  for (const [prefix, service] of Object.entries(prefixToService)) {
    const re = new RegExp(`^([a-z]+)${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`, '');
    const m = method.match(re);
    if (m) {
      const verb = m[1];
      const rpc = verb.charAt(0).toUpperCase() + verb.slice(1);
      return { service, rpc };
    }
  }
  // fallback — Lifecycle / Settings 등 cross-cutting
  return { service: 'LifecycleService', rpc: method.charAt(0).toUpperCase() + method.slice(1) };
}

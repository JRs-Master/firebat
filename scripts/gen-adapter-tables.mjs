#!/usr/bin/env node
/**
 * Adapter table codegen — Phase 4 정공 (2026-05-13).
 *
 * proto/firebat.proto 의 service / rpc / message 정의 → lib/proto-gen/adapter-tables.ts 자동 생성.
 *
 * 자동 생성 영역:
 *  - METHOD_TABLE_AUTO     — facade method (camelCase) → { service, rpc, requestType, responseType }
 *  - RESPONSE_UNWRAP_AUTO  — 단일 array / 의미 있는 field 자동 unwrap 매핑
 *
 * 사용자 override (proto/adapter-overrides.json):
 *  - facade method alias (예: 'savePage' → ProjectService.Save 같은 옛 명명)
 *  - WRAP_METHODS 표시 (frontend wrap pattern)
 *  - custom args wrapper 명시 (예: 'login' 의 positional → typed Request)
 *
 * 사용:
 *   npm run gen:adapter   # 단독 실행
 *   npm run gen:proto     # protoc-gen-es + 본 script 같이
 *
 * 새 RPC 추가 흐름:
 *   1. proto/firebat.proto 에 rpc 정의
 *   2. npm run gen:adapter
 *   3. lib/proto-gen/adapter-tables.ts 자동 갱신
 *   4. callTypedClient 가 자동 unwrap (silent bug 차단)
 *
 * 옛 manual table (lib/rust-core-proxy.ts ARGS_TABLE / WRAP_METHODS, lib/grpc-typed-client.ts
 * RESPONSE_UNWRAP_TABLE / METHOD_TABLE) 는 호출 site cutover 시점에 점진 폐기.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, '..', 'proto', 'firebat.proto');
const OVERRIDES_PATH = resolve(__dirname, '..', 'proto', 'adapter-overrides.json');
const OUTPUT_PATH = resolve(__dirname, '..', 'lib', 'proto-gen', 'adapter-tables.ts');

// ─── Proto parser ─────────────────────────────────────────────────────────

function parseProto(text) {
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const messages = {};
  const msgRegex = /message\s+(\w+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let m;
  while ((m = msgRegex.exec(clean)) !== null) {
    messages[m[1]] = { name: m[1], fields: parseMessageBody(m[2]) };
  }

  const services = [];
  const svcRegex = /service\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  while ((m = svcRegex.exec(clean)) !== null) {
    const rpcs = [];
    const rpcRegex = /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/g;
    let r;
    while ((r = rpcRegex.exec(m[2])) !== null) {
      rpcs.push({ name: r[1], requestType: r[2], responseType: r[3] });
    }
    services.push({ name: m[1], rpcs });
  }

  return { services, messages };
}

function parseMessageBody(body) {
  const fields = [];
  const fieldRegex = /^\s*(repeated\s+|optional\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*=\s*(\d+)\s*;/gm;
  let f;
  while ((f = fieldRegex.exec(body)) !== null) {
    const modifier = (f[1] || '').trim();
    fields.push({
      type: f[2],
      name: f[3],
      number: parseInt(f[4], 10),
      repeated: modifier === 'repeated',
      optional: modifier === 'optional',
    });
  }
  return fields;
}

// ─── Codegen logic ────────────────────────────────────────────────────────

/** service.rpc → camelCase facade method.
 * 2026-05-14 정공 fix — short name (camelCase) 이 기본.
 * 옛 규칙 (`<rpcCamel><Domain>` suffix) 은 collision (같은 short name 이 2+ service)
 * 시점에만 fallback. frontend 가 `core.login(...)` / `core.getTimezone()` 같이 short name
 * 호출하는 패턴 99% — suffix 박은 옛 default 가 alias 일괄 누락 시 silent 500 원인.
 */
function defaultFacadeName(serviceName, rpcName, collisions) {
  const rpcCamel = rpcName.charAt(0).toLowerCase() + rpcName.slice(1);
  if (collisions.has(rpcCamel)) {
    const domain = serviceName.replace(/Service$/, '');
    return rpcCamel + domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  return rpcCamel;
}

/** short name (camelCase) 이 2+ service 에서 정의되면 collision — 모두 suffix 박음. */
function detectCollisions(services) {
  const byShortName = {};
  for (const svc of services) {
    for (const rpc of svc.rpcs) {
      const short = rpc.name.charAt(0).toLowerCase() + rpc.name.slice(1);
      (byShortName[short] = byShortName[short] || []).push(svc.name);
    }
  }
  return new Set(
    Object.entries(byShortName)
      .filter(([_, svcs]) => svcs.length > 1)
      .map(([name]) => name),
  );
}

/** Response message → unwrap field (단일 array 또는 의미 있는 single field). */
function determineUnwrapField(msgName, messages) {
  if (!msgName || msgName === 'Empty') return null;
  // 알려진 generic wrapper — callTypedClient 가 별도 처리
  if (['RawJsonPb', 'OptionalStringPb', 'StringRequest', 'NumberRequest', 'BoolRequest', 'Status', 'IdRequest'].includes(msgName)) return null;

  const msg = messages[msgName];
  if (!msg || msg.fields.length === 0) return null;

  if (msg.fields.length === 1) {
    const f = msg.fields[0];
    if (f.repeated) return camelCase(f.name);
    // generic wrapper 와 충돌 회피
    if (f.name === 'raw_json' || f.name === 'value') return null;
    return camelCase(f.name);
  }
  return null;
}

function camelCase(s) {
  return s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
}

// ─── Output 생성 ──────────────────────────────────────────────────────────

function generateOutput({ services, messages }, overrides) {
  const aliases = overrides.aliases ?? {};
  const unwrapOverrides = overrides.unwrap ?? {};
  const wrapMethods = new Set(overrides.wrap ?? []);
  const collisions = detectCollisions(services);

  const lines = [];
  lines.push('// AUTO-GENERATED by scripts/gen-adapter-tables.mjs — DO NOT EDIT.');
  lines.push('// Phase 4 정공: proto schema 가 source of truth.');
  lines.push('// 새 RPC 추가: 1) proto/firebat.proto 수정 2) `npm run gen:adapter` 실행');
  lines.push('// alias / wrap / unwrap override: proto/adapter-overrides.json');
  lines.push('');
  lines.push('export interface AdapterMethodEntry {');
  lines.push('  service: string;');
  lines.push('  rpc: string;');
  lines.push('  requestType: string;');
  lines.push('  responseType: string;');
  lines.push('  wrap: boolean;');
  lines.push('  unwrapField: string | null;');
  lines.push('}');
  lines.push('');
  lines.push('export const METHOD_TABLE_AUTO: Record<string, AdapterMethodEntry> = {');

  // 각 RPC 마다 entry — default facade 이름 + alias 추가
  const written = new Set();
  for (const svc of services) {
    for (const rpc of svc.rpcs) {
      const unwrapField = unwrapOverrides[rpc.name] !== undefined
        ? unwrapOverrides[rpc.name]
        : determineUnwrapField(rpc.responseType, messages);
      const defaultName = defaultFacadeName(svc.name, rpc.name, collisions);
      const entry = `{ service: '${svc.name}', rpc: '${rpc.name}', requestType: '${rpc.requestType}', responseType: '${rpc.responseType}', wrap: ${wrapMethods.has(defaultName)}, unwrapField: ${unwrapField ? `'${unwrapField}'` : 'null'} }`;
      if (!written.has(defaultName)) {
        lines.push(`  ${defaultName}: ${entry},`);
        written.add(defaultName);
      }
    }
  }
  // Aliases — 옛 facade name 호환
  for (const [alias, target] of Object.entries(aliases)) {
    const [svcName, rpcName] = target.split('.');
    const svc = services.find(s => s.name === svcName);
    const rpc = svc?.rpcs.find(r => r.name === rpcName);
    if (!rpc) {
      console.warn(`[gen-adapter-tables] alias ${alias} → ${target} 미발견 RPC`);
      continue;
    }
    const unwrapField = unwrapOverrides[rpc.name] !== undefined
      ? unwrapOverrides[rpc.name]
      : determineUnwrapField(rpc.responseType, messages);
    const entry = `{ service: '${svcName}', rpc: '${rpcName}', requestType: '${rpc.requestType}', responseType: '${rpc.responseType}', wrap: ${wrapMethods.has(alias)}, unwrapField: ${unwrapField ? `'${unwrapField}'` : 'null'} }`;
    if (!written.has(alias)) {
      lines.push(`  ${alias}: ${entry},`);
      written.add(alias);
    }
  }
  lines.push('};');
  lines.push('');

  // RESPONSE_UNWRAP_TABLE_AUTO — 호환성 view (옛 form 으로도 export)
  lines.push('export const RESPONSE_UNWRAP_TABLE_AUTO: Record<string, string> = {};');
  lines.push('for (const [k, v] of Object.entries(METHOD_TABLE_AUTO)) {');
  lines.push('  if (v.unwrapField) RESPONSE_UNWRAP_TABLE_AUTO[k] = v.unwrapField;');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────

function loadOverrides() {
  if (!existsSync(OVERRIDES_PATH)) return { aliases: {}, wrap: [], unwrap: {} };
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[gen-adapter-tables] overrides parse 실패: ${err.message}`);
    return { aliases: {}, wrap: [], unwrap: {} };
  }
}

function main() {
  const text = readFileSync(PROTO_PATH, 'utf8');
  const parsed = parseProto(text);
  const overrides = loadOverrides();
  const output = generateOutput(parsed, overrides);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, output);

  let rpcCount = 0;
  let unwrapCount = 0;
  for (const svc of parsed.services) {
    rpcCount += svc.rpcs.length;
    for (const rpc of svc.rpcs) {
      const unwrap = overrides.unwrap?.[rpc.name] !== undefined
        ? overrides.unwrap[rpc.name]
        : determineUnwrapField(rpc.responseType, parsed.messages);
      if (unwrap) unwrapCount++;
    }
  }

  console.log(`[gen-adapter-tables] ${parsed.services.length} services, ${rpcCount} RPCs`);
  console.log(`[gen-adapter-tables] aliases: ${Object.keys(overrides.aliases ?? {}).length}`);
  console.log(`[gen-adapter-tables] wrap methods: ${(overrides.wrap ?? []).length}`);
  console.log(`[gen-adapter-tables] unwrap entries: ${unwrapCount}`);
  console.log(`[gen-adapter-tables] output: ${OUTPUT_PATH}`);
}

main();

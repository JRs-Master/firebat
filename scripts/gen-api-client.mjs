#!/usr/bin/env node
/**
 * API client codegen — Option 2 정공 (2026-05-15).
 *
 * proto/firebat.proto + proto/adapter-overrides.json 의 facade alias →
 * lib/api-gen/{service}.ts 자동 생성.
 *
 * 산출 형태:
 *   export async function login(args: LoginRequest): Promise<RpcResult<LoginResponsePb>> {
 *     try {
 *       const response = await client.login(toMessage(args));
 *       return { ok: true, data: response };
 *     } catch (err) {
 *       return toRpcError(err);
 *     }
 *   }
 *
 * 옛 callTypedClient + METHOD_TABLE_AUTO + ARGS_TABLE + RESPONSE_UNWRAP_TABLE + RustCoreProxy
 * runtime indirection 완전 폐기. 호출 site 는 `import { login } from '@/lib/api-gen/auth'`
 * 식 직접 import.
 *
 * 자동 unwrap (proto schema 기반):
 *  - Empty → RpcResult<void> (data 생략)
 *  - 단일 field message (BoolRequest.value / StringRequest.value 등) → field 자동 unwrap
 *  - RawJsonPb { rawJson } → JSON.parse 후 unknown
 *  - OptionalStringPb { present, value } → string | null
 *  - 다중 field → 그대로 반환 (typed Pb 객체)
 *
 * adapter-overrides.json 의 aliases — service 외부 export 도 같이 생성. 새 RPC 추가 시:
 *   1. proto/firebat.proto 수정
 *   2. npm run gen:proto (protoc-gen-es 자동) → npm run gen:api (본 script)
 *   3. lib/api-gen/{service}.ts 자동 갱신 — caller import 즉시 사용
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, '..', 'proto', 'firebat.proto');
const OVERRIDES_PATH = resolve(__dirname, '..', 'proto', 'adapter-overrides.json');
const OUTPUT_DIR = resolve(__dirname, '..', 'lib', 'api-gen');

// ─── Proto parser (gen-adapter-tables.mjs 와 동일) ────────────────────────

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

function camelCase(s) {
  return s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
}

function pascalCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** JavaScript reserved word — 함수명 직접 사용 불가. service prefix 박은 형태로 fallback. */
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'let', 'static', 'await', 'async', 'package', 'private',
  'protected', 'public', 'interface', 'implements',
]);

/** service.rpc → public function name. RPC short name 이 reserved 면 `<short><Domain>` 으로. */
function publicFnName(serviceName, rpcName) {
  const rpcCamel = rpcName.charAt(0).toLowerCase() + rpcName.slice(1);
  if (RESERVED_WORDS.has(rpcCamel)) {
    const domain = serviceName.replace(/Service$/, '');
    return rpcCamel + domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  return rpcCamel;
}

// ─── Codegen helpers ──────────────────────────────────────────────────────

/** service name → file name (camelCase 의 service prefix 만, e.g. AuthService → auth). */
function serviceFileName(serviceName) {
  return serviceName.replace(/Service$/, '').toLowerCase();
}

/** response message → unwrap meta. */
function unwrapMeta(msgName, messages) {
  if (!msgName || msgName === 'Empty') {
    return { kind: 'void', dataType: 'void' };
  }
  const msg = messages[msgName];
  if (msgName === 'RawJsonPb') {
    return { kind: 'rawJson', dataType: 'unknown' };
  }
  if (msgName === 'OptionalStringPb') {
    return { kind: 'optionalString', dataType: 'string | null' };
  }
  if (!msg || msg.fields.length === 0) {
    return { kind: 'message', dataType: msgName };
  }
  if (msg.fields.length === 1) {
    const f = msg.fields[0];
    const fieldName = camelCase(f.name);
    let scalar = null;
    if (f.type === 'string') scalar = 'string';
    else if (f.type === 'int64' || f.type === 'int32' || f.type === 'uint32' || f.type === 'uint64' || f.type === 'float' || f.type === 'double') {
      scalar = f.type === 'int64' || f.type === 'uint64' ? 'bigint' : 'number';
    } else if (f.type === 'bool') scalar = 'boolean';
    if (scalar && !f.repeated) {
      return { kind: 'singleField', dataType: scalar, fieldName };
    }
  }
  return { kind: 'message', dataType: msgName };
}

/** request message → arg signature.
 *
 * protobuf-es 2.x — caller 가 plain object literal 박을 수 있도록 `MessageInitShape<typeof XSchema>`
 * 박음. `Message<TName>` brand 강제 회피. createClient 가 init shape 받음 (자동 변환).
 */
function requestSig(msgName, messages) {
  if (!msgName || msgName === 'Empty') {
    return { argType: 'void', schemaImport: null, toRequest: '{}' };
  }
  const msg = messages[msgName];
  if (!msg) {
    return {
      argType: `MessageInitShape<typeof ${msgName}Schema>`,
      schemaImport: `${msgName}Schema`,
      toRequest: 'args',
    };
  }
  // Empty 외 — typed Request message. MessageInitShape + schema descriptor 사용.
  return {
    argType: `MessageInitShape<typeof ${msgName}Schema>`,
    schemaImport: `${msgName}Schema`,
    toRequest: 'args ?? {}',
  };
}

/** typed function body 생성. */
function generateFunctionBody(rpc, messages, clientVar, serviceName) {
  // client method 명 (camelCase) — protoc-gen-es 가 자동 생성한 client property 명.
  const clientMethod = rpc.name.charAt(0).toLowerCase() + rpc.name.slice(1);
  // 외부 export 명 — reserved word 회피.
  const rpcCamel = publicFnName(serviceName, rpc.name);
  const req = requestSig(rpc.requestType, messages);
  const unwrap = unwrapMeta(rpc.responseType, messages);
  const schemaImport = req.schemaImport;

  let unwrapLogic;
  if (unwrap.kind === 'void') {
    unwrapLogic = `      await ${clientVar}.${clientMethod}(${req.toRequest});\n      return { ok: true, data: undefined };`;
  } else if (unwrap.kind === 'rawJson') {
    unwrapLogic = `      const response = await ${clientVar}.${clientMethod}(${req.toRequest});\n      return { ok: true, data: JSON.parse(response.rawJson) };`;
  } else if (unwrap.kind === 'optionalString') {
    unwrapLogic = `      const response = await ${clientVar}.${clientMethod}(${req.toRequest});\n      return { ok: true, data: response.present ? response.value : null };`;
  } else if (unwrap.kind === 'singleField') {
    unwrapLogic = `      const response = await ${clientVar}.${clientMethod}(${req.toRequest});\n      return { ok: true, data: response.${unwrap.fieldName} };`;
  } else {
    unwrapLogic = `      const response = await ${clientVar}.${clientMethod}(${req.toRequest});\n      return { ok: true, data: response };`;
  }

  return { rpcCamel, argType: req.argType, dataType: unwrap.dataType, unwrapLogic, schemaImport };
}

// ─── Output 생성 ──────────────────────────────────────────────────────────

function generateServiceFile(svc, messages, aliases) {
  const fileName = serviceFileName(svc.name);
  const clientVar = `${fileName}Client`;
  const imports = new Set([svc.name]);
  const schemaImports = new Set();
  let needsInitShape = false;
  const lines = [];

  // 함수 본문 미리 생성 (import 필요한 type 식별 위함)
  const fnBodies = [];
  for (const rpc of svc.rpcs) {
    const { rpcCamel, argType, dataType, unwrapLogic, schemaImport } = generateFunctionBody(rpc, messages, clientVar, svc.name);
    if (schemaImport) {
      schemaImports.add(schemaImport);
      needsInitShape = true;
    }
    if (!['string', 'number', 'boolean', 'bigint', 'string | null', 'unknown', 'void'].includes(dataType)) {
      imports.add(dataType);
    }
    fnBodies.push({ rpcCamel, argType, dataType, unwrapLogic, originalName: rpc.name });
  }

  // alias 별도 export (옛 facade name → 같은 함수 본문)
  const svcAliases = [];
  for (const [alias, target] of Object.entries(aliases)) {
    const [svcName, rpcName] = target.split('.');
    if (svcName === svc.name) {
      const rpc = svc.rpcs.find(r => r.name === rpcName);
      if (rpc) {
        const fnInfo = fnBodies.find(b => b.originalName === rpcName);
        if (fnInfo) svcAliases.push({ alias, base: fnInfo.rpcCamel });
      }
    }
  }

  lines.push('// AUTO-GENERATED by scripts/gen-api-client.mjs — DO NOT EDIT.');
  lines.push(`// Source: proto/firebat.proto / ${svc.name}`);
  lines.push('//');
  lines.push('// 새 RPC 추가: 1) proto/firebat.proto 수정 2) npm run gen:proto 3) npm run gen:api');
  lines.push('// alias 추가: proto/adapter-overrides.json 의 aliases 영역');
  lines.push('');
  const sortedImports = [...imports, ...schemaImports].filter(t => t !== 'Empty').sort();
  if (sortedImports.length > 0) {
    lines.push(`import {`);
    lines.push(`  ${sortedImports.join(',\n  ')},`);
    lines.push(`} from '../proto-gen/firebat_pb';`);
  } else {
    lines.push(`import { ${svc.name} } from '../proto-gen/firebat_pb';`);
  }
  if (needsInitShape) {
    lines.push(`import { type MessageInitShape } from '@bufbuild/protobuf';`);
  }
  lines.push(`import { transport } from './_transport';`);
  lines.push(`import { createClient } from '@connectrpc/connect';`);
  lines.push(`import { type RpcResult, toRpcError } from './types';`);
  lines.push('');
  lines.push(`const ${clientVar} = createClient(${svc.name}, transport);`);
  lines.push('');

  for (const fn of fnBodies) {
    const argDecl = fn.argType === 'void' ? '' : `args: ${fn.argType}`;
    const returnType = fn.dataType === 'void' ? 'RpcResult<void>' : `RpcResult<${fn.dataType}>`;
    lines.push(`export async function ${fn.rpcCamel}(${argDecl}): Promise<${returnType}> {`);
    lines.push(`  try {`);
    lines.push(fn.unwrapLogic);
    lines.push(`  } catch (err) {`);
    lines.push(`    return toRpcError(err);`);
    lines.push(`  }`);
    lines.push(`}`);
    lines.push('');
  }

  // alias re-export (옛 facade name 호환)
  for (const { alias, base } of svcAliases) {
    if (alias !== base) {
      lines.push(`export const ${alias} = ${base};`);
    }
  }
  if (svcAliases.length > 0) lines.push('');

  return { fileName, content: lines.join('\n') };
}

function generateTransport() {
  return `// AUTO-GENERATED by scripts/gen-api-client.mjs — DO NOT EDIT.
// Shared gRPC transport for all api-gen modules.

import { createGrpcTransport } from '@connectrpc/connect-node';

const baseUrl = process.env.FIREBAT_CORE_GRPC
  ? \`http://\${process.env.FIREBAT_CORE_GRPC}\`
  : 'http://127.0.0.1:50051';

export const transport = createGrpcTransport({ baseUrl });
`;
}

function generateIndex(services, aliases) {
  const lines = [];
  lines.push('// AUTO-GENERATED by scripts/gen-api-client.mjs — DO NOT EDIT.');
  lines.push('// 타입 재export — RpcResult / RpcErrorCode / toRpcError.');
  lines.push('// service-specific import 권장: `import { savePage } from \'@/lib/api-gen/page\'`');
  lines.push('// (collision 회피 + tree-shaking 친화)');
  lines.push('');
  lines.push(`export * from './types';`);
  lines.push('');
  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────

function loadOverrides() {
  if (!existsSync(OVERRIDES_PATH)) return { aliases: {} };
  try {
    return JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[gen-api-client] overrides parse 실패: ${err.message}`);
    return { aliases: {} };
  }
}

function main() {
  const text = readFileSync(PROTO_PATH, 'utf8');
  const parsed = parseProto(text);
  const overrides = loadOverrides();
  const aliases = overrides.aliases ?? {};

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // 옛 service 파일 정리 (이번 codegen 산출 외).
  const expectedFiles = new Set(parsed.services.map(s => `${serviceFileName(s.name)}.ts`));
  expectedFiles.add('_transport.ts');
  expectedFiles.add('types.ts');
  expectedFiles.add('index.ts');
  for (const f of readdirSync(OUTPUT_DIR)) {
    if (!expectedFiles.has(f)) {
      unlinkSync(resolve(OUTPUT_DIR, f));
      console.log(`[gen-api-client] removed stale: ${f}`);
    }
  }

  // transport
  writeFileSync(resolve(OUTPUT_DIR, '_transport.ts'), generateTransport());

  // 각 service file
  for (const svc of parsed.services) {
    const { fileName, content } = generateServiceFile(svc, parsed.messages, aliases);
    writeFileSync(resolve(OUTPUT_DIR, `${fileName}.ts`), content);
  }

  // index re-export
  writeFileSync(resolve(OUTPUT_DIR, 'index.ts'), generateIndex(parsed.services, aliases));

  let rpcCount = 0;
  for (const svc of parsed.services) rpcCount += svc.rpcs.length;
  console.log(`[gen-api-client] ${parsed.services.length} services, ${rpcCount} RPCs`);
  console.log(`[gen-api-client] aliases: ${Object.keys(aliases).length}`);
  console.log(`[gen-api-client] output: ${OUTPUT_DIR}/`);
}

main();

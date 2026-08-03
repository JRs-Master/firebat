#!/usr/bin/env node
/**
 * 한투 sysmod codegen — `_apis.json` 입력 → `config.json` + `index.mjs` 생성.
 *
 * Output: `system/modules/{korea-invest,korea-invest-trade}/config.json` — the action enum only
 *
 * 사용:
 *   cd system/modules/korea-invest && node scripts/gen.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');




function build(apis) {
  const apiTable = {};
  for (const api of apis) {
    apiTable[api.id] = {
      method: api.method,
      path: api.path,
      trIdReal: api.trIdReal || '',
      trIdMock: api.trIdMock || '',
      name: api.name,
    };
  }


  const allActions = apis
    .filter((a) => a.menu !== 'OAuth인증')
    .map((a) => a.id)
    .sort();

  const config = {
    name: 'korea-invest',
    type: 'module',
    scope: 'system',
    version: '1.0.0',
    description: '한국투자증권 OPEN API 통합 sysmod — 278 REST API + 9 도메인 (국내주식: 계좌/시세/순위/시세분석/ELW + 선물옵션·채권·해외주식·해외선물옵션). 도메인별 별도 LLM 도구로 노출.',
    runtime: 'node',
    capability: 'stock-trading',
    providerType: 'api',
    secrets: [
      { name: 'KIS_APP_KEY',      type: 'key' },
      { name: 'KIS_APP_SECRET',   type: 'key' },
      {
        name: 'KIS_ACCESS_TOKEN', type: 'token', lifetimeSec: 85800,
        // 토큰 생명주기는 인프라 TokenProvider 가 본 oauth 스펙으로 관리 (발급·선제갱신·재발급·Vault 영속).
        // sysmod 는 env 로 주입된 raw 토큰을 받아쓰기만 — 토큰 코드 0.
        oauth: {
          base: 'https://openapi.koreainvestment.com:9443',
          baseMock: 'https://openapivts.koreainvestment.com:29443',
          path: '/oauth2/tokenP', method: 'POST', contentType: 'application/json',
          body: { grant_type: 'client_credentials', appkey: '${KIS_APP_KEY}', appsecret: '${KIS_APP_SECRET}' },
          tokenField: 'access_token',
          invalidWhen: { match: 'all', conditions: [
            { field: 'rt_cd', equals: '1' },
            { field: 'msg1', regex: 'token|토큰' },
          ] },
        },
      },
    ],
    input: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: allActions,
          description: '한투 API ID 직접 호출 (예: v1_국내주식-008). 도메인별 LLM 도구로 분리 노출.',
        },
        query: {
          type: 'object',
          description: '한투 API request query parameter (GET API 의 필수).',
        },
        body: {
          type: 'object',
          description: '한투 API request body (POST API 의 필수).',
        },
        mock: {
          type: 'boolean',
          description: 'true 면 모의투자 도메인 호출. 기본 false (실전).',
        },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { apiId: { type: 'string' }, trId: { type: 'string' }, name: { type: 'string' } },
    },
  };

  return { config, tables: { API_TABLE: apiTable } };
}

const apisPath = resolve(MODULE_DIR, '_apis.json');
const apis = JSON.parse(readFileSync(apisPath, 'utf8'));
const { config, tables } = build(apis);

// Reconciler, not a generator. config.json is the MODULE SOURCE — hand-maintained blocks
// (actionCatalog / requiresApproval / grounding / timeseries / ws / tags / secrets …) are edited
// there and must survive a regen. Only the keys derived from `_apis.json` are overwritten; every
// other key is carried over from the existing config. A whitelist of "keys to preserve" rots the
// moment a new declarative block is added (실측: `ws` 58 스트림·`tags`·`timeseries` 는 whitelist 에
// 없어 regen 이 통째로 날릴 뻔했다) — so the rule is inverted: generated keys are enumerated, the
// rest is preserved by default.
// Generated keys are enumerated and everything else is preserved; `writeHalves` below applies the
// rule to each half. Reading it here as well would report on a single config that no longer exists.
const GENERATED_KEYS = ['input', 'output'];

// ── The API table ────────────────────────────────────────────────────────────────────────────
// The one part of the dialect the sheet owns. It used to live inside `_runtime/korea-invest-api.mjs`, which
// people edit, so the generator could not write it without destroying the hand-written half — and
// so it never wrote it at all and the table froze. Split along that seam, both halves can be
// owned by whoever should own them.
function writeTables(tables) {
  const banner = `/**
 * Korea Investment API table — **generated. Do not edit by hand.**
 *
 * Source: \`korea-invest-trade/_apis.json\` (the vendor's documentation sheet). Written by
 * \`korea-invest-trade/scripts/gen.mjs\`. The dialect in \`_runtime/korea-invest-api.mjs\` is hand-maintained, so a table
 * living inside it is a table the generator cannot reach — overwriting it would mean overwriting
 * the half a person wrote. The seam goes here instead.
 */
`;
  const body = Object.entries(tables)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value, null, 2)};\n`)
    .join('\n');
  const out = resolve(MODULE_DIR, '..', '_runtime', 'korea-invest-apis.generated.mjs');
  writeFileSync(out, banner + '\n' + body, 'utf8');
  console.log(`  _runtime/korea-invest-apis.generated.mjs: ${Object.keys(tables).join(', ')}`);
}

// ── Reconcile ────────────────────────────────────────────────────────────────────────────────
// Which half an action belongs to is the venue's own classification, read out of the sheet — the
// same signal the split was made with. Ids the sheet does not carry (the neutral broker contract,
// hand written in the dialect) stay wherever they are already declared: a generator that deletes
// what it cannot see is not a reconciler.
function writeHalves(sheetIds, isAccount) {
  const base = basename(MODULE_DIR).replace(/-trade$/, '');
  for (const [dir, wantAccount] of [[resolve(MODULE_DIR, '..', base), false], [MODULE_DIR, true]]) {
    const path = resolve(dir, 'config.json');
    let existing;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      console.log(`  (skip) ${basename(dir)} — no config.json`);
      continue;
    }
    const declared = existing.input?.properties?.action?.enum ?? [];
    const mine = sheetIds.filter((id) => isAccount(id) === wantAccount);
    const unknownToSheet = declared.filter((id) => !sheetIds.includes(id));
    const merged = { ...existing };
    // `input`/`output` are the generated pair, but only the enum inside `input` comes from the
    // sheet — the rest of the schema is authored here and the surrounding declaration is the
    // module's own.
    merged.input = {
      ...(existing.input ?? config.input),
      properties: {
        ...(existing.input?.properties ?? config.input.properties),
        action: {
          ...(existing.input?.properties?.action ?? config.input.properties.action),
          enum: [...mine, ...unknownToSheet],
        },
      },
    };
    merged.output = config.output;
    delete merged.domains;   // nothing reads it; it duplicated the action catalog and, on the
                             // public half, spelled out the account APIs it must not offer
    writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.log(`  ${basename(dir)}: ${mine.length} from the sheet + ${unknownToSheet.length} declared elsewhere`);
  }
}

// Korea Investment routes by URL: /trading/ is the account, everything else is data.
const PATH_BY_ID = Object.fromEntries(apis.map((a) => [a.id, a.path || '']));
const isAccountAction = (id) => {
  const p = PATH_BY_ID[id] || '';
  return p.includes('/trading/') || p.includes('/oauth');
};

// OAuth is the infrastructure's, not the module's: the token provider issues, refreshes and
// revokes, and the hash key is signing plumbing. The vendor groups all three under one menu, so
// that is the filter — the same signal the Kiwoom script uses for the same reason.
writeTables(tables);
writeHalves(
  apis.filter((a) => a.menu !== 'OAuth인증').map((a) => a.id).sort(),
  isAccountAction,
);
console.log(`✓ korea-invest — the dialect in _runtime/ is hand-maintained; only its API table is generated.`);

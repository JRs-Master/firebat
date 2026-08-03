#!/usr/bin/env node
/**
 * 키움 sysmod codegen — `_apis.json` 입력 → `config.json` + `index.mjs` 생성.
 *
 * 입력: `system/modules/kiwoom/_apis.json` (extract-apis.mjs 가 생성)
 * Output: `system/modules/{kiwoom,kiwoom-trade}/config.json` — the action enum, nothing else
 *
 * 도메인별 별도 LLM 도구 노출 (sysmod_kiwoom_account / sysmod_kiwoom_chart 등) —
 * `action` is the API id, called directly. The dialect belongs to `_runtime/` and this script
 * does not touch it.
 *
 * 사용:
 *   cd system/modules/kiwoom && node scripts/gen.mjs
 *
 * 옛 위치: `scripts/gen-stock-sysmods.mjs` 안 kiwoom + kis 통합 코드.
 * 단일 책임 정공 — sysmod 자체 안 자체 codegen.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');




// config.json is the module source. This is a reconciler: only what `_apis.json` derives (the
// action enum 과 URL_CATEGORY 포함)만 갱신하고 **나머지 키는 전부 보존**한다.
//
// ⚠️ 옛 방식(보존할 키를 whitelist)은 새 선언형 블록이 추가될 때마다 썩는다 — 실측으로 `tags`
// 가 whitelist 에 없어 regen 이 통째로 날릴 뻔했다(korea-invest 쪽은 `ws` 58 스트림과
// `timeseries` 까지). 규칙을 뒤집는다: **생성 키만 열거하고 나머지는 기본 보존.**
const GENERATED_KEYS = ['input', 'output'];

function build(apis) {
  let preserved = {};
  try {
    const existing = JSON.parse(readFileSync(resolve(MODULE_DIR, 'config.json'), 'utf8'));
    for (const k of Object.keys(existing)) {
      if (!GENERATED_KEYS.includes(k)) preserved[k] = existing[k];
    }
  } catch { /* no existing config — first bootstrap */ }

  const urlCategory = {};
  const apiNames = {};
  for (const api of apis) {
    if (api.path) {
      // dostk (국내) + us (미국주식) 두 패밀리 → /api/{family}/{category}. websocket 경로는
      // REST 디스패치 대상이 아님(ws 인프라 또는 unsupportedActions) → URL_CATEGORY 에서 제외.
      const m = api.path.match(/\/api\/(dostk|us)\/([^/]+)/);
      if (m && m[2] !== 'websocket') urlCategory[api.id] = `${m[1]}/${m[2]}`;
    }
    apiNames[api.id] = api.name;
  }


  const allActions = apis
    .filter((a) => a.category !== 'OAuth 인증')
    .map((a) => a.id)
    .sort();

  const config = {
    name: 'kiwoom',
    type: 'module',
    scope: 'system',
    version: '1.0.0',
    description: '키움증권 OPEN API 통합 sysmod — 국내(계좌·주문·시세·차트·순위·투자자·ETF/ELW·조건검색) + 미국주식(시세·주문·계좌·환전). action 으로 API ID 직접 호출, search_module_actions → get_action_schema 로 발견.',
    runtime: 'node',
    capability: 'stock-trading',
    providerType: 'api',
    secrets: [
      { name: 'KIWOOM_APP_KEY',      type: 'key' },
      { name: 'KIWOOM_APP_SECRET',   type: 'key' },
      {
        name: 'KIWOOM_ACCESS_TOKEN', type: 'token', lifetimeSec: 85800,
        // 토큰 생명주기는 인프라 TokenProvider 가 본 oauth 스펙으로 관리 (발급·선제갱신·재발급·Vault 영속).
        // sysmod 는 env 로 주입된 raw 토큰을 받아쓰기만 — 토큰 코드 0.
        oauth: {
          base: 'https://api.kiwoom.com',
          baseMock: 'https://mockapi.kiwoom.com',
          path: '/oauth2/token', method: 'POST', contentType: 'application/json;charset=UTF-8',
          body: { grant_type: 'client_credentials', appkey: '${KIWOOM_APP_KEY}', secretkey: '${KIWOOM_APP_SECRET}' },
          tokenField: 'token',
          invalidWhen: { match: 'any', conditions: [
            { field: 'return_code', equals: 3 },
            { field: 'return_msg', regex: '(?i)Token이 유효하지 않습니다|token.*invalid' },
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
          description: '키움 API ID 직접 호출 (예: ka10001 / kt00018). 도메인별 LLM 도구로 분리 노출되므로 각 도구는 자기 도메인의 actions 만 enum 으로 표시.',
        },
        params: {
          type: 'object',
          description: '키움 API request body 의 모든 필드. 각 API 의 필드는 키움 REST API 공식 문서 참조.',
        },
        mock: {
          type: 'boolean',
          description: 'true 면 모의투자 도메인 (mockapi.kiwoom.com) 호출. 기본 false (실전).',
        },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { apiId: { type: 'string' }, name: { type: 'string' } },
    },
    // 기존 config 의 모든 비-생성 키를 마지막에 얹어 하드코딩 기본값을 이기게 한다
    // (config.json 이 소스 — secrets 에 손으로 추가한 토큰도 regen 을 살아남는다).
    ...preserved,
  };

  return { config, tables: { URL_CATEGORY: urlCategory, API_NAMES: apiNames } };
}

const apisPath = resolve(MODULE_DIR, '_apis.json');
const apis = JSON.parse(readFileSync(apisPath, 'utf8'));
const { config, tables } = build(apis);

// ── The API table ────────────────────────────────────────────────────────────────────────────
// The one part of the dialect the sheet owns. It used to live inside `_runtime/kiwoom-api.mjs`, which
// people edit, so the generator could not write it without destroying the hand-written half — and
// so it never wrote it at all and the table froze. Split along that seam, both halves can be
// owned by whoever should own them.
function writeTables(tables) {
  const banner = `/**
 * Kiwoom API table — **generated. Do not edit by hand.**
 *
 * Source: \`kiwoom-trade/_apis.json\` (the vendor's documentation sheet). Written by
 * \`kiwoom-trade/scripts/gen.mjs\`. The dialect in \`_runtime/kiwoom-api.mjs\` is hand-maintained, so a table
 * living inside it is a table the generator cannot reach — overwriting it would mean overwriting
 * the half a person wrote. The seam goes here instead.
 */
`;
  const body = Object.entries(tables)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value, null, 2)};\n`)
    .join('\n');
  const out = resolve(MODULE_DIR, '..', '_runtime', 'kiwoom-apis.generated.mjs');
  writeFileSync(out, banner + '\n' + body, 'utf8');
  console.log(`  _runtime/kiwoom-apis.generated.mjs: ${Object.keys(tables).join(', ')}`);
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

// Kiwoom labels every API with a subCategory; four of those touch money.
const KIWOOM_MONEY = new Set(['계좌', '주문', '신용주문', '환전']);
const SUB_BY_ID = Object.fromEntries(apis.map((a) => [a.id, a.subCategory]));
const isAccountAction = (id) => KIWOOM_MONEY.has(SUB_BY_ID[id]);

writeTables(tables);
writeHalves(apis.filter((a) => a.category !== 'OAuth 인증').map((a) => a.id).sort(), isAccountAction);
console.log(`✓ kiwoom — the dialect in _runtime/ is hand-maintained; only its API table is generated.`);

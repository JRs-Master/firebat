#!/usr/bin/env node
/**
 * 키움 sysmod codegen — `_apis.json` 입력 → `config.json` + `index.mjs` 생성.
 *
 * 입력: `system/modules/kiwoom/_apis.json` (extract-apis.mjs 가 생성)
 * 출력: `system/modules/kiwoom/{config.json, index.mjs}` — 208 APIs, 8 domains
 *
 * 도메인별 별도 LLM 도구 노출 (sysmod_kiwoom_account / sysmod_kiwoom_chart 등) —
 * MCP register_sysmod_tools 안 domains[] 분기. action = API ID 직접 호출.
 *
 * 사용:
 *   cd system/modules/kiwoom && node scripts/gen.mjs
 *
 * 옛 위치: `scripts/gen-stock-sysmods.mjs` 안 kiwoom + kis 통합 코드.
 * 단일 책임 정공 — sysmod 자체 안 자체 codegen.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');

const DOMAIN_MAP = {
  '계좌': 'account',
  '주문': 'order',
  '신용주문': 'order',
  '시세': 'quote',
  '종목정보': 'quote',
  '업종': 'quote',
  '차트': 'chart',
  '순위정보': 'ranking',
  '기관/외국인': 'investor',
  '대차거래': 'investor',
  '공매도': 'investor',
  'ETF': 'etf-elw',
  'ELW': 'etf-elw',
  '조건검색': 'condition-theme',
  '테마': 'condition-theme',
  '실시간시세': 'realtime',
};

const DOMAIN_DESC = {
  'account': '키움증권 계좌 (잔고·예수금·자산·수익률·체결·미체결·매매일지)',
  'order': '키움증권 주문 (현금/신용/금현물 매수·매도·정정·취소)',
  'quote': '키움증권 시세 + 종목정보 + 업종 (현재가·호가·체결·일별주가·종목기본정보)',
  'chart': '키움증권 차트 (틱/분봉/일봉/주봉/월봉/년봉 — 주식·업종·금현물)',
  'ranking': '키움증권 실시간 순위정보 (등락률·거래량·호가잔량·외인·신용비율 등)',
  'investor': '키움증권 투자자 동향 (기관/외국인·대차거래·공매도)',
  'etf-elw': '키움증권 ETF + ELW (수익률·민감도·괴리율·조건검색)',
  'condition-theme': '키움증권 조건검색 + 테마 (사용자 정의 조건·테마 그룹별 종목)',
};

const DOMAIN_CAPABILITY = {
  'account': 'stock-trading',
  'order': 'stock-trading',
  'quote': 'stock-quote',
  'chart': 'stock-quote',
  'ranking': 'stock-quote',
  'investor': 'stock-quote',
  'etf-elw': 'stock-quote',
  'condition-theme': 'stock-quote',
};

function build(apis) {
  const urlCategory = {};
  const apiNames = {};
  for (const api of apis) {
    if (api.path) {
      const m = api.path.match(/\/api\/dostk\/([^/]+)/);
      if (m) urlCategory[api.id] = m[1];
    }
    apiNames[api.id] = api.name;
  }

  const byDomain = {};
  for (const api of apis) {
    if (api.category === 'OAuth 인증') continue;
    const domain = DOMAIN_MAP[api.subCategory];
    if (!domain || domain === 'realtime') continue;
    (byDomain[domain] ||= []).push(api);
  }

  const domains = Object.entries(byDomain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, apis]) => ({
      name,
      description: DOMAIN_DESC[name] || `키움 ${name}`,
      capability: DOMAIN_CAPABILITY[name] || 'stock-quote',
      actions: apis.map((a) => a.id).sort(),
      actionsCount: apis.length,
      actionsDetail: apis.map((a) => `  ${a.id} — ${a.name}`).join('\n'),
    }));

  const allActions = apis
    .filter((a) => a.category !== 'OAuth 인증')
    .map((a) => a.id)
    .sort();

  const config = {
    name: 'kiwoom',
    type: 'module',
    scope: 'system',
    version: '1.0.0',
    description: '키움증권 OPEN API 통합 sysmod — 208 REST API + 8 도메인 (계좌·주문·시세·차트·순위·투자자·ETF/ELW·조건검색/테마). 도메인별 별도 LLM 도구로 노출 (sysmod_kiwoom_account / sysmod_kiwoom_chart 등) — 단일 코드.',
    runtime: 'node',
    capability: 'stock-trading',
    providerType: 'api',
    secrets: ['KIWOOM_APP_KEY', 'KIWOOM_APP_SECRET'],
    tokenCache: { secretName: 'KIWOOM_ACCESS_TOKEN', ttlHours: 23 },
    domains: domains.map(({ name, description, capability, actions, actionsCount, actionsDetail }) => ({
      name,
      description: `${description}\n총 ${actionsCount}개 API. action 으로 API ID 직접 호출:\n${actionsDetail}`,
      capability,
      actions,
    })),
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
  };

  const index = `#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom — codegen 자동 생성 (scripts/gen.mjs).
 * 키움증권 OPEN API 통합 (208 REST API).
 *
 * LLM 시점: config.json 의 domains[] 가 MCP register_sysmod_tools 에 의해 8개 별도 도구로 분리 등록
 * (sysmod_kiwoom_account / sysmod_kiwoom_chart 등). 모든 도구가 본 단일 모듈로 라우팅. action 으로
 * API ID (ka10001 등) 직접 호출.
 *
 * OAuth + callApi + throttle (초당 5회) 내장.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 카테고리 (POST /api/dostk/{category} + api-id 헤더)
const URL_CATEGORY = ${JSON.stringify(urlCategory, null, 2)};
// API ID → 한글명 (에러 메시지 + 결과 enrichment)
const API_NAMES = ${JSON.stringify(apiNames, null, 2)};

async function getAccessToken(base, appKey, appSecret, forceNew = false) {
  if (!forceNew) {
    const cached = process.env['KIWOOM_ACCESS_TOKEN'];
    if (cached) return { token: cached, isNew: false };
  }
  const resp = await fetch(\`\${base}/oauth2/token\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: appSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(\`토큰 발급 실패: \${resp.status}\`);
  const json = await resp.json();
  if (!json.token) throw new Error(\`토큰 응답 오류: \${JSON.stringify(json)}\`);
  return { token: json.token, isNew: true };
}

const RATE_LIMIT = 5;
const WINDOW_MS = 1000;
const _reqTimes = [];
async function acquireSlot() {
  while (true) {
    const now = Date.now();
    while (_reqTimes.length > 0 && now - _reqTimes[0] >= WINDOW_MS) _reqTimes.shift();
    if (_reqTimes.length < RATE_LIMIT) { _reqTimes.push(now); return; }
    await new Promise(r => setTimeout(r, WINDOW_MS - (now - _reqTimes[0]) + 5));
  }
}

async function callApi(base, token, apiId, params = {}, retry = 2) {
  const category = URL_CATEGORY[apiId];
  if (!category) throw new Error(\`알 수 없는 API ID: \${apiId}. 키움 REST API 문서 참조.\`);
  const url = \`\${base}/api/dostk/\${category}\`;
  await acquireSlot();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': \`Bearer \${token}\`,
      'api-id': apiId,
      'cont-yn': 'N',
      'next-key': '',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, apiId, params, retry - 1);
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(\`키움 API \${resp.status}: \${resp.statusText} \${errText}\`.trim());
  }
  return await resp.json();
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 키움 API ID (ka10001 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom 에서 등록하세요.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    let { token, isNew } = await getAccessToken(base, appKey, appSecret);
    const params = data.params || {};
    let result = await callApi(base, token, action, params);
    const isTokenInvalid = result?.return_code === 3 || /Token이 유효하지 않습니다|token.*invalid/i.test(result?.return_msg || '');
    if (isTokenInvalid && !isNew) {
      const fresh = await getAccessToken(base, appKey, appSecret, true);
      token = fresh.token;
      isNew = true;
      result = await callApi(base, token, action, params);
    }
    const output = { success: true, data: { apiId: action, name: API_NAMES[action], ...result } };
    if (isNew) output.__updateSecrets = { KIWOOM_ACCESS_TOKEN: token };
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});
`;

  return { config, index };
}

const apisPath = resolve(MODULE_DIR, '_apis.json');
const apis = JSON.parse(readFileSync(apisPath, 'utf8'));
const { config, index } = build(apis);

writeFileSync(resolve(MODULE_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
writeFileSync(resolve(MODULE_DIR, 'index.mjs'), index, 'utf8');

const allCount = config.input.properties.action.enum.length;
console.log(`✓ kiwoom — ${allCount} actions / ${config.domains.length} domains`);
for (const d of config.domains) {
  console.log(`  ${d.name}: ${d.actions.length} actions (${d.capability})`);
}

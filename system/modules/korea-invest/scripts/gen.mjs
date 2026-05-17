#!/usr/bin/env node
/**
 * 한투 sysmod codegen — `_apis.json` 입력 → `config.json` + `index.mjs` 생성.
 *
 * 출력: `system/modules/korea-invest/{config.json, index.mjs}` — 278 APIs, 9 domains.
 *
 * 사용:
 *   cd system/modules/korea-invest && node scripts/gen.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = resolve(__dirname, '..');

const DOMAIN_MAP = {
  '[국내주식] 주문/계좌': 'stock-account',
  '[국내주식] 기본시세': 'stock-quote',
  '[국내주식] 종목정보': 'stock-quote',
  '[국내주식] 업종/기타': 'stock-quote',
  '[국내주식] 순위분석': 'stock-ranking',
  '[국내주식] 시세분석': 'stock-analysis',
  '[국내주식] ELW 시세': 'stock-elw',
  '[국내주식] 실시간시세': 'stock-realtime',
  '[국내선물옵션] 기본시세': 'futures',
  '[국내선물옵션] 주문/계좌': 'futures',
  '[장내채권] 기본시세': 'bond',
  '[장내채권] 주문/계좌': 'bond',
  '[해외주식] 기본시세': 'overseas-stock',
  '[해외주식] 시세분석': 'overseas-stock',
  '[해외주식] 주문/계좌': 'overseas-stock',
  '[해외선물옵션] 기본시세': 'overseas-futures',
  '[해외선물옵션] 주문/계좌': 'overseas-futures',
};

const DOMAIN_DESC = {
  'stock-account': '한국투자증권 국내주식 주문/계좌 (잔고·매수가능·정정취소·예약주문·수익현황)',
  'stock-quote': '한국투자증권 국내주식 기본시세 + 종목정보 + 업종/기타 (현재가·호가·체결·일자별·종목정보)',
  'stock-ranking': '한국투자증권 국내주식 순위분석 (거래량·등락률·시가총액·수익자산지표 등)',
  'stock-analysis': '한국투자증권 국내주식 시세분석 (투자자·프로그램매매·신용잔고·체결강도·매물대 등)',
  'stock-elw': '한국투자증권 국내주식 ELW 시세 (현재가·민감도·변동성·기초자산·조건검색)',
  'futures': '한국투자증권 국내선물옵션 (시세 + 주문/계좌) — 야간 포함',
  'bond': '한국투자증권 장내채권 (시세 + 주문/계좌)',
  'overseas-stock': '한국투자증권 해외주식 (시세 + 시세분석 + 주문/계좌) — 미국·아시아 포함',
  'overseas-futures': '한국투자증권 해외선물옵션 (시세 + 주문/계좌)',
};

const DOMAIN_CAPABILITY = {
  'stock-account': 'stock-trading',
  'stock-quote': 'stock-quote',
  'stock-ranking': 'stock-quote',
  'stock-analysis': 'stock-quote',
  'stock-elw': 'stock-quote',
  'futures': 'stock-trading',
  'bond': 'stock-trading',
  'overseas-stock': 'stock-trading',
  'overseas-futures': 'stock-trading',
};

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

  const byDomain = {};
  for (const api of apis) {
    if (api.menu === 'OAuth인증') continue;
    const domain = DOMAIN_MAP[api.menu];
    if (!domain || domain === 'stock-realtime') continue;
    (byDomain[domain] ||= []).push(api);
  }

  const domains = Object.entries(byDomain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, apis]) => ({
      name,
      description: DOMAIN_DESC[name] || `한투 ${name}`,
      capability: DOMAIN_CAPABILITY[name] || 'stock-quote',
      actions: apis.map((a) => a.id).sort(),
      actionsCount: apis.length,
      actionsDetail: apis
        .map((a) => `  ${a.id} (TR_ID: ${a.trIdReal || 'N/A'}) — ${a.name}`)
        .join('\n'),
    }));

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
    secrets: ['KIS_APP_KEY', 'KIS_APP_SECRET'],
    tokenCache: { secretName: 'KIS_ACCESS_TOKEN', ttlHours: 23 },
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

  const index = `#!/usr/bin/env node
/**
 * Firebat System Module: korea-invest — codegen 자동 생성 (scripts/gen.mjs).
 * 한국투자증권 OPEN API 통합 (278 REST API).
 *
 * LLM 시점: config.json 의 domains[] 가 9개 별도 도구로 분리 등록.
 * 단일 모듈로 라우팅 — action 으로 API ID 직접 호출, tr_id 자동 분기 (실전/모의).
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

const API_TABLE = ${JSON.stringify(apiTable, null, 2)};

async function getAccessToken(base, appKey, appSecret, forceNew = false) {
  if (!forceNew) {
    const cached = process.env['KIS_ACCESS_TOKEN'];
    if (cached) return { token: cached, isNew: false };
  }
  const resp = await fetch(\`\${base}/oauth2/tokenP\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(\`KIS 토큰 발급 실패: \${resp.status}\`);
  const json = await resp.json();
  if (!json.access_token) throw new Error(\`KIS 토큰 응답 오류: \${JSON.stringify(json)}\`);
  return { token: json.access_token, isNew: true };
}

const RATE_LIMIT = 20;
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

async function callApi(base, token, appKey, appSecret, action, query = {}, body = {}, isMock = false, retry = 2) {
  const meta = API_TABLE[action];
  if (!meta) throw new Error(\`알 수 없는 API ID: \${action}. 한투 OPEN API 문서 참조.\`);
  const trId = isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal;
  if (isMock && !meta.trIdMock) throw new Error(\`\${action} (\${meta.name}) 은 모의투자 미지원입니다.\`);
  let url = \`\${base}\${meta.path}\`;
  if (meta.method === 'GET' && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += \`?\${qs}\`;
  }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'authorization': \`Bearer \${token}\`,
    'appkey': appKey,
    'appsecret': appSecret,
    'tr_id': trId,
    'custtype': 'P',
  };
  await acquireSlot();
  const init = { method: meta.method, headers, signal: AbortSignal.timeout(15000) };
  if (meta.method !== 'GET' && Object.keys(body).length > 0) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1);
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(\`KIS API \${resp.status}: \${resp.statusText} \${errText}\`.trim());
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
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 한투 API ID (v1_국내주식-008 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIS_APP_KEY'];
    const appSecret = process.env['KIS_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > korea-invest 에서 등록하세요.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    let { token, isNew } = await getAccessToken(base, appKey, appSecret);
    const query = data.query || {};
    const body = data.body || {};
    let result = await callApi(base, token, appKey, appSecret, action, query, body, isMock);
    const isTokenInvalid = result?.rt_cd === '1' && /token|토큰/.test(result?.msg1 || '');
    if (isTokenInvalid && !isNew) {
      const fresh = await getAccessToken(base, appKey, appSecret, true);
      token = fresh.token;
      isNew = true;
      result = await callApi(base, token, appKey, appSecret, action, query, body, isMock);
    }
    const meta = API_TABLE[action];
    const output = { success: true, data: { apiId: action, trId: isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal, name: meta.name, ...result } };
    if (isNew) output.__updateSecrets = { KIS_ACCESS_TOKEN: token };
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
console.log(`✓ korea-invest — ${allCount} actions / ${config.domains.length} domains`);
for (const d of config.domains) {
  console.log(`  ${d.name}: ${d.actions.length} actions (${d.capability})`);
}

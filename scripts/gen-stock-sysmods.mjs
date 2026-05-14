#!/usr/bin/env node
/**
 * 단일 stock sysmod codegen (옵션 C) — infra/data/stock-apis-{kiwoom,kis}.json 입력.
 *
 * Phase Stock-Split S2 v2 (2026-05-14):
 * 옵션 C — 단일 sysmod 디렉토리 (system/modules/kiwoom + korea-invest) +
 * config.json 의 `domains` 필드로 LLM 노출 layer 분리.
 *
 * MCP register_sysmod_tools 의 domains 분기 (옵션 C, commit f18f30f) 가
 * 각 domain 마다 sysmod_<name>_<domain> 도구 별도 등록 (action enum 좁힘).
 *
 * 출력:
 *   system/modules/kiwoom/{config.json, index.mjs}        — 208 APIs, 8 domains
 *   system/modules/korea-invest/{config.json, index.mjs}  — 278 APIs, 9 domains
 *
 * 호출 방식: LLM 이 sysmod_kiwoom_account / sysmod_kiwoom_chart 등 호출 →
 * MCP 가 모두 단일 sysmod_kiwoom 모듈로 라우팅 → action = API ID 분기.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MODULES_DIR = resolve(ROOT, 'system/modules');

// ─────────────────────────────────────────────────────────────────
// 도메인 매핑 — 키움 (대분류/중분류 → 도메인)
// ─────────────────────────────────────────────────────────────────
const KIWOOM_DOMAIN_MAP = {
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

const KIS_DOMAIN_MAP = {
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

const KIWOOM_DOMAIN_DESC = {
  'account': '키움증권 계좌 (잔고·예수금·자산·수익률·체결·미체결·매매일지)',
  'order': '키움증권 주문 (현금/신용/금현물 매수·매도·정정·취소)',
  'quote': '키움증권 시세 + 종목정보 + 업종 (현재가·호가·체결·일별주가·종목기본정보)',
  'chart': '키움증권 차트 (틱/분봉/일봉/주봉/월봉/년봉 — 주식·업종·금현물)',
  'ranking': '키움증권 실시간 순위정보 (등락률·거래량·호가잔량·외인·신용비율 등)',
  'investor': '키움증권 투자자 동향 (기관/외국인·대차거래·공매도)',
  'etf-elw': '키움증권 ETF + ELW (수익률·민감도·괴리율·조건검색)',
  'condition-theme': '키움증권 조건검색 + 테마 (사용자 정의 조건·테마 그룹별 종목)',
};

const KIS_DOMAIN_DESC = {
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

const KIWOOM_DOMAIN_CAPABILITY = {
  'account': 'stock-trading',
  'order': 'stock-trading',
  'quote': 'stock-quote',
  'chart': 'stock-quote',
  'ranking': 'stock-quote',
  'investor': 'stock-quote',
  'etf-elw': 'stock-quote',
  'condition-theme': 'stock-quote',
};

const KIS_DOMAIN_CAPABILITY = {
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

// ─────────────────────────────────────────────────────────────────
// 키움 단일 sysmod 생성
// ─────────────────────────────────────────────────────────────────
function buildKiwoomBundle(apis) {
  // URL 카테고리 추출 (apiId → "/api/dostk/{cat}")
  const urlCategory = {};
  const apiNames = {};
  for (const api of apis) {
    if (api.path) {
      const m = api.path.match(/\/api\/dostk\/([^/]+)/);
      if (m) urlCategory[api.id] = m[1];
    }
    apiNames[api.id] = api.name;
  }

  // 도메인별 group
  const byDomain = {};
  for (const api of apis) {
    if (api.category === 'OAuth 인증') continue;
    const domain = KIWOOM_DOMAIN_MAP[api.subCategory];
    if (!domain || domain === 'realtime') continue; // realtime 별도 phase
    (byDomain[domain] ||= []).push(api);
  }

  // config.domains[] 생성
  const domains = Object.entries(byDomain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, apis]) => ({
      name,
      description: KIWOOM_DOMAIN_DESC[name] || `키움 ${name}`,
      capability: KIWOOM_DOMAIN_CAPABILITY[name] || 'stock-quote',
      actions: apis.map((a) => a.id).sort(),
      actionsCount: apis.length,
      actionsDetail: apis.map((a) => `  ${a.id} — ${a.name}`).join('\n'),
    }));

  // 전체 action enum (단일 sysmod 가 처리 가능한 모든 API ID)
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
 * Firebat System Module: kiwoom (옵션 C 통합, 2026-05-14)
 * 키움증권 OPEN API 통합 — 208 REST API. codegen 생성 (infra/data/stock-apis-kiwoom.json).
 *
 * LLM 시점: config.json 의 domains[] 가 MCP register_sysmod_tools 에 의해 8개 별도 도구로 분리 등록
 * (sysmod_kiwoom_account / sysmod_kiwoom_chart / sysmod_kiwoom_quote / ...). 모든 도구가 이 단일
 * 모듈로 라우팅. action 으로 API ID (ka10001 등) 직접 호출.
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

// Rate limit: 초당 5회 (키움 공식 한도)
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

// ─────────────────────────────────────────────────────────────────
// 한투 단일 sysmod 생성
// ─────────────────────────────────────────────────────────────────
function buildKisBundle(apis) {
  // API metadata table (apiId → { method, path, trIdReal, trIdMock, name })
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

  // 도메인별 group
  const byDomain = {};
  for (const api of apis) {
    if (api.menu === 'OAuth인증') continue;
    const domain = KIS_DOMAIN_MAP[api.menu];
    if (!domain || domain === 'stock-realtime') continue;
    (byDomain[domain] ||= []).push(api);
  }

  const domains = Object.entries(byDomain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, apis]) => ({
      name,
      description: KIS_DOMAIN_DESC[name] || `한투 ${name}`,
      capability: KIS_DOMAIN_CAPABILITY[name] || 'stock-quote',
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
 * Firebat System Module: korea-invest (옵션 C 통합, 2026-05-14)
 * 한국투자증권 OPEN API 통합 — 278 REST API. codegen 생성.
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

// Rate limit: 초당 20회 (한투 공식 한도)
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

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
function generate() {
  const kiwoomApis = JSON.parse(readFileSync(resolve(ROOT, 'infra/data/stock-apis-kiwoom.json'), 'utf8'));
  const kisApis = JSON.parse(readFileSync(resolve(ROOT, 'infra/data/stock-apis-kis.json'), 'utf8'));

  const kiwoomBundle = buildKiwoomBundle(kiwoomApis);
  const kisBundle = buildKisBundle(kisApis);

  const kiwoomDir = resolve(MODULES_DIR, 'kiwoom');
  mkdirSync(kiwoomDir, { recursive: true });
  writeFileSync(resolve(kiwoomDir, 'config.json'), JSON.stringify(kiwoomBundle.config, null, 2), 'utf8');
  writeFileSync(resolve(kiwoomDir, 'index.mjs'), kiwoomBundle.index, 'utf8');
  console.log(`✓ system/modules/kiwoom — 208 APIs, ${kiwoomBundle.config.domains.length} domains`);

  const kisDir = resolve(MODULES_DIR, 'korea-invest');
  mkdirSync(kisDir, { recursive: true });
  writeFileSync(resolve(kisDir, 'config.json'), JSON.stringify(kisBundle.config, null, 2), 'utf8');
  writeFileSync(resolve(kisDir, 'index.mjs'), kisBundle.index, 'utf8');
  console.log(`✓ system/modules/korea-invest — 278 APIs, ${kisBundle.config.domains.length} domains`);
}

generate();

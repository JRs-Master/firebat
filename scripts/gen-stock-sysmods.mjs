#!/usr/bin/env node
/**
 * 도메인별 stock sysmod codegen — infra/data/stock-apis-{kiwoom,kis}.json 입력.
 *
 * Phase Stock-Split S2 (2026-05-14):
 * 옛 단일 sysmod_kiwoom (151 actions) + sysmod_korea_invest (277 actions) →
 * 17 도메인 sysmod 자동 분리. 각 sysmod 는 OAuth + callApi + throttle 자체 inline.
 *
 * 새 sysmod 디렉토리:
 *   system/modules/
 *     kiwoom-account/        — 계좌 33
 *     kiwoom-order/          — 주문 + 신용주문 + 금현물주문 12
 *     kiwoom-quote/          — 시세 + 종목정보 + 업종 62
 *     kiwoom-chart/          — 차트 21
 *     kiwoom-ranking/        — 순위정보 23
 *     kiwoom-investor/       — 기관/외국인 + 대차거래 + 공매도 9
 *     kiwoom-etf-elw/        — ETF + ELW 20
 *     kiwoom-condition-theme/— 조건검색 + 테마 6
 *     kis-stock-account/     — [국내주식] 주문/계좌 23
 *     kis-stock-quote/       — [국내주식] 기본시세 + 종목정보 + 업종/기타 61
 *     kis-stock-ranking/     — [국내주식] 순위분석 22
 *     kis-stock-analysis/    — [국내주식] 시세분석 28
 *     kis-stock-elw/         — [국내주식] ELW 시세 22
 *     kis-futures/           — [국내선물옵션] 기본시세 + 주문/계좌 24
 *     kis-bond/              — [장내채권] 기본시세 + 주문/계좌 15
 *     kis-overseas-stock/    — [해외주식] 기본시세 + 시세분석 + 주문/계좌 47
 *     kis-overseas-futures/  — [해외선물옵션] 기본시세 + 주문/계좌 31
 *
 * 호출 방식: action = API ID (예: "ka10001", "FHKST01010100") 직접.
 * 편의 alias (예: "price", "balance") 는 S2 후속 phase 에서 도메인별로 박음.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MODULES_DIR = resolve(ROOT, 'system/modules');

// ─────────────────────────────────────────────────────────────────
// 도메인 매핑 — 키움 (대분류/중분류 → 도메인 sysmod)
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
  '실시간시세': 'realtime', // WebSocket — 별도 phase
};

// ─────────────────────────────────────────────────────────────────
// 도메인 매핑 — 한투 (메뉴 → 도메인 sysmod)
// ─────────────────────────────────────────────────────────────────
const KIS_DOMAIN_MAP = {
  '[국내주식] 주문/계좌': 'stock-account',
  '[국내주식] 기본시세': 'stock-quote',
  '[국내주식] 종목정보': 'stock-quote',
  '[국내주식] 업종/기타': 'stock-quote',
  '[국내주식] 순위분석': 'stock-ranking',
  '[국내주식] 시세분석': 'stock-analysis',
  '[국내주식] ELW 시세': 'stock-elw',
  '[국내주식] 실시간시세': 'stock-realtime', // 별도 phase
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

// ─────────────────────────────────────────────────────────────────
// 도메인별 한글 설명 (config.json description 용)
// ─────────────────────────────────────────────────────────────────
const KIWOOM_DOMAIN_DESC = {
  'account': '키움증권 계좌 (잔고·예수금·자산·수익률·체결·미체결·매매일지)',
  'order': '키움증권 주문 (현금/신용/금현물 매수·매도·정정·취소)',
  'quote': '키움증권 시세 + 종목정보 + 업종 (현재가·호가·체결·일별주가·종목기본정보)',
  'chart': '키움증권 차트 (틱/분봉/일봉/주봉/월봉/년봉 — 주식·업종·금현물)',
  'ranking': '키움증권 실시간 순위정보 (등락률·거래량·호가잔량·외인·신용비율 등 23종)',
  'investor': '키움증권 투자자 동향 (기관/외국인·대차거래·공매도)',
  'etf-elw': '키움증권 ETF + ELW (수익률·민감도·괴리율·조건검색)',
  'condition-theme': '키움증권 조건검색 + 테마 (사용자 정의 조건·테마 그룹별 종목)',
};

const KIS_DOMAIN_DESC = {
  'stock-account': '한국투자증권 국내주식 주문/계좌 (잔고·매수가능·정정취소·예약주문·수익현황 23개)',
  'stock-quote': '한국투자증권 국내주식 기본시세 + 종목정보 + 업종/기타 (현재가·호가·체결·일자별·종목정보 61개)',
  'stock-ranking': '한국투자증권 국내주식 순위분석 (거래량·등락률·시가총액·수익자산지표 등 22개)',
  'stock-analysis': '한국투자증권 국내주식 시세분석 (투자자·프로그램매매·신용잔고·체결강도·매물대 등 28개)',
  'stock-elw': '한국투자증권 국내주식 ELW 시세 (현재가·민감도·변동성·기초자산·조건검색 22개)',
  'futures': '한국투자증권 국내선물옵션 (시세 + 주문/계좌 24개) — 야간 포함',
  'bond': '한국투자증권 장내채권 (시세 + 주문/계좌 15개)',
  'overseas-stock': '한국투자증권 해외주식 (시세 + 시세분석 + 주문/계좌 47개) — 미국·아시아 포함',
  'overseas-futures': '한국투자증권 해외선물옵션 (시세 + 주문/계좌 31개)',
};

// ─────────────────────────────────────────────────────────────────
// 키움 — API ID → URL 카테고리 매핑 (옛 sysmod 의 API_CATEGORY 1:1)
// 키움은 모든 API 가 POST /api/dostk/{category} 에 apiId 헤더로 분기.
// ─────────────────────────────────────────────────────────────────
const KIWOOM_URL_CATEGORY = {};
// stock-apis-kiwoom.json 의 path 필드에서 자동 추출 (예: /api/dostk/stkinfo → "stkinfo")
function loadKiwoomUrlCategory(apis) {
  for (const api of apis) {
    if (!api.path) continue;
    const m = api.path.match(/\/api\/dostk\/([^/]+)/);
    if (m) KIWOOM_URL_CATEGORY[api.id] = m[1];
  }
}

// ─────────────────────────────────────────────────────────────────
// codegen 헬퍼
// ─────────────────────────────────────────────────────────────────
function escapeJsString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function buildKiwoomConfig(domain, apis) {
  const actions = apis.map((a) => a.id);
  const lines = apis.map((a) => `  ${a.id} — ${a.name}`);
  return {
    name: `kiwoom-${domain}`,
    type: 'module',
    scope: 'system',
    version: '1.0.0',
    description: KIWOOM_DOMAIN_DESC[domain] || `키움증권 ${domain}`,
    runtime: 'node',
    capability: domain.includes('quote') || domain.includes('chart') || domain.includes('ranking') ? 'stock-quote' : 'stock-trading',
    providerType: 'api',
    secrets: ['KIWOOM_APP_KEY', 'KIWOOM_APP_SECRET'],
    tokenCache: { secretName: 'KIWOOM_ACCESS_TOKEN', ttlHours: 23 },
    input: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: `키움 API ID 직접 호출. 본 sysmod 가 지원하는 API:\n${lines.join('\n')}`,
        },
        params: {
          type: 'object',
          description: '키움 API request body 의 모든 필드를 그대로 전달. 각 API 의 필드는 키움 REST API 문서 또는 위 action 설명 참조.',
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
      properties: {
        apiId: { type: 'string' },
        action: { type: 'string' },
      },
    },
  };
}

function buildKiwoomIndex(domain, apis) {
  const urlCategoryMap = {};
  for (const a of apis) {
    if (KIWOOM_URL_CATEGORY[a.id]) urlCategoryMap[a.id] = KIWOOM_URL_CATEGORY[a.id];
  }
  // metadata for runtime helpful error messages
  const apiNames = {};
  for (const a of apis) apiNames[a.id] = a.name;

  return `#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom-${domain}
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kiwoom.json 입력.
 *
 * ${KIWOOM_DOMAIN_DESC[domain] || domain}
 * ${apis.length}개 API. action = API ID 직접 호출 + params 가 request body.
 *
 * 옛 sysmod_kiwoom (151 actions) 의 도메인별 분리 — OAuth + callApi + throttle 자체 inline.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 카테고리 (POST /api/dostk/{category} + apiId 헤더)
const URL_CATEGORY = ${JSON.stringify(urlCategoryMap, null, 2)};
// API ID → 한글명 (에러 메시지 용)
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
  if (!category) throw new Error(\`이 sysmod 는 \${apiId} 를 지원하지 않습니다. 본 sysmod 가 지원하는 API: \${Object.keys(URL_CATEGORY).join(', ')}\`);
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
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 본 sysmod 의 API ID 중 하나를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom-${domain} 에서 등록해주세요.' }));
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
}

function buildKisConfig(domain, apis) {
  const actions = apis.map((a) => a.id);
  const lines = apis.map((a) => `  ${a.id} (TR_ID: ${a.trIdReal || 'N/A'}) — ${a.name}`);
  return {
    name: `kis-${domain}`,
    type: 'module',
    scope: 'system',
    version: '1.0.0',
    description: KIS_DOMAIN_DESC[domain] || `한국투자증권 ${domain}`,
    runtime: 'node',
    capability: domain.includes('quote') || domain.includes('ranking') || domain.includes('analysis') ? 'stock-quote' : 'stock-trading',
    providerType: 'api',
    secrets: ['KIS_APP_KEY', 'KIS_APP_SECRET'],
    tokenCache: { secretName: 'KIS_ACCESS_TOKEN', ttlHours: 23 },
    input: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: actions,
          description: `한투 API ID 직접 호출 (예: v1_국내주식-008). 본 sysmod 가 지원하는 API:\n${lines.join('\n')}`,
        },
        query: {
          type: 'object',
          description: '한투 API request query parameter (GET API 의 필수). 각 API 의 필드는 한투 OPEN API 문서 또는 위 action 설명 참조.',
        },
        body: {
          type: 'object',
          description: '한투 API request body (POST API 의 필수). 각 API 의 필드는 한투 OPEN API 문서 또는 위 action 설명 참조.',
        },
        mock: {
          type: 'boolean',
          description: 'true 면 모의투자 도메인 (openapivts.koreainvestment.com:29443) 호출. 기본 false (실전).',
        },
      },
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: {
        apiId: { type: 'string' },
        trId: { type: 'string' },
      },
    },
  };
}

function buildKisIndex(domain, apis) {
  // metadata table: apiId → { method, path, trIdReal, trIdMock, name }
  const apiTable = {};
  for (const a of apis) {
    apiTable[a.id] = {
      method: a.method,
      path: a.path,
      trIdReal: a.trIdReal || '',
      trIdMock: a.trIdMock || '',
      name: a.name,
    };
  }
  return `#!/usr/bin/env node
/**
 * Firebat System Module: kis-${domain}
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * ${KIS_DOMAIN_DESC[domain] || domain}
 * ${apis.length}개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
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

// Rate limit: 초당 20회 (한투 공식 한도 — 실전 기준)
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
  if (!meta) throw new Error(\`이 sysmod 는 \${action} 을 지원하지 않습니다. 본 sysmod 가 지원하는 API: \${Object.keys(API_TABLE).join(', ')}\`);
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
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 본 sysmod 의 API ID 중 하나를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIS_APP_KEY'];
    const appSecret = process.env['KIS_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-${domain} 에서 등록해주세요.' }));
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
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
function generate() {
  const kiwoomApis = JSON.parse(readFileSync(resolve(ROOT, 'infra/data/stock-apis-kiwoom.json'), 'utf8'));
  const kisApis = JSON.parse(readFileSync(resolve(ROOT, 'infra/data/stock-apis-kis.json'), 'utf8'));

  loadKiwoomUrlCategory(kiwoomApis);

  // 키움 도메인별 group
  const kiwoomByDomain = {};
  for (const api of kiwoomApis) {
    if (api.category === 'OAuth 인증') continue; // 공유 auth — sysmod 분리 X
    const domain = KIWOOM_DOMAIN_MAP[api.subCategory];
    if (!domain) {
      console.warn(`⚠ 키움 매핑 미정의: ${api.category}/${api.subCategory} — ${api.id}`);
      continue;
    }
    if (domain === 'realtime') continue; // WebSocket — 별도 phase
    (kiwoomByDomain[domain] ||= []).push(api);
  }

  // 한투 도메인별 group
  const kisByDomain = {};
  for (const api of kisApis) {
    if (api.menu === 'OAuth인증') continue;
    const domain = KIS_DOMAIN_MAP[api.menu];
    if (!domain) {
      console.warn(`⚠ 한투 매핑 미정의: ${api.menu} — ${api.id}`);
      continue;
    }
    if (domain === 'stock-realtime') continue; // 별도 phase
    (kisByDomain[domain] ||= []).push(api);
  }

  // 키움 sysmod 생성
  let created = 0;
  for (const [domain, apis] of Object.entries(kiwoomByDomain)) {
    const dir = resolve(MODULES_DIR, `kiwoom-${domain}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(buildKiwoomConfig(domain, apis), null, 2), 'utf8');
    writeFileSync(resolve(dir, 'index.mjs'), buildKiwoomIndex(domain, apis), 'utf8');
    console.log(`✓ kiwoom-${domain} (${apis.length} APIs)`);
    created++;
  }
  for (const [domain, apis] of Object.entries(kisByDomain)) {
    const dir = resolve(MODULES_DIR, `kis-${domain}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(buildKisConfig(domain, apis), null, 2), 'utf8');
    writeFileSync(resolve(dir, 'index.mjs'), buildKisIndex(domain, apis), 'utf8');
    console.log(`✓ kis-${domain} (${apis.length} APIs)`);
    created++;
  }
  console.log(`\n총 ${created} 도메인 sysmod 생성 완료.`);
}

generate();

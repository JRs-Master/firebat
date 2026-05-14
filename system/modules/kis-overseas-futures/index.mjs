#!/usr/bin/env node
/**
 * Firebat System Module: kis-overseas-futures
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 해외선물옵션 (시세 + 주문/계좌 31개)
 * 31개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "v1_해외선물-001": {
    "method": "POST",
    "path": "/uapi/overseas-futureoption/v1/trading/order",
    "trIdReal": "OTFM3001U ",
    "trIdMock": "",
    "name": "해외선물옵션 주문"
  },
  "v1_해외선물-002, 003": {
    "method": "POST",
    "path": "/uapi/overseas-futureoption/v1/trading/order-rvsecncl",
    "trIdReal": "(정정) OTFM3002U (취소) OTFM3003U",
    "trIdMock": "",
    "name": "해외선물옵션 정정취소주문"
  },
  "v1_해외선물-004": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-ccld",
    "trIdReal": "OTFM3116R",
    "trIdMock": "",
    "name": "해외선물옵션 당일주문내역조회"
  },
  "v1_해외선물-005": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-unpd",
    "trIdReal": "OTFM1412R",
    "trIdMock": "",
    "name": "해외선물옵션 미결제내역조회(잔고)"
  },
  "v1_해외선물-006": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-psamount",
    "trIdReal": "OTFM3304R",
    "trIdMock": "",
    "name": "해외선물옵션 주문가능조회"
  },
  "해외선물-010": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-period-ccld",
    "trIdReal": "OTFM3118R",
    "trIdMock": "",
    "name": "해외선물옵션 기간계좌손익 일별"
  },
  "해외선물-011": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-daily-ccld",
    "trIdReal": "OTFM3122R",
    "trIdMock": "",
    "name": "해외선물옵션 일별 체결내역"
  },
  "해외선물-012": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-deposit",
    "trIdReal": "OTFM1411R",
    "trIdMock": "",
    "name": "해외선물옵션 예수금현황"
  },
  "해외선물-013": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-daily-order",
    "trIdReal": "OTFM3120R",
    "trIdMock": "",
    "name": "해외선물옵션 일별 주문내역"
  },
  "해외선물-014": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/inquire-period-trans",
    "trIdReal": "OTFM3114R",
    "trIdMock": "",
    "name": "해외선물옵션 기간계좌거래내역"
  },
  "해외선물-032": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/trading/margin-detail",
    "trIdReal": "OTFM3115R",
    "trIdMock": "",
    "name": "해외선물옵션 증거금상세"
  },
  "v1_해외선물-009": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/inquire-price",
    "trIdReal": "HHDFC55010000",
    "trIdMock": "",
    "name": "해외선물종목현재가"
  },
  "v1_해외선물-008": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/stock-detail",
    "trIdReal": "HHDFC55010100",
    "trIdMock": "",
    "name": "해외선물종목상세"
  },
  "해외선물-031": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/inquire-asking-price",
    "trIdReal": "HHDFC86000000",
    "trIdMock": "",
    "name": "해외선물 호가"
  },
  "해외선물-016": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/inquire-time-futurechartprice",
    "trIdReal": "HHDFC55020400",
    "trIdMock": "",
    "name": "해외선물 분봉조회"
  },
  "해외선물-019": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/tick-ccnl",
    "trIdReal": "HHDFC55020200",
    "trIdMock": "",
    "name": "해외선물 체결추이(틱)"
  },
  "해외선물-017": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/weekly-ccnl",
    "trIdReal": "HHDFC55020000",
    "trIdMock": "",
    "name": "해외선물 체결추이(주간)"
  },
  "해외선물-018": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/daily-ccnl",
    "trIdReal": "HHDFC55020100",
    "trIdMock": "",
    "name": "해외선물 체결추이(일간)"
  },
  "해외선물-020": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/monthly-ccnl",
    "trIdReal": "HHDFC55020300",
    "trIdMock": "",
    "name": "해외선물 체결추이(월간)"
  },
  "해외선물-023": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/search-contract-detail",
    "trIdReal": "HHDFC55200000",
    "trIdMock": "",
    "name": "해외선물 상품기본정보"
  },
  "해외선물-029": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/investor-unpd-trend",
    "trIdReal": "HHDDB95030000",
    "trIdMock": "",
    "name": "해외선물 미결제추이"
  },
  "해외선물-035": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-price",
    "trIdReal": "HHDFO55010000",
    "trIdMock": "",
    "name": "해외옵션종목현재가"
  },
  "해외선물-034": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-detail",
    "trIdReal": "HHDFO55010100",
    "trIdMock": "",
    "name": "해외옵션종목상세"
  },
  "해외선물-033": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-asking-price",
    "trIdReal": "HHDFO86000000",
    "trIdMock": "",
    "name": "해외옵션 호가"
  },
  "해외선물-040": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/inquire-time-optchartprice",
    "trIdReal": "HHDFO55020400",
    "trIdMock": "",
    "name": "해외옵션 분봉조회"
  },
  "해외선물-038": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-tick-ccnl",
    "trIdReal": "HHDFO55020200",
    "trIdMock": "",
    "name": "해외옵션 체결추이(틱)"
  },
  "해외선물-037": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-daily-ccnl",
    "trIdReal": "HHDFO55020100",
    "trIdMock": "",
    "name": "해외옵션 체결추이(일간)"
  },
  "해외선물-036": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-weekly-ccnl",
    "trIdReal": "HHDFO55020000",
    "trIdMock": "",
    "name": "해외옵션 체결추이(주간)"
  },
  "해외선물-039": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/opt-monthly-ccnl",
    "trIdReal": "HHDFO55020300",
    "trIdMock": "",
    "name": "해외옵션 체결추이(월간)"
  },
  "해외선물-041": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/search-opt-detail",
    "trIdReal": "HHDFO55200000",
    "trIdMock": "",
    "name": "해외옵션 상품기본정보"
  },
  "해외선물-030": {
    "method": "GET",
    "path": "/uapi/overseas-futureoption/v1/quotations/market-time",
    "trIdReal": "OTFM2229R",
    "trIdMock": "",
    "name": "해외선물옵션 장운영시간"
  }
};

async function getAccessToken(base, appKey, appSecret, forceNew = false) {
  if (!forceNew) {
    const cached = process.env['KIS_ACCESS_TOKEN'];
    if (cached) return { token: cached, isNew: false };
  }
  const resp = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`KIS 토큰 발급 실패: ${resp.status}`);
  const json = await resp.json();
  if (!json.access_token) throw new Error(`KIS 토큰 응답 오류: ${JSON.stringify(json)}`);
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
  if (!meta) throw new Error(`이 sysmod 는 ${action} 을 지원하지 않습니다. 본 sysmod 가 지원하는 API: ${Object.keys(API_TABLE).join(', ')}`);
  const trId = isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal;
  if (isMock && !meta.trIdMock) throw new Error(`${action} (${meta.name}) 은 모의투자 미지원입니다.`);
  let url = `${base}${meta.path}`;
  if (meta.method === 'GET' && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'authorization': `Bearer ${token}`,
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
    throw new Error(`KIS API ${resp.status}: ${resp.statusText} ${errText}`.trim());
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-overseas-futures 에서 등록해주세요.' }));
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

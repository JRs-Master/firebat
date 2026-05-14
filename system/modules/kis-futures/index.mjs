#!/usr/bin/env node
/**
 * Firebat System Module: kis-futures
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 국내선물옵션 (시세 + 주문/계좌 24개) — 야간 포함
 * 24개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "국내선물-024": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/ngt-margin-detail",
    "trIdReal": "(구) JTCE6003R (신) CTFN7107R",
    "trIdMock": "",
    "name": "(야간)선물옵션 증거금 상세"
  },
  "v1_국내선물-014": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-deposit",
    "trIdReal": "CTRP6550R",
    "trIdMock": "",
    "name": "선물옵션 총자산현황"
  },
  "v1_국내선물-017": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-daily-amount-fee",
    "trIdReal": "CTFO6119R",
    "trIdMock": "",
    "name": "선물옵션기간약정수수료일별"
  },
  "국내선물-010": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-ngt-balance",
    "trIdReal": "(구) JTCE6001R (신) CTFN6118R",
    "trIdMock": "",
    "name": "(야간)선물옵션 잔고현황"
  },
  "v1_국내선물-004": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-balance",
    "trIdReal": "CTFO6118R",
    "trIdMock": "VTFO6118R",
    "name": "선물옵션 잔고현황"
  },
  "v1_국내선물-001": {
    "method": "POST",
    "path": "/uapi/domestic-futureoption/v1/trading/order",
    "trIdReal": "(주간 매수/매도) TTTO1101U (야간 매수/매도) (구) JTCE1001U (신) STTN1101U",
    "trIdMock": "(주간 매수/매도) VTTO1101U (야간은 모의투자 미제공)",
    "name": "선물옵션 주문"
  },
  "v1_국내선물-015": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-balance-valuation-pl",
    "trIdReal": "CTFO6159R",
    "trIdMock": "",
    "name": "선물옵션 잔고평가손익내역"
  },
  "선물옵션 증거금률": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/margin-rate",
    "trIdReal": "TTTO6032R",
    "trIdMock": "미지원",
    "name": "선물옵션 증거금률"
  },
  "v1_국내선물-002": {
    "method": "POST",
    "path": "/uapi/domestic-futureoption/v1/trading/order-rvsecncl",
    "trIdReal": "(주간 정정/취소) TTTO1103U (야간 정정/취소) (구) JTCE1002U (신) STTN1103U",
    "trIdMock": "(주간 정정/취소) VTTO1103U (야간은 모의투자 미제공)",
    "name": "선물옵션 정정취소주문"
  },
  "v1_국내선물-003": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-ccnl",
    "trIdReal": "TTTO5201R",
    "trIdMock": "VTTO5201R",
    "name": "선물옵션 주문체결내역조회"
  },
  "국내선물-009": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-ngt-ccnl",
    "trIdReal": "(구) JTCE5005R (신) STTN5201R",
    "trIdMock": "",
    "name": "(야간)선물옵션 주문체결 내역조회"
  },
  "국내선물-011": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-psbl-ngt-order",
    "trIdReal": "(구) JTCE1004R (신) STTN5105R",
    "trIdMock": "",
    "name": "(야간)선물옵션 주문가능 조회"
  },
  "v1_국내선물-013": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-balance-settlement-pl",
    "trIdReal": "CTFO6117R",
    "trIdMock": "",
    "name": "선물옵션 잔고정산손익내역"
  },
  "v1_국내선물-005": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-psbl-order",
    "trIdReal": "TTTO5105R",
    "trIdMock": "VTTO5105R",
    "name": "선물옵션 주문가능"
  },
  "v1_국내선물-016": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/trading/inquire-ccnl-bstime",
    "trIdReal": "CTFO5139R",
    "trIdMock": "",
    "name": "선물옵션 기준일체결내역"
  },
  "v1_국내선물-006": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/inquire-price",
    "trIdReal": "FHMIF10000000",
    "trIdMock": "FHMIF10000000",
    "name": "선물옵션 시세"
  },
  "국내선물-021": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/display-board-top",
    "trIdReal": "FHPIF05030000",
    "trIdMock": "",
    "name": "국내선물 기초자산 시세"
  },
  "국내선물-018": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/exp-price-trend",
    "trIdReal": "FHPIF05110100",
    "trIdMock": "",
    "name": "선물옵션 일중예상체결추이"
  },
  "v1_국내선물-008": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice",
    "trIdReal": "FHKIF03020100",
    "trIdMock": "FHKIF03020100",
    "name": "선물옵션기간별시세(일/주/월/년)"
  },
  "국내선물-023": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/display-board-futures",
    "trIdReal": "FHPIF05030200",
    "trIdMock": "",
    "name": "국내옵션전광판_선물"
  },
  "v1_국내선물-012": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice",
    "trIdReal": "FHKIF03020200",
    "trIdMock": "",
    "name": "선물옵션 분봉조회"
  },
  "국내선물-020": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/display-board-option-list",
    "trIdReal": "FHPIO056104C0",
    "trIdMock": "",
    "name": "국내옵션전광판_옵션월물리스트"
  },
  "v1_국내선물-007": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/inquire-asking-price",
    "trIdReal": "FHMIF10010000",
    "trIdMock": "FHMIF10010000",
    "name": "선물옵션 시세호가"
  },
  "국내선물-022": {
    "method": "GET",
    "path": "/uapi/domestic-futureoption/v1/quotations/display-board-callput",
    "trIdReal": "FHPIF05030100",
    "trIdMock": "",
    "name": "국내옵션전광판_콜풋"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-futures 에서 등록해주세요.' }));
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

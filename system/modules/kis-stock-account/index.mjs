#!/usr/bin/env node
/**
 * Firebat System Module: kis-stock-account
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 국내주식 주문/계좌 (잔고·매수가능·정정취소·예약주문·수익현황 23개)
 * 23개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "국내주식-211": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/period-rights",
    "trIdReal": "CTRGA011R",
    "trIdMock": "",
    "name": "기간별계좌권리현황조회"
  },
  "v1_국내주식-048": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-account-balance",
    "trIdReal": "CTRP6548R",
    "trIdMock": "",
    "name": "투자계좌자산현황조회"
  },
  "v1_국내주식-035": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/pension/inquire-deposit",
    "trIdReal": "TTTC0506R",
    "trIdMock": "",
    "name": "퇴직연금 예수금조회"
  },
  "v1_국내주식-018,019": {
    "method": "POST",
    "path": "/uapi/domestic-stock/v1/trading/order-resv-rvsecncl",
    "trIdReal": "(예약취소) CTSC0009U (예약정정) CTSC0013U",
    "trIdMock": "",
    "name": "주식예약주문정정취소"
  },
  "v1_국내주식-042": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-credit-psamount",
    "trIdReal": "TTTC8909R",
    "trIdMock": "",
    "name": "신용매수가능조회"
  },
  "국내주식-191": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/intgr-margin",
    "trIdReal": "TTTC0869R",
    "trIdMock": "",
    "name": "주식통합증거금 현황"
  },
  "v1_국내주식-033": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/pension/inquire-daily-ccld",
    "trIdReal": "TTTC2201R(기존 KRX만 가능), TTTC2210R (KRX,NXT/SOR)",
    "trIdMock": "",
    "name": "퇴직연금 미체결내역"
  },
  "v1_국내주식-060": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-period-trade-profit",
    "trIdReal": "TTTC8715R",
    "trIdMock": "",
    "name": "기간별매매손익현황조회"
  },
  "v1_국내주식-003": {
    "method": "POST",
    "path": "/uapi/domestic-stock/v1/trading/order-rvsecncl",
    "trIdReal": "TTTC0013U",
    "trIdMock": "VTTC0013U",
    "name": "주식주문(정정취소)"
  },
  "v1_국내주식-020": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/order-resv-ccnl",
    "trIdReal": "CTSC0004R",
    "trIdMock": "",
    "name": "주식예약주문조회"
  },
  "v1_국내주식-034": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/pension/inquire-psbl-order",
    "trIdReal": "TTTC0503R",
    "trIdMock": "",
    "name": "퇴직연금 매수가능조회"
  },
  "v1_국내주식-006": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-balance",
    "trIdReal": "TTTC8434R",
    "trIdMock": "VTTC8434R",
    "name": "주식잔고조회"
  },
  "v1_국내주식-032": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/pension/inquire-present-balance",
    "trIdReal": "TTTC2202R",
    "trIdMock": "",
    "name": "퇴직연금 체결기준잔고"
  },
  "v1_국내주식-007": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
    "trIdReal": "TTTC8908R",
    "trIdMock": "VTTC8908R",
    "name": "매수가능조회"
  },
  "v1_국내주식-052": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-period-profit",
    "trIdReal": "TTTC8708R",
    "trIdMock": "",
    "name": "기간별손익일별합산조회"
  },
  "v1_국내주식-001": {
    "method": "POST",
    "path": "/uapi/domestic-stock/v1/trading/order-cash",
    "trIdReal": "(매도) TTTC0011U (매수) TTTC0012U",
    "trIdMock": "(매도) VTTC0011U (매수) VTTC0012U",
    "name": "주식주문(현금)"
  },
  "국내주식-165": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-psbl-sell",
    "trIdReal": "TTTC8408R",
    "trIdMock": "",
    "name": "매도가능수량조회"
  },
  "v1_국내주식-005": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
    "trIdReal": "(3개월이내) TTTC0081R (3개월이전) CTSC9215R",
    "trIdMock": "(3개월이내) VTTC0081R (3개월이전) VTSC9215R",
    "name": "주식일별주문체결조회"
  },
  "v1_국내주식-004": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl",
    "trIdReal": "TTTC0084R",
    "trIdMock": "",
    "name": "주식정정취소가능주문조회"
  },
  "v1_국내주식-017": {
    "method": "POST",
    "path": "/uapi/domestic-stock/v1/trading/order-resv",
    "trIdReal": "CTSC0008U",
    "trIdMock": "",
    "name": "주식예약주문"
  },
  "v1_국내주식-002": {
    "method": "POST",
    "path": "/uapi/domestic-stock/v1/trading/order-credit",
    "trIdReal": "(매도) TTTC0051U (매수) TTTC0052U",
    "trIdMock": "",
    "name": "주식주문(신용)"
  },
  "v1_국내주식-036": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/pension/inquire-balance",
    "trIdReal": "TTTC2208R",
    "trIdMock": "",
    "name": "퇴직연금 잔고조회"
  },
  "v1_국내주식-041": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl",
    "trIdReal": "TTTC8494R",
    "trIdMock": "",
    "name": "주식잔고조회_실현손익"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-stock-account 에서 등록해주세요.' }));
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

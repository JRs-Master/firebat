#!/usr/bin/env node
/**
 * Firebat System Module: kis-bond
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 장내채권 (시세 + 주문/계좌 15개)
 * 15개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "국내주식-124": {
    "method": "POST",
    "path": "/uapi/domestic-bond/v1/trading/buy",
    "trIdReal": "TTTC0952U",
    "trIdMock": "",
    "name": "장내채권 매수주문"
  },
  "국내주식-123": {
    "method": "POST",
    "path": "/uapi/domestic-bond/v1/trading/sell",
    "trIdReal": "TTTC0958U",
    "trIdMock": "",
    "name": "장내채권 매도주문"
  },
  "국내주식-125": {
    "method": "POST",
    "path": "/uapi/domestic-bond/v1/trading/order-rvsecncl",
    "trIdReal": "TTTC0953U",
    "trIdMock": "",
    "name": "장내채권 정정취소주문"
  },
  "국내주식-126": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/trading/inquire-psbl-rvsecncl",
    "trIdReal": "CTSC8035R",
    "trIdMock": "",
    "name": "채권정정취소가능주문조회"
  },
  "국내주식-127": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/trading/inquire-daily-ccld",
    "trIdReal": "CTSC8013R",
    "trIdMock": "",
    "name": "장내채권 주문체결내역"
  },
  "국내주식-198": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/trading/inquire-balance",
    "trIdReal": "CTSC8407R",
    "trIdMock": "",
    "name": "장내채권 잔고조회"
  },
  "국내주식-199": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/trading/inquire-psbl-order",
    "trIdReal": "TTTC8910R",
    "trIdMock": "",
    "name": "장내채권 매수가능조회"
  },
  "국내주식-132": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/inquire-asking-price",
    "trIdReal": "FHKBJ773401C0",
    "trIdMock": "",
    "name": "장내채권현재가(호가)"
  },
  "국내주식-200": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/inquire-price",
    "trIdReal": "FHKBJ773400C0",
    "trIdMock": "",
    "name": "장내채권현재가(시세)"
  },
  "국내주식-201": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/inquire-ccnl",
    "trIdReal": "FHKBJ773403C0",
    "trIdMock": "",
    "name": "장내채권현재가(체결)"
  },
  "국내주식-202": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/inquire-daily-price",
    "trIdReal": "FHKBJ773404C0",
    "trIdMock": "",
    "name": "장내채권현재가(일별)"
  },
  "국내주식-159": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/inquire-daily-itemchartprice",
    "trIdReal": "FHKBJ773701C0",
    "trIdMock": "",
    "name": "장내채권 기간별시세(일)"
  },
  "국내주식-158": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/avg-unit",
    "trIdReal": "CTPF2005R",
    "trIdMock": "",
    "name": "장내채권 평균단가조회"
  },
  "국내주식-156": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/issue-info",
    "trIdReal": "CTPF1101R",
    "trIdMock": "",
    "name": "장내채권 발행정보"
  },
  "국내주식-129": {
    "method": "GET",
    "path": "/uapi/domestic-bond/v1/quotations/search-bond-info",
    "trIdReal": "CTPF1114R",
    "trIdMock": "",
    "name": "장내채권 기본조회"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-bond 에서 등록해주세요.' }));
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

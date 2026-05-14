#!/usr/bin/env node
/**
 * Firebat System Module: kis-stock-elw
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 국내주식 ELW 시세 (현재가·민감도·변동성·기초자산·조건검색 22개)
 * 22개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "v1_국내주식-014": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-elw-price",
    "trIdReal": "FHKEW15010000",
    "trIdMock": "FHKEW15010000",
    "name": "ELW 현재가 시세"
  },
  "국내주식-181": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/newly-listed",
    "trIdReal": "FHKEW154800C0",
    "trIdMock": "",
    "name": "ELW 신규상장종목"
  },
  "국내주식-173": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/indicator-trend-daily",
    "trIdReal": "FHPEW02740200",
    "trIdMock": "",
    "name": "ELW 투자지표추이(일별)"
  },
  "국내주식-170": {
    "method": "GET",
    "path": "/uapi/elw/v1/ranking/sensitivity",
    "trIdReal": "FHPEW02850000",
    "trIdMock": "",
    "name": "ELW 민감도 순위"
  },
  "국내주식-186": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/udrl-asset-price",
    "trIdReal": "FHKEW154101C0",
    "trIdMock": "",
    "name": "ELW 기초자산별 종목시세"
  },
  "국내주식-166": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/cond-search",
    "trIdReal": "FHKEW15100000",
    "trIdMock": "",
    "name": "ELW 종목검색"
  },
  "국내주식-179": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/volatility-trend-minute",
    "trIdReal": "FHPEW02840300",
    "trIdMock": "",
    "name": "ELW 변동성 추이(분별)"
  },
  "국내주식-177": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/volatility-trend-ccnl",
    "trIdReal": "FHPEW02840100",
    "trIdMock": "",
    "name": "ELW 변동성추이(체결)"
  },
  "국내주식-171": {
    "method": "GET",
    "path": "/uapi/elw/v1/ranking/quick-change",
    "trIdReal": "FHPEW02870000",
    "trIdMock": "",
    "name": "ELW 당일급변종목"
  },
  "국내주식-174": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/indicator-trend-minute",
    "trIdReal": "FHPEW02740300",
    "trIdMock": "",
    "name": "ELW 투자지표추이(분별)"
  },
  "국내주식-185": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/udrl-asset-list",
    "trIdReal": "FHKEW154100C0",
    "trIdMock": "",
    "name": "ELW 기초자산 목록조회"
  },
  "국내주식-178": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/volatility-trend-daily",
    "trIdReal": "FHPEW02840200",
    "trIdMock": "",
    "name": "ELW 변동성 추이(일별)"
  },
  "국내주식-168": {
    "method": "GET",
    "path": "/uapi/elw/v1/ranking/volume-rank",
    "trIdReal": "FHPEW02780000",
    "trIdMock": "",
    "name": "ELW 거래량순위"
  },
  "국내주식-169": {
    "method": "GET",
    "path": "/uapi/elw/v1/ranking/indicator",
    "trIdReal": "FHPEW02790000",
    "trIdMock": "",
    "name": "ELW 지표순위"
  },
  "국내주식-172": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/indicator-trend-ccnl",
    "trIdReal": "FHPEW02740100",
    "trIdMock": "",
    "name": "ELW 투자지표추이(체결)"
  },
  "국내주식-167": {
    "method": "GET",
    "path": "/uapi/elw/v1/ranking/updown-rate",
    "trIdReal": "FHPEW02770000",
    "trIdMock": "",
    "name": "ELW 상승률순위"
  },
  "국내주식-176": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/sensitivity-trend-daily",
    "trIdReal": "FHPEW02830200",
    "trIdMock": "",
    "name": "ELW 민감도 추이(일별)"
  },
  "국내주식-183": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/compare-stocks",
    "trIdReal": "FHKEW151701C0",
    "trIdMock": "",
    "name": "ELW 비교대상종목조회"
  },
  "국내주식-184": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/expiration-stocks",
    "trIdReal": "FHKEW154700C0",
    "trIdMock": "",
    "name": "ELW 만기예정/만기종목"
  },
  "국내주식-182": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/lp-trade-trend",
    "trIdReal": "FHPEW03760000",
    "trIdMock": "",
    "name": "ELW LP매매추이"
  },
  "국내주식-175": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/sensitivity-trend-ccnl",
    "trIdReal": "FHPEW02830100",
    "trIdMock": "",
    "name": "ELW 민감도 추이(체결)"
  },
  "국내주식-180": {
    "method": "GET",
    "path": "/uapi/elw/v1/quotations/volatility-trend-tick",
    "trIdReal": "FHPEW02840400",
    "trIdMock": "",
    "name": "ELW 변동성 추이(틱)"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-stock-elw 에서 등록해주세요.' }));
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

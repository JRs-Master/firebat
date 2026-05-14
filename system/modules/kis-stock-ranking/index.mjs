#!/usr/bin/env node
/**
 * Firebat System Module: kis-stock-ranking
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 국내주식 순위분석 (거래량·등락률·시가총액·수익자산지표 등 22개)
 * 22개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "v1_국내주식-103": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/exp-trans-updown",
    "trIdReal": "FHPST01820000",
    "trIdMock": "",
    "name": "국내주식 예상체결 상승/하락상위"
  },
  "국내주식-089": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/quote-balance",
    "trIdReal": "FHPST01720000",
    "trIdMock": "",
    "name": "국내주식 호가잔량 순위"
  },
  "국내주식-109": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/credit-balance",
    "trIdReal": "FHKST17010000",
    "trIdMock": "",
    "name": "국내주식 신용잔고 상위"
  },
  "국내주식-139": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/overtime-volume",
    "trIdReal": "FHPST02350000",
    "trIdMock": "",
    "name": "국내주식 시간외거래량순위"
  },
  "국내주식-106": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/dividend-rate",
    "trIdReal": "HHKDB13470100",
    "trIdMock": "",
    "name": "국내주식 배당률 상위"
  },
  "v1_국내주식-093": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/after-hour-balance",
    "trIdReal": "FHPST01760000",
    "trIdMock": "",
    "name": "국내주식 시간외잔량 순위"
  },
  "국내주식-133": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/short-sale",
    "trIdReal": "FHPST04820000",
    "trIdMock": "",
    "name": "국내주식 공매도 상위종목"
  },
  "v1_국내주식-095": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/disparity",
    "trIdReal": "FHPST01780000",
    "trIdMock": "",
    "name": "국내주식 이격도 순위"
  },
  "국내주식-214": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/hts-top-view",
    "trIdReal": "HHMCM000100C0",
    "trIdMock": "",
    "name": "HTS조회상위20종목"
  },
  "v1_국내주식-047": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/volume-rank",
    "trIdReal": "FHPST01710000",
    "trIdMock": "",
    "name": "거래량순위"
  },
  "v1_국내주식-090": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/profit-asset-index",
    "trIdReal": "FHPST01730000",
    "trIdMock": "",
    "name": "국내주식 수익자산지표 순위"
  },
  "v1_국내주식-105": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/near-new-highlow",
    "trIdReal": "FHPST01870000",
    "trIdMock": "",
    "name": "국내주식 신고/신저근접종목 상위"
  },
  "v1_국내주식-094": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/prefer-disparate-ratio",
    "trIdReal": "FHPST01770000",
    "trIdMock": "",
    "name": "국내주식 우선주/괴리율 상위"
  },
  "국내주식-107": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/bulk-trans-num",
    "trIdReal": "FHKST190900C0",
    "trIdMock": "",
    "name": "국내주식 대량체결건수 상위"
  },
  "v1_국내주식-092": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/finance-ratio",
    "trIdReal": "FHPST01750000",
    "trIdMock": "",
    "name": "국내주식 재무비율 순위"
  },
  "v1_국내주식-091": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/market-cap",
    "trIdReal": "FHPST01740000",
    "trIdMock": "",
    "name": "국내주식 시가총액 상위"
  },
  "v1_국내주식-104": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/traded-by-company",
    "trIdReal": "FHPST01860000",
    "trIdMock": "",
    "name": "국내주식 당사매매종목 상위"
  },
  "v1_국내주식-088": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/fluctuation",
    "trIdReal": "FHPST01700000",
    "trIdMock": "",
    "name": "국내주식 등락률 순위"
  },
  "v1_국내주식-096": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/market-value",
    "trIdReal": "FHPST01790000",
    "trIdMock": "",
    "name": "국내주식 시장가치 순위"
  },
  "v1_국내주식-102": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/top-interest-stock",
    "trIdReal": "FHPST01800000",
    "trIdMock": "",
    "name": "국내주식 관심종목등록 상위"
  },
  "v1_국내주식-101": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/volume-power",
    "trIdReal": "FHPST01680000",
    "trIdMock": "",
    "name": "국내주식 체결강도 상위"
  },
  "국내주식-138": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/overtime-fluctuation",
    "trIdReal": "FHPST02340000",
    "trIdMock": "",
    "name": "국내주식 시간외등락율순위"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-stock-ranking 에서 등록해주세요.' }));
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

#!/usr/bin/env node
/**
 * Firebat System Module: kis-stock-analysis
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 국내주식 시세분석 (투자자·프로그램매매·신용잔고·체결강도·매물대 등 28개)
 * 28개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "국내주식-114": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/comp-program-trade-today",
    "trIdReal": "FHPPG04600101",
    "trIdMock": "",
    "name": "프로그램매매 종합현황(시간)"
  },
  "국내주식-110": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/daily-credit-balance",
    "trIdReal": "FHPST04760000",
    "trIdMock": "",
    "name": "국내주식 신용잔고 일별추이"
  },
  "국내주식-075": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market",
    "trIdReal": "FHPTJ04040000",
    "trIdMock": "",
    "name": "시장별 투자자매매동향(일별)"
  },
  "국내주식-134": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/daily-short-sale",
    "trIdReal": "FHPST04830000",
    "trIdMock": "",
    "name": "국내주식 공매도 일별추이"
  },
  "종목별 투자자매매동향(일별)": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
    "trIdReal": "FHPTJ04160001",
    "trIdMock": "",
    "name": "종목별 투자자매매동향(일별)"
  },
  "국내주식-038": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/psearch-title",
    "trIdReal": "HHKST03900300",
    "trIdMock": "",
    "name": "종목조건검색 목록조회"
  },
  "국내주식-190": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/capture-uplowprice",
    "trIdReal": "FHKST130000C0",
    "trIdMock": "",
    "name": "국내주식 상하한가 포착"
  },
  "국내주식-115": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/comp-program-trade-daily",
    "trIdReal": "FHPPG04600001",
    "trIdMock": "",
    "name": "프로그램매매 종합현황(일별)"
  },
  "국내주식-135": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/daily-loan-trans",
    "trIdReal": "HHPST074500C0",
    "trIdMock": "",
    "name": "종목별 일별 대차거래추이"
  },
  "국내주식-039": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/psearch-result",
    "trIdReal": "HHKST03900400",
    "trIdMock": "",
    "name": "종목조건검색조회"
  },
  "국내주식-196": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/pbar-tratio",
    "trIdReal": "FHPST01130000",
    "trIdMock": "",
    "name": "국내주식 매물대/거래비중"
  },
  "국내주식-037": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/foreign-institution-total",
    "trIdReal": "FHPTJ04400000",
    "trIdMock": "",
    "name": "국내기관_외국인 매매종목가집계"
  },
  "국내주식-203": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/intstock-stocklist-by-group",
    "trIdReal": "HHKCM113004C6",
    "trIdMock": "",
    "name": "관심종목 그룹별 종목조회"
  },
  "국내주식-197": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-member-daily",
    "trIdReal": "FHPST04540000",
    "trIdMock": "",
    "name": "주식현재가 회원사 종목매매동향"
  },
  "국내주식-113": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
    "trIdReal": "FHPPG04650201",
    "trIdMock": "",
    "name": "종목별 프로그램매매추이(일별)"
  },
  "국내주식-204": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/intstock-grouplist",
    "trIdReal": "HHKCM113004C7",
    "trIdMock": "",
    "name": "관심종목 그룹조회"
  },
  "v1_국내주식-046": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/investor-trend-estimate",
    "trIdReal": "HHPTJ04160200",
    "trIdMock": "",
    "name": "종목별 외인기관 추정가집계"
  },
  "v1_국내주식-056": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-daily-trade-volume",
    "trIdReal": "FHKST03010800",
    "trIdMock": "",
    "name": "종목별일별매수매도체결량"
  },
  "국내주식-192": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/tradprt-byamt",
    "trIdReal": "FHKST111900C0",
    "trIdMock": "",
    "name": "국내주식 체결금액별 매매비중"
  },
  "국내주식-116": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/investor-program-trade-today",
    "trIdReal": "HHPPG046600C1",
    "trIdMock": "",
    "name": "프로그램매매 투자자매매동향(당일)"
  },
  "국내주식-193": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/mktfunds",
    "trIdReal": "FHKST649100C0",
    "trIdMock": "",
    "name": "국내 증시자금 종합"
  },
  "국내주식-118": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/exp-price-trend",
    "trIdReal": "FHPST01810000",
    "trIdMock": "",
    "name": "국내주식 예상체결가 추이"
  },
  "v1_국내주식-074": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market",
    "trIdReal": "FHPTJ04030000",
    "trIdMock": "",
    "name": "시장별 투자자매매동향(시세)"
  },
  "v1_국내주식-044": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/program-trade-by-stock",
    "trIdReal": "FHPPG04650101",
    "trIdMock": "",
    "name": "종목별 프로그램매매추이(체결)"
  },
  "국내주식-161": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/frgnmem-trade-estimate",
    "trIdReal": "FHKST644100C0",
    "trIdMock": "",
    "name": "외국계 매매종목 가집계"
  },
  "국내주식-140": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ranking/overtime-exp-trans-fluct",
    "trIdReal": "FHKST11860000",
    "trIdMock": "",
    "name": "국내주식 시간외예상체결등락률"
  },
  "국내주식-164": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/frgnmem-pchs-trend",
    "trIdReal": "FHKST644400C0",
    "trIdMock": "",
    "name": "종목별 외국계 순매수추이"
  },
  "국내주식-205": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/intstock-multprice",
    "trIdReal": "FHKST11300006",
    "trIdMock": "",
    "name": "관심종목(멀티종목) 시세조회"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-stock-analysis 에서 등록해주세요.' }));
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

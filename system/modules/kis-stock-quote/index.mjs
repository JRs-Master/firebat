#!/usr/bin/env node
/**
 * Firebat System Module: kis-stock-quote
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 국내주식 기본시세 + 종목정보 + 업종/기타 (현재가·호가·체결·일자별·종목정보 61개)
 * 61개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "v1_국내주식-010": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-daily-price",
    "trIdReal": "FHKST01010400",
    "trIdMock": "FHKST01010400",
    "name": "주식현재가 일자별"
  },
  "v1_국내주식-008": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-price",
    "trIdReal": "FHKST01010100",
    "trIdMock": "FHKST01010100",
    "name": "주식현재가 시세"
  },
  "국내주식-076": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-overtime-price",
    "trIdReal": "FHPST02300000",
    "trIdMock": "",
    "name": "국내주식 시간외현재가"
  },
  "국내주식-073": {
    "method": "GET",
    "path": "/uapi/etfetn/v1/quotations/inquire-component-stock-price",
    "trIdReal": "FHKST121600C0",
    "trIdMock": "",
    "name": "ETF 구성종목시세"
  },
  "v1_국내주식-025": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-time-overtimeconclusion",
    "trIdReal": "FHPST02310000",
    "trIdMock": "FHPST02310000",
    "name": "주식현재가 시간외시간별체결"
  },
  "v1_국내주식-069": {
    "method": "GET",
    "path": "/uapi/etfetn/v1/quotations/nav-comparison-trend",
    "trIdReal": "FHPST02440000",
    "trIdMock": "",
    "name": "NAV 비교추이(종목)"
  },
  "v1_국내주식-026": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-daily-overtimeprice",
    "trIdReal": "FHPST02320000",
    "trIdMock": "FHPST02320000",
    "name": "주식현재가 시간외일자별주가"
  },
  "국내주식-077": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-overtime-asking-price",
    "trIdReal": "FHPST02300400",
    "trIdMock": "",
    "name": "국내주식 시간외호가"
  },
  "v1_국내주식-023": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion",
    "trIdReal": "FHPST01060000",
    "trIdMock": "FHPST01060000",
    "name": "주식현재가 당일시간대별체결"
  },
  "v1_국내주식-054": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-price-2",
    "trIdReal": "FHPST01010000",
    "trIdMock": "",
    "name": "주식현재가 시세2"
  },
  "국내주식-213": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice",
    "trIdReal": "FHKST03010230",
    "trIdMock": "",
    "name": "주식일별분봉조회"
  },
  "v1_국내주식-016": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    "trIdReal": "FHKST03010100",
    "trIdMock": "FHKST03010100",
    "name": "국내주식기간별시세(일/주/월/년)"
  },
  "v1_국내주식-071": {
    "method": "GET",
    "path": "/uapi/etfetn/v1/quotations/nav-comparison-daily-trend",
    "trIdReal": "FHPST02440200",
    "trIdMock": "",
    "name": "NAV 비교추이(일)"
  },
  "v1_국내주식-011": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
    "trIdReal": "FHKST01010200",
    "trIdMock": "FHKST01010200",
    "name": "주식현재가 호가/예상체결"
  },
  "v1_국내주식-009": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-ccnl",
    "trIdReal": "FHKST01010300",
    "trIdMock": "FHKST01010300",
    "name": "주식현재가 체결"
  },
  "v1_국내주식-013": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-member",
    "trIdReal": "FHKST01010600",
    "trIdMock": "FHKST01010600",
    "name": "주식현재가 회원사"
  },
  "v1_국내주식-070": {
    "method": "GET",
    "path": "/uapi/etfetn/v1/quotations/nav-comparison-time-trend",
    "trIdReal": "FHPST02440100",
    "trIdMock": "",
    "name": "NAV 비교추이(분)"
  },
  "v1_국내주식-012": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-investor",
    "trIdReal": "FHKST01010900",
    "trIdMock": "FHKST01010900",
    "name": "주식현재가 투자자"
  },
  "v1_국내주식-068": {
    "method": "GET",
    "path": "/uapi/etfetn/v1/quotations/inquire-price",
    "trIdReal": "FHPST02400000",
    "trIdMock": "",
    "name": "ETF/ETN 현재가"
  },
  "국내주식-120": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/exp-closing-price",
    "trIdReal": "FHKST117300C0",
    "trIdMock": "",
    "name": "국내주식 장마감 예상체결가"
  },
  "v1_국내주식-022": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
    "trIdReal": "FHKST03010200",
    "trIdMock": "FHKST03010200",
    "name": "주식당일분봉조회"
  },
  "국내주식-121": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/exp-index-trend",
    "trIdReal": "FHPST01840000",
    "trIdMock": "",
    "name": "국내주식 예상체결지수 추이"
  },
  "v1_국내주식-021": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",
    "trIdReal": "FHKUP03500100",
    "trIdMock": "FHKUP03500100",
    "name": "국내주식업종기간별시세(일/주/월/년)"
  },
  "국내주식-119": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-index-timeprice",
    "trIdReal": "FHPUP02110200",
    "trIdMock": "",
    "name": "국내업종 시간별지수(분)"
  },
  "v1_국내주식-066": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-index-category-price",
    "trIdReal": "FHPUP02140000",
    "trIdMock": "",
    "name": "국내업종 구분별전체시세"
  },
  "v1_국내주식-045": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice",
    "trIdReal": "FHKUP03500200",
    "trIdMock": "",
    "name": "업종 분봉조회"
  },
  "국내주식-040": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/chk-holiday",
    "trIdReal": "CTCA0903R",
    "trIdMock": "",
    "name": "국내휴장일조회"
  },
  "국내주식-122": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/exp-total-index",
    "trIdReal": "FHKUP11750000",
    "trIdMock": "",
    "name": "국내주식 예상체결 전체지수"
  },
  "v1_국내주식-063": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-index-price",
    "trIdReal": "FHPUP02100000",
    "trIdMock": "",
    "name": "국내업종 현재지수"
  },
  "국내주식-160": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/market-time",
    "trIdReal": "HHMCM000002C0",
    "trIdMock": "",
    "name": "국내선물 영업일조회"
  },
  "국내주식-064": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-index-tickprice",
    "trIdReal": "FHPUP02110100",
    "trIdMock": "",
    "name": "국내업종 시간별지수(초)"
  },
  "v1_국내주식-065": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-index-daily-price",
    "trIdReal": "FHPUP02120000",
    "trIdMock": "",
    "name": "국내업종 일자별지수"
  },
  "국내주식-155": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/comp-interest",
    "trIdReal": "FHPST07020000",
    "trIdMock": "",
    "name": "금리 종합(국내채권/금리)"
  },
  "v1_국내주식-055": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/inquire-vi-status",
    "trIdReal": "FHPST01390000",
    "trIdMock": "",
    "name": "변동성완화장치(VI) 현황"
  },
  "국내주식-141": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/news-title",
    "trIdReal": "FHKST01011800",
    "trIdMock": "",
    "name": "종합 시황/공시(제목)"
  },
  "v1_국내주식-029": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/search-info",
    "trIdReal": "CTPF1604R",
    "trIdMock": "",
    "name": "상품기본조회"
  },
  "국내주식-150": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/list-info",
    "trIdReal": "HHKDB669107C0",
    "trIdMock": "",
    "name": "예탁원정보(상장정보일정)"
  },
  "국내주식-151": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/pub-offer",
    "trIdReal": "HHKDB669108C0",
    "trIdMock": "",
    "name": "예탁원정보(공모주청약일정)"
  },
  "v1_국내주식-080": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/financial-ratio",
    "trIdReal": "FHKST66430300",
    "trIdMock": "",
    "name": "국내주식 재무비율"
  },
  "국내주식-149": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/cap-dcrs",
    "trIdReal": "HHKDB669106C0",
    "trIdMock": "",
    "name": "예탁원정보(자본감소일정)"
  },
  "국내주식-144": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/bonus-issue",
    "trIdReal": "HHKDB669101C0",
    "trIdMock": "",
    "name": "예탁원정보(무상증자일정)"
  },
  "국내주식-189": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/invest-opbysec",
    "trIdReal": "FHKST663400C0",
    "trIdMock": "",
    "name": "국내주식 증권사별 투자의견"
  },
  "국내주식-111": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/credit-by-company",
    "trIdReal": "FHPST04770000",
    "trIdMock": "",
    "name": "국내주식 당사 신용가능종목"
  },
  "국내주식-146": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/purreq",
    "trIdReal": "HHKDB669103C0",
    "trIdMock": "",
    "name": "예탁원정보(주식매수청구일정)"
  },
  "국내주식-148": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/rev-split",
    "trIdReal": "HHKDB669105C0",
    "trIdMock": "",
    "name": "예탁원정보(액면교체일정)"
  },
  "국내주식-145": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/dividend",
    "trIdReal": "HHKDB669102C0",
    "trIdMock": "",
    "name": "예탁원정보(배당일정)"
  },
  "국내주식-188": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/invest-opinion",
    "trIdReal": "FHKST663300C0",
    "trIdMock": "",
    "name": "국내주식 종목투자의견"
  },
  "v1_국내주식-083": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/stability-ratio",
    "trIdReal": "FHKST66430600",
    "trIdMock": "",
    "name": "국내주식 안정성비율"
  },
  "v1_국내주식-081": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/profit-ratio",
    "trIdReal": "FHKST66430400",
    "trIdMock": "",
    "name": "국내주식 수익성비율"
  },
  "국내주식-152": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/forfeit",
    "trIdReal": "HHKDB669109C0",
    "trIdMock": "",
    "name": "예탁원정보(실권주일정)"
  },
  "국내주식-153": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/mand-deposit",
    "trIdReal": "HHKDB669110C0",
    "trIdMock": "",
    "name": "예탁원정보(의무예치일정)"
  },
  "v1_국내주식-079": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/income-statement",
    "trIdReal": "FHKST66430200",
    "trIdMock": "",
    "name": "국내주식 손익계산서"
  },
  "국내주식-195": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/lendable-by-company",
    "trIdReal": "CTSC2702R",
    "trIdMock": "",
    "name": "당사 대주가능 종목"
  },
  "v1_국내주식-067": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/search-stock-info",
    "trIdReal": "CTPF1002R",
    "trIdMock": "",
    "name": "주식기본조회"
  },
  "국내주식-143": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/paidin-capin",
    "trIdReal": "HHKDB669100C0",
    "trIdMock": "",
    "name": "예탁원정보(유상증자일정)"
  },
  "국내주식-154": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/sharehld-meet",
    "trIdReal": "HHKDB669111C0",
    "trIdMock": "",
    "name": "예탁원정보(주주총회일정)"
  },
  "v1_국내주식-085": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/growth-ratio",
    "trIdReal": "FHKST66430800",
    "trIdMock": "",
    "name": "국내주식 성장성비율"
  },
  "v1_국내주식-078": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/balance-sheet",
    "trIdReal": "FHKST66430100",
    "trIdMock": "",
    "name": "국내주식 대차대조표"
  },
  "국내주식-147": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/ksdinfo/merger-split",
    "trIdReal": "HHKDB669104C0",
    "trIdMock": "",
    "name": "예탁원정보(합병/분할일정)"
  },
  "국내주식-187": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/estimate-perform",
    "trIdReal": "HHKST668300C0",
    "trIdMock": "",
    "name": "국내주식 종목추정실적"
  },
  "v1_국내주식-082": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/finance/other-major-ratios",
    "trIdReal": "FHKST66430500",
    "trIdMock": "",
    "name": "국내주식 기타주요비율"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-stock-quote 에서 등록해주세요.' }));
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

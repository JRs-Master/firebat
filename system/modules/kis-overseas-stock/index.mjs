#!/usr/bin/env node
/**
 * Firebat System Module: kis-overseas-stock
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kis.json 입력.
 *
 * 한국투자증권 해외주식 (시세 + 시세분석 + 주문/계좌 47개) — 미국·아시아 포함
 * 47개 API. action = API ID 직접 호출 + (query|body) 가 request payload.
 *
 * 옛 sysmod_korea_invest (277 actions) 의 도메인별 분리 — OAuth + callApi 자체 inline.
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// API ID → { method, path, trIdReal, trIdMock, name }
const API_TABLE = {
  "v1_해외주식-006": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-balance",
    "trIdReal": "TTTS3012R",
    "trIdMock": "VTTS3012R",
    "name": "해외주식 잔고"
  },
  "v1_해외주식-008": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-present-balance",
    "trIdReal": "CTRP6504R",
    "trIdMock": "VTRP6504R",
    "name": "해외주식 체결기준현재잔고"
  },
  "해외주식-070": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-algo-ccnl",
    "trIdReal": "TTTS6059R",
    "trIdMock": "",
    "name": "해외주식 지정가체결내역조회"
  },
  "v1_해외주식-032": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-period-profit",
    "trIdReal": "TTTS3039R",
    "trIdMock": "",
    "name": "해외주식 기간손익"
  },
  "v1_해외주식-014": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-psamount",
    "trIdReal": "TTTS3007R",
    "trIdMock": "VTTS3007R",
    "name": "해외주식 매수가능금액조회"
  },
  "v1_해외주식-003": {
    "method": "POST",
    "path": "/uapi/overseas-stock/v1/trading/order-rvsecncl",
    "trIdReal": "(미국 정정·취소) TTTT1004U (아시아 국가 하단 규격서 참고)",
    "trIdMock": "(미국 정정·취소) VTTT1004U (아시아 국가 하단 규격서 참고)",
    "name": "해외주식 정정취소주문"
  },
  "v1_해외주식-002": {
    "method": "POST",
    "path": "/uapi/overseas-stock/v1/trading/order-resv",
    "trIdReal": "(미국예약매수) TTTT3014U  (미국예약매도) TTTT3016U   (중국/홍콩/일본/베트남 예약주문) TTTS3013U",
    "trIdMock": "(미국예약매수) VTTT3014U  (미국예약매도) VTTT3016U   (중국/홍콩/일본/베트남 예약주문) VTTS3013U",
    "name": "해외주식 예약주문접수"
  },
  "v1_해외주식-005": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-nccs",
    "trIdReal": "TTTS3018R",
    "trIdMock": "",
    "name": "해외주식 미체결내역"
  },
  "v1_해외주식-027": {
    "method": "POST",
    "path": "/uapi/overseas-stock/v1/trading/daytime-order-rvsecncl",
    "trIdReal": "TTTS6038U",
    "trIdMock": "",
    "name": "해외주식 미국주간정정취소"
  },
  "v1_해외주식-007": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-ccnl",
    "trIdReal": "TTTS3035R",
    "trIdMock": "VTTS3035R",
    "name": "해외주식 주문체결내역"
  },
  "해외주식-064": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-paymt-stdr-balance",
    "trIdReal": "CTRP6010R",
    "trIdMock": "",
    "name": "해외주식 결제기준잔고"
  },
  "해외주식-063": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/inquire-period-trans",
    "trIdReal": "CTOS4001R",
    "trIdMock": "",
    "name": "해외주식 일별거래내역"
  },
  "v1_해외주식-026": {
    "method": "POST",
    "path": "/uapi/overseas-stock/v1/trading/daytime-order",
    "trIdReal": "(주간매수) TTTS6036U (주간매도) TTTS6037U",
    "trIdMock": "",
    "name": "해외주식 미국주간주문"
  },
  "v1_해외주식-013": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/order-resv-list",
    "trIdReal": "(미국) TTTT3039R (일본/중국/홍콩/베트남) TTTS3014R",
    "trIdMock": "",
    "name": "해외주식 예약주문조회"
  },
  "v1_해외주식-001": {
    "method": "POST",
    "path": "/uapi/overseas-stock/v1/trading/order",
    "trIdReal": "(미국매수) TTTT1002U  (미국매도) TTTT1006U (아시아 국가 하단 규격서 참고)",
    "trIdMock": "(미국매수) VTTT1002U  (미국매도) VTTT1001U  (아시아 국가 하단 규격서 참고)",
    "name": "해외주식 주문"
  },
  "v1_해외주식-004": {
    "method": "POST",
    "path": "/uapi/overseas-stock/v1/trading/order-resv-ccnl",
    "trIdReal": "(미국 예약주문 취소접수) TTTT3017U (아시아국가 미제공)",
    "trIdMock": "(미국 예약주문 취소접수) VTTT3017U (아시아국가 미제공)",
    "name": "해외주식 예약주문접수취소"
  },
  "해외주식-071": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/algo-ordno",
    "trIdReal": "TTTS6058R",
    "trIdMock": "",
    "name": "해외주식 지정가주문번호조회"
  },
  "해외주식-035": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/trading/foreign-margin",
    "trIdReal": "TTTC2101R",
    "trIdMock": "",
    "name": "해외증거금 통화별조회"
  },
  "해외주식-037": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/inquire-ccnl",
    "trIdReal": "HHDFS76200300",
    "trIdMock": "",
    "name": "해외주식 체결추이"
  },
  "v1_해외주식-010": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/dailyprice",
    "trIdReal": "HHDFS76240000",
    "trIdMock": "HHDFS76240000",
    "name": "해외주식 기간별시세"
  },
  "해외주식-017": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/quotations/countries-holiday",
    "trIdReal": "CTOS5011R",
    "trIdMock": "",
    "name": "해외결제일자조회"
  },
  "v1_해외주식-009": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/price",
    "trIdReal": "HHDFS00000300",
    "trIdMock": "HHDFS00000300",
    "name": "해외주식 현재체결가"
  },
  "해외주식 복수종목 시세조회": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/multprice",
    "trIdReal": "HHDFS76220000 ",
    "trIdMock": "미지원 ",
    "name": "해외주식 복수종목 시세조회"
  },
  "v1_해외주식-015": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/inquire-search",
    "trIdReal": "HHDFS76410000",
    "trIdMock": "HHDFS76410000",
    "name": "해외주식조건검색"
  },
  "v1_해외주식-034": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/search-info",
    "trIdReal": "CTPF1702R",
    "trIdMock": "",
    "name": "해외주식 상품기본정보"
  },
  "v1_해외주식-031": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice",
    "trIdReal": "FHKST03030200",
    "trIdMock": "",
    "name": "해외지수분봉조회"
  },
  "v1_해외주식-030": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice",
    "trIdReal": "HHDFS76950200",
    "trIdMock": "",
    "name": "해외주식분봉조회"
  },
  "v1_해외주식-029": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/price-detail",
    "trIdReal": "HHDFS76200200",
    "trIdMock": "",
    "name": "해외주식 현재가상세"
  },
  "해외주식-049": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/industry-price",
    "trIdReal": "HHDFS76370100",
    "trIdMock": "",
    "name": "해외주식 업종별코드조회"
  },
  "v1_해외주식-012": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice",
    "trIdReal": "FHKST03030100",
    "trIdMock": "FHKST03030100",
    "name": "해외주식 종목/지수/환율기간별시세(일/주/월/년)"
  },
  "해외주식-048": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/industry-theme",
    "trIdReal": "HHDFS76370000",
    "trIdMock": "",
    "name": "해외주식 업종별시세"
  },
  "해외주식-033": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/inquire-asking-price",
    "trIdReal": "HHDFS76200100",
    "trIdMock": "",
    "name": "해외주식 현재가 호가"
  },
  "해외주식-045": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/trade-growth",
    "trIdReal": "HHDFS76330000",
    "trIdMock": "",
    "name": "해외주식 거래증가율순위"
  },
  "해외주식-052": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/period-rights",
    "trIdReal": "CTRGT011R",
    "trIdMock": "",
    "name": "해외주식 기간별권리조회"
  },
  "해외주식-038": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/price-fluct",
    "trIdReal": "HHDFS76260000",
    "trIdMock": "",
    "name": "해외주식 가격급등락"
  },
  "해외주식-044": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/trade-pbmn",
    "trIdReal": "HHDFS76320010",
    "trIdMock": "",
    "name": "해외주식 거래대금순위"
  },
  "해외주식-039": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/volume-surge",
    "trIdReal": "HHDFS76270000",
    "trIdMock": "",
    "name": "해외주식 거래량급증"
  },
  "해외주식-042": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/new-highlow",
    "trIdReal": "HHDFS76300000",
    "trIdMock": "",
    "name": "해외주식 신고/신저가"
  },
  "해외주식-040": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/volume-power",
    "trIdReal": "HHDFS76280000",
    "trIdMock": "",
    "name": "해외주식 매수체결강도상위"
  },
  "해외주식-046": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/trade-turnover",
    "trIdReal": "HHDFS76340000",
    "trIdMock": "",
    "name": "해외주식 거래회전율순위"
  },
  "해외주식-053": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/news-title",
    "trIdReal": "HHPSTH60100C1",
    "trIdMock": "",
    "name": "해외뉴스종합(제목)"
  },
  "해외주식-051": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/colable-by-company",
    "trIdReal": "CTLN4050R",
    "trIdMock": "",
    "name": "당사 해외주식담보대출 가능 종목"
  },
  "해외주식-047": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/market-cap",
    "trIdReal": "HHDFS76350100",
    "trIdMock": "",
    "name": "해외주식 시가총액순위"
  },
  "해외주식-055": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/brknews-title",
    "trIdReal": "FHKST01011801",
    "trIdMock": "",
    "name": "해외속보(제목)"
  },
  "해외주식-041": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/updown-rate",
    "trIdReal": "HHDFS76290000",
    "trIdMock": "",
    "name": "해외주식 상승율/하락율"
  },
  "해외주식-050": {
    "method": "GET",
    "path": "/uapi/overseas-price/v1/quotations/rights-by-ice",
    "trIdReal": "HHDFS78330900",
    "trIdMock": "",
    "name": "해외주식 권리종합"
  },
  "해외주식-043": {
    "method": "GET",
    "path": "/uapi/overseas-stock/v1/ranking/trade-vol",
    "trIdReal": "HHDFS76310010",
    "trIdMock": "",
    "name": "해외주식 거래량순위"
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
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kis-overseas-stock 에서 등록해주세요.' }));
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

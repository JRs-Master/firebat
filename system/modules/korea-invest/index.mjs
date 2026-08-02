#!/usr/bin/env node
/**
 * Firebat System Module: korea-invest — codegen 자동 생성 (scripts/gen.mjs).
 * 한국투자증권 OPEN API 통합 (278 REST API).
 *
 * LLM 시점: config.json 의 domains[] 가 9개 별도 도구로 분리 등록.
 * 단일 모듈로 라우팅 — action 으로 API ID 직접 호출, tr_id 자동 분기 (실전/모의).
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

const API_TABLE = {
  "인증-002": {
    "method": "POST",
    "path": "/oauth2/revokeP",
    "trIdReal": "",
    "trIdMock": "",
    "name": "접근토큰폐기(P)"
  },
  "인증-001": {
    "method": "POST",
    "path": "/oauth2/tokenP",
    "trIdReal": "",
    "trIdMock": "",
    "name": "접근토큰발급(P)"
  },
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
  },
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
  "ETF 현재가 호가": {
    "method": "GET",
    "path": "/uapi/etfetn/v1/quotations/inquire-asking-price",
    "trIdReal": "FHPST02400200",
    "trIdMock": "",
    "name": "ETF 현재가 호가"
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
  },
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
  "국내주식-163": {
    "method": "GET",
    "path": "/uapi/domestic-stock/v1/quotations/frgnmem-trade-trend",
    "trIdReal": "FHPST04320000",
    "trIdMock": "",
    "name": "회원사 실시간 매매동향(틱)"
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
  },
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
  },
  "국내주식 장운영정보 (통합)": {
    "method": "POST",
    "path": "/tryitout/H0UNMKO0",
    "trIdReal": "H0UNMKO0",
    "trIdMock": "",
    "name": "국내주식 장운영정보 (통합)"
  },
  "국내주식 장운영정보 (NXT)": {
    "method": "POST",
    "path": "/tryitout/H0NXMKO0",
    "trIdReal": "H0NXMKO0",
    "trIdMock": "",
    "name": "국내주식 장운영정보 (NXT)"
  },
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
  },
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
  },
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
  },
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
  },
  "Hashkey": {
    "method": "POST",
    "path": "/uapi/hashkey",
    "trIdReal": "",
    "trIdMock": "",
    "name": "Hashkey"
  }
};

// 토큰 발급·갱신은 인프라 TokenProvider 가 config.json 의 oauth 스펙으로 처리한다.
// sysmod 는 env 로 주입된 raw 토큰(KIS_ACCESS_TOKEN)을 받아쓰기만 한다 — 토큰 코드 0.

// The two domains do not allow the same rate, and the tighter one is the rung of the ladder every
// strategy has to pass through: paper trading on the practice account hit "초당 거래건수를
// 초과하였습니다" on the second call of a cycle, which reads as a broken cycle rather than as a
// speed limit. Measured 2026-08-02 — a candle fetch that pages twice is already over it.
const RATE_LIMIT_REAL = 5;
const RATE_LIMIT_MOCK = 2;
const WINDOW_MS = 1000;
const _reqTimes = [];
let _rateLimit = RATE_LIMIT_REAL;
async function acquireSlot() {
  while (true) {
    const now = Date.now();
    while (_reqTimes.length > 0 && now - _reqTimes[0] >= WINDOW_MS) _reqTimes.shift();
    if (_reqTimes.length < _rateLimit) { _reqTimes.push(now); return; }
    await new Promise(r => setTimeout(r, WINDOW_MS - (now - _reqTimes[0]) + 5));
  }
}

async function callApi(base, token, appKey, appSecret, action, query = {}, body = {}, isMock = false, retry = 3, trIdOverride = '') {
  const meta = API_TABLE[action];
  if (!meta) throw new Error(`알 수 없는 API ID: ${action} — 이 값을 지어내지 마세요. search_module_actions(query) 로 맞는 액션을 찾고 get_action_schema('korea-invest', action) 으로 파라미터를 확인하세요. 단순 시세·차트·과거 데이터는 yfinance(action='history')가 더 쉽습니다.`);
  // Some sheet entries hold a sentence covering several ids (buy and sell on one line) rather
  // than a single id. Whoever knows which side this call is resolves it and passes it in.
  const trId = trIdOverride || (isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal);
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
  _rateLimit = isMock ? RATE_LIMIT_MOCK : RATE_LIMIT_REAL;
  await acquireSlot();
  const init = { method: meta.method, headers, signal: AbortSignal.timeout(15000) };
  if (meta.method !== 'GET' && Object.keys(body).length > 0) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1, trIdOverride);
  }
  if (!resp.ok) {
    // KIS 는 토큰 만료(EGW00123) 등 일부 오류를 HTTP 500 + JSON 바디(rt_cd/msg1/msg_cd)로 준다.
    // 바디가 KIS 에러 envelope 면 throw 말고 반환 → 상위 rt_cd 검사(인프라 reactive)가 토큰 무효를 감지.
    const errText = await resp.text().catch(() => '');
    try {
      const j = JSON.parse(errText);
      if (j && (j.rt_cd !== undefined || j.msg_cd !== undefined)) return j;
    } catch { /* JSON 아님 — 아래 throw */ }
    throw new Error(`KIS API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }
  const payload = await resp.json();
  // The venue also refuses on rate with HTTP 200 and an error body. Returning it as-is makes a
  // throttled call look like an account with nothing in it, which is the worst possible lie to
  // tell something that reconciles positions.
  if (retry > 0 && String(payload?.msg1 || '').includes('초당 거래건수')) {
    await new Promise(r => setTimeout(r, WINDOW_MS * (3 - retry) + 200));
    return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1, trIdOverride);
  }
  return payload;
}

// Standard OHLCV normalization — rename KIS candle vocabulary to the cross-broker standard
// {date, open, high, low, close, volume} so stock_chart dataCacheKey injection, the timeseries
// store, and cache_grep all speak one vocabulary (yfinance already does). Field-signature
// detection (no per-action enum): a row is a candle when it carries a date field together with a
// close-price field. Covers 국내 일/주/월(stck_bsop_date+stck_clpr), 국내 분봉(stck_cntg_hour+
// stck_prpr), 해외(xymd+clos). Values arrive as strings — Number() them.
function kisNum(v) {
  const n = Number(String(v ?? '').replace(/^[+-]/, ''));
  return Number.isFinite(n) ? n : v;
}
function kisDate8(s) {
  // \d was missing its backslash, so YYYYMMDD never matched and KIS dates stayed unhyphenated
  // while kiwoom's did — the two brokers' `date` vocabularies silently diverged.
  s = String(s ?? '');
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
}
function normalizeCandleRow(row) {
  // 해외 기간별시세 (HHDFS76240000 류): xymd + clos (+open/high/low/tvol)
  if ('xymd' in row && 'clos' in row) {
    row.date = kisDate8(row.xymd); delete row.xymd;
    row.close = kisNum(row.clos); delete row.clos;
    if ('open' in row) row.open = kisNum(row.open);
    if ('high' in row) row.high = kisNum(row.high);
    if ('low' in row) row.low = kisNum(row.low);
    if ('tvol' in row) { row.volume = kisNum(row.tvol); delete row.tvol; }
    return;
  }
  // 국내: stck_bsop_date + (stck_clpr 일/주/월 | stck_prpr 분봉)
  if ('stck_bsop_date' in row && ('stck_clpr' in row || 'stck_prpr' in row)) {
    const day = kisDate8(row.stck_bsop_date); delete row.stck_bsop_date;
    if ('stck_cntg_hour' in row) {
      const t = String(row.stck_cntg_hour).padStart(6, '0');
      row.date = day + ' ' + t.slice(0, 2) + ':' + t.slice(2, 4);
      delete row.stck_cntg_hour;
    } else {
      row.date = day;
    }
    if ('stck_oprc' in row) { row.open = kisNum(row.stck_oprc); delete row.stck_oprc; }
    if ('stck_hgpr' in row) { row.high = kisNum(row.stck_hgpr); delete row.stck_hgpr; }
    if ('stck_lwpr' in row) { row.low = kisNum(row.stck_lwpr); delete row.stck_lwpr; }
    if ('stck_clpr' in row) { row.close = kisNum(row.stck_clpr); delete row.stck_clpr; }
    else if ('stck_prpr' in row) { row.close = kisNum(row.stck_prpr); delete row.stck_prpr; }
    if ('acml_vol' in row) { row.volume = kisNum(row.acml_vol); delete row.acml_vol; }
    else if ('cntg_vol' in row) { row.volume = kisNum(row.cntg_vol); delete row.cntg_vol; }
  }
}
// Candle "latest" dialect — KIS anchors chart queries on an explicit time/date, but a page binding
// (publish bake / rebake / fresh-on-visit seed) carries no clock: a value frozen at authoring time
// would return the same stale window on every later visit. So when the anchor is omitted, default
// it to now/today (KST) — the module owns this dialect, not the caller. Mirrors kiwoom `base_dt`.
function kstParts() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    hms: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`,
  };
}
// Intraday-minute actions anchor on FID_INPUT_HOUR_1 (query end time); period actions anchor on
// FID_INPUT_DATE_2 (end date, with DATE_1 as the window start).
const MINUTE_ANCHOR_ACTIONS = new Set(['v1_국내주식-022', '국내주식-213', 'v1_국내주식-045', 'v1_국내선물-012']);
const PERIOD_ANCHOR_ACTIONS = new Set(['v1_국내주식-016', 'v1_국내주식-021', 'v1_국내선물-008', 'v1_해외주식-010']);
function applyLatestDefaults(action, query) {
  const { day, hms } = kstParts();
  if (MINUTE_ANCHOR_ACTIONS.has(action) && !query.FID_INPUT_HOUR_1) {
    query.FID_INPUT_HOUR_1 = hms;
  }
  if (PERIOD_ANCHOR_ACTIONS.has(action)) {
    if (!query.FID_INPUT_DATE_2) query.FID_INPUT_DATE_2 = day;
    if (!query.FID_INPUT_DATE_1) {
      // ~4 months back — enough for MA60 on daily candles.
      const d = new Date(Date.now() + 9 * 3600 * 1000 - 120 * 86400 * 1000);
      const p = (n) => String(n).padStart(2, '0');
      query.FID_INPUT_DATE_1 = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
    }
  }
}

function normalizeCandles(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const row of v) { if (row && typeof row === 'object') normalizeCandleRow(row); }
    } else if (v && typeof v === 'object') {
      normalizeCandles(v, depth + 1);
    }
  }
}

// ── Standard broker contract ─────────────────────────────────────────────────────────────────
// The same six calls every broker answers, translated here into this one's vocabulary. The point
// is that whoever places an order does not learn that a domestic buy is TTTC0012U, that the same
// call overseas is TTTT1002U, that the account number splits into two body fields, or that the
// exchange is spelled NASD when ordering and NAS when asking for a chart. Swapping brokers should
// be a declaration, not an edit to the caller.
const NEUTRAL = new Set(['place_order', 'cancel_order', 'list_open_orders', 'list_fills',
                         'get_balance', 'get_candles']);

/** The transaction id for this call, chosen from the spec sheet's own labelling.
 *
 * These entries do not hold one id. `v1_국내주식-001` carries "(매도) TTTC0011U (매수) TTTC0012U"
 * — one line covering both sides — and sending that sentence as the `tr_id` header is what this
 * module did until now, which is why an order through this broker has never once been accepted.
 * Reading the label rather than hardcoding the id means a regenerated table stays correct.
 */
function pickTrId(meta, isMock, hint) {
  const raw = String((isMock ? meta.trIdMock : meta.trIdReal) || '').trim();
  if (!raw) {
    throw new Error(isMock
      ? `${meta.name} 은 모의투자를 지원하지 않습니다 — 실전 계좌로 호출하세요.`
      : `${meta.name} 의 tr_id 가 비어 있습니다.`);
  }
  const pairs = [...raw.matchAll(/\(([^)]*)\)\s*([A-Z]{4,}\d{3,}[A-Z]?)/g)]
    .map(m => ({ label: m[1].replace(/\s/g, ''), id: m[2] }));
  if (!pairs.length) return raw;                       // a single bare id
  const hit = hint ? pairs.find(p => p.label.includes(hint)) : null;
  if (hit) return hit.id;
  throw new Error(
    `${meta.name}: '${hint}' 에 해당하는 tr_id 를 찾지 못했습니다 — 후보 ` +
    pairs.map(p => `${p.label}=${p.id}`).join(', '));
}

/** CANO + ACNT_PRDT_CD from the registered account number. */
function accountParts(data) {
  const digits = String(data.accountNo ?? '').replace(/\D/g, '');
  if (digits.length < 8) {
    throw new Error('계좌번호가 없습니다 — 설정 > 시스템 모듈 > korea-invest 에서 계좌를 등록하고 '
                    + '그 별칭으로 호출하세요.');
  }
  // The product code is the last two of a ten-digit number; an eight-digit one is the account
  // without it, and 01 is the ordinary cash account every retail login has.
  return { CANO: digits.slice(0, 8), ACNT_PRDT_CD: digits.length >= 10 ? digits.slice(8, 10) : '01' };
}

/** kr or us — declared, or read off the symbol shape (six digits is a KRX code). */
function marketOf(data) {
  const m = String(data.market ?? '').toLowerCase();
  if (m === 'kr' || m === 'us') return m;
  return /^\d{6}$/.test(String(data.symbol ?? '').trim()) ? 'kr' : 'us';
}

// Ordering and asking for a chart use different spellings of the same exchange.
const US_ORDER_EXCG = { NASD: 'NASD', NAS: 'NASD', NASDAQ: 'NASD', NYSE: 'NYSE', NYS: 'NYSE',
                        AMEX: 'AMEX', AMS: 'AMEX' };
const US_QUOTE_EXCD = { NASD: 'NAS', NYSE: 'NYS', AMEX: 'AMS' };

function usExchange(data) {
  const raw = String(data.exchange ?? 'NASD').toUpperCase();
  const code = US_ORDER_EXCG[raw];
  if (!code) {
    throw new Error(`exchange='${raw}' 는 지원하지 않습니다 — NASD, NYSE, AMEX 중 하나.`);
  }
  return code;
}

function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function requireQty(data) {
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty 는 1 이상이어야 합니다.');
  return String(Math.trunc(qty));
}

function sideHint(data, kr) {
  const side = String(data.side ?? '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('side 는 buy 또는 sell 이어야 합니다.');
  }
  // The sheet labels the domestic pair 매수/매도 and the overseas one 미국매수/미국매도.
  return (kr ? '' : '미국') + (side === 'buy' ? '매수' : '매도');
}

/** A neutral call → what this broker's HTTP layer needs. */
function standardCall(action, data) {
  const kr = marketOf(data) === 'kr';
  const symbol = String(data.symbol ?? '').trim();
  const type = String(data.orderType ?? 'limit').toLowerCase();
  const price = Number(data.price);

  if (action === 'place_order') {
    if (!symbol) throw new Error('place_order: symbol 이 필요합니다.');
    const acct = accountParts(data);
    const qty = requireQty(data);
    if (kr) {
      // 00 지정가 · 01 시장가. A market order carries no unit price; sending one is refused.
      const market = type === 'market';
      if (!market && !(price > 0)) throw new Error('place_order: 지정가 주문에는 price 가 필요합니다.');
      return { apiId: 'v1_국내주식-001', hint: sideHint(data, true), body: {
        ...acct, PDNO: symbol, ORD_DVSN: market ? '01' : '00',
        ORD_QTY: qty, ORD_UNPR: market ? '0' : String(Math.trunc(price)),
      }};
    }
    // The US side has no plain market order here — only limit and the open/close variants. So a
    // market intent becomes a limit priced through the spread, which is what a market order is
    // for (getting out now), with the slip bounded and stated rather than unlimited.
    if (!(price > 0)) throw new Error('place_order: 해외 주문에는 price 가 필요합니다.');
    const slip = Number(data.marketableLimitPct ?? 2) / 100;
    const buying = String(data.side ?? '').toLowerCase() === 'buy';
    const px = type === 'market' ? price * (buying ? 1 + slip : 1 - slip) : price;
    return { apiId: 'v1_해외주식-001', hint: sideHint(data, false), body: {
      ...acct, OVRS_EXCG_CD: usExchange(data), PDNO: symbol, ORD_QTY: qty,
      OVRS_ORD_UNPR: px.toFixed(2), ORD_SVR_DVSN_CD: '0', ORD_DVSN: '00',
    }};
  }

  if (action === 'cancel_order') {
    const orderNo = String(data.brokerOrderNo ?? '').trim();
    if (!orderNo) throw new Error('cancel_order: brokerOrderNo 가 필요합니다.');
    const acct = accountParts(data);
    if (kr) {
      return { apiId: 'v1_국내주식-003', hint: '', body: {
        ...acct, KRX_FWDG_ORD_ORGNO: String(data.orderBranch ?? ''), ORGN_ODNO: orderNo,
        ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02',
        // Cancelling means whatever is left, so the whole-order flag carries it and the quantity
        // is ignored — passing a stale one would cancel the wrong amount.
        ORD_QTY: '0', ORD_UNPR: '0', QTY_ALL_ORD_YN: 'Y',
      }};
    }
    return { apiId: 'v1_해외주식-003', hint: '정정·취소', body: {
      ...acct, OVRS_EXCG_CD: usExchange(data), PDNO: symbol, ORGN_ODNO: orderNo,
      RVSE_CNCL_DVSN_CD: '02', ORD_QTY: String(Math.trunc(Number(data.qty) || 0)),
      OVRS_ORD_UNPR: '0', ORD_SVR_DVSN_CD: '0',
    }};
  }

  if (action === 'get_balance') {
    const acct = accountParts(data);
    if (kr) {
      return { apiId: 'v1_국내주식-006', hint: '', query: {
        ...acct, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
        CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      }};
    }
    return { apiId: 'v1_해외주식-006', hint: '', query: {
      ...acct, OVRS_EXCG_CD: usExchange(data), TR_CRCY_CD: String(data.currency ?? 'USD'),
      CTX_AREA_FK200: '', CTX_AREA_NK200: '',
    }};
  }

  if (action === 'list_open_orders' || action === 'list_fills') {
    const acct = accountParts(data);
    const open = action === 'list_open_orders';
    const from = String(data.from ?? '').replace(/-/g, '') || kstDate(-7);
    const to = String(data.to ?? '').replace(/-/g, '') || kstDate(0);
    if (kr) {
      // One endpoint answers both — 01 filled, 02 resting. Two neutral calls, one dialect.
      return { apiId: 'v1_국내주식-005', hint: '3개월이내', query: {
        ...acct, INQR_STRT_DT: from, INQR_END_DT: to, SLL_BUY_DVSN_CD: '00',
        INQR_DVSN: '00', PDNO: symbol, CCLD_DVSN: open ? '02' : '01',
        ORD_GNO_BRNO: '', ODNO: '', INQR_DVSN_3: '00', INQR_DVSN_1: '',
        CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      }};
    }
    // Overseas: the dedicated unfilled endpoint has no mock id at all, and 주문체결내역 splits
    // the same way (01/02) while working in both. Using it for both keeps the mock rung of the
    // ladder usable, which is the whole point of having one.
    return { apiId: 'v1_해외주식-007', hint: '', query: {
      ...acct, PDNO: symbol, ORD_STRT_DT: from, ORD_END_DT: to,
      SLL_BUY_DVSN: '00', CCLD_NCCS_DVSN: open ? '02' : '01',
      OVRS_EXCG_CD: usExchange(data), SORT_SQN: 'DS', ORD_DT: '', ORD_GNO_BRNO: '', ODNO: '',
      CTX_AREA_NK200: '', CTX_AREA_FK200: '',
    }};
  }

  throw new Error(`standardCall: ${action} 은 중립 계약에 없습니다.`);
}

// ── Candles ──────────────────────────────────────────────────────────────────────────────────
// Both endpoints answer at most a hundred bars, and a rule with a 60-period average says nothing
// at all until it has more than that. So the interval is the argument, the paging lives here, and
// the caller asks for a bar count exactly as it does of every other broker.
const KR_PERIOD = { '1d': 'D', '1w': 'W', '1M': 'M', '1y': 'Y' };
const US_PERIOD = { '1d': '0', '1w': '1', '1M': '2' };
const PERIOD_DAYS = { D: 1, W: 7, M: 31, Y: 366 };
const CANDLE_PAGE = 100;
const MAX_CANDLE_PAGES = 12;

function candleRows(result) {
  for (const k of ['output2', 'output1', 'output']) {
    if (Array.isArray(result?.[k])) return result[k];
  }
  return [];
}

function shiftDate8(d8, days) {
  const t = new Date(Date.UTC(Number(d8.slice(0, 4)), Number(d8.slice(4, 6)) - 1,
                              Number(d8.slice(6, 8)) + days));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

async function fetchCandles(ctx, data) {
  const symbol = String(data.symbol ?? '').trim();
  if (!symbol) throw new Error('get_candles: symbol 이 필요합니다.');
  const interval = String(data.interval ?? '1d').trim();
  const kr = marketOf(data) === 'kr';
  const want = Math.max(1, Math.min(Number(data.bars) || 200, CANDLE_PAGE * MAX_CANDLE_PAGES));
  const period = (kr ? KR_PERIOD : US_PERIOD)[interval];
  if (!period) {
    throw new Error(
      `get_candles: interval='${interval}' 은 지원하지 않습니다 — ` +
      `${Object.keys(kr ? KR_PERIOD : US_PERIOD).join(', ')} 중 하나. ` +
      '분봉은 이 브로커의 기간별시세 엔드포인트에 없습니다.');
  }
  const apiId = kr ? 'v1_국내주식-016' : 'v1_해외주식-010';
  const meta = API_TABLE[apiId];
  const trId = pickTrId(meta, ctx.isMock, '');
  const span = Math.ceil(CANDLE_PAGE * 1.7) * (PERIOD_DAYS[period] || 1);
  const byDate = new Map();
  let cursor = String(data.baseDate ?? '').replace(/-/g, '') || kstDate(0);
  for (let page = 0; page < MAX_CANDLE_PAGES && byDate.size < want; page += 1) {
    const query = kr
      ? { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol,
          // A page reaches back far enough to fill itself whatever the period is; the response is
          // capped at a hundred rows and the cursor then moves by what actually came back.
          FID_INPUT_DATE_1: shiftDate8(cursor, -span), FID_INPUT_DATE_2: cursor,
          FID_PERIOD_DIV_CODE: period, FID_ORG_ADJ_PRC: data.adjusted === false ? '1' : '0' }
      : { AUTH: '', EXCD: US_QUOTE_EXCD[usExchange(data)], SYMB: symbol,
          GUBN: period, BYMD: cursor, MODP: data.adjusted === false ? '0' : '1' };
    const result = await ctx.call(apiId, trId, query, {});
    if (result?.rt_cd !== undefined && result.rt_cd !== '0') {
      // Page one failing is the call failing; a later page failing still has bars to hand back.
      if (page === 0) throw new Error(result.msg1 || `한투 API 오류 (rt_cd=${result.rt_cd})`);
      break;
    }
    const rows = candleRows(result);
    if (!rows.length) break;
    let oldest = null;
    for (const row of rows) {
      normalizeCandleRow(row);
      const date = String(row.date ?? '');
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, row);
      const d8 = date.replace(/-/g, '');
      if (!oldest || d8 < oldest) oldest = d8;
    }
    if (!oldest || oldest >= cursor) break;   // no progress — stop rather than loop
    cursor = shiftDate8(oldest, -1);
  }
  const all = [...byDate.values()]
    .filter(r => Number(r.close) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { rows: all.slice(-want), apiId, interval, market: kr ? 'kr' : 'us' };
}

/** The one row list, by this broker's own naming: output1 is the detail, output2 the summary. */
function neutralRows(result) {
  for (const k of ['output1', 'output']) {
    if (Array.isArray(result?.[k])) return { field: k, rows: result[k] };
  }
  const arrays = Object.entries(result || {}).filter(([, v]) => Array.isArray(v));
  return arrays.length === 1 ? { field: arrays[0][0], rows: arrays[0][1] } : { field: null, rows: [] };
}


let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 한투 API ID (v1_국내주식-008 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIS_APP_KEY'];
    const appSecret = process.env['KIS_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > korea-invest 에서 등록하세요.' }));
      return;
    }
    // 토큰 = 인프라(TokenProvider)가 발급·선제갱신해 env 로 주입한 raw 토큰. 무효 시엔 인프라가
    // 응답의 rt_cd/msg1 을 보고 재발급 후 1회 재시도하므로, sysmod 는 받아쓰기만 한다 (토큰 코드 0).
    const token = process.env['KIS_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: 'KIS 접근 토큰 미발급 — 인프라 토큰 발급 실패 또는 앱키 미설정.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;

    // ── Neutral contract ──────────────────────────────────────────────────────────────────
    if (NEUTRAL.has(action)) {
      const ctx = {
        isMock,
        call: (apiId, trId, q, b) =>
          callApi(base, token, appKey, appSecret, apiId, q, b, isMock, 2, trId),
      };
      if (action === 'get_candles') {
        const out = await fetchCandles(ctx, data);
        console.log(JSON.stringify({ success: true, data: { action, ...out, count: out.rows.length } }));
        return;
      }
      const mapped = standardCall(action, data);
      const meta = API_TABLE[mapped.apiId];
      const trId = pickTrId(meta, isMock, mapped.hint);
      const result = await ctx.call(mapped.apiId, trId, mapped.query || {}, mapped.body || {});
      const ok = result?.rt_cd === undefined || result.rt_cd === null || result.rt_cd === '0';
      const out = { success: ok, data: { action, apiId: mapped.apiId, trId, ...result } };
      if (!ok) out.error = result?.msg1 || `한투 API 오류 (rt_cd=${result?.rt_cd})`;
      if (action === 'place_order' || action === 'cancel_order') {
        // The ledger matches on the caller's id, and the response schema is read off the request
        // later — it is documented nowhere, so the request that produced it is kept beside it.
        out.data.clientOrderId = data.clientOrderId ?? null;
        out.data.sentBody = mapped.body;
      } else if (ok) {
        const picked = neutralRows(result);
        out.data.rows = picked.rows;
        out.data.rowsField = picked.field;
      }
      console.log(JSON.stringify(out));
      return;
    }

    const query = data.query || {};
    const body = data.body || {};
    applyLatestDefaults(action, query);
    const result = await callApi(base, token, appKey, appSecret, action, query, body, isMock);
    normalizeCandles(result);
    const meta = API_TABLE[action];
    // KIS rt_cd: "0"=정상, 그 외=오류. HTTP 200 이라 envelope success:true 로 가려졌던 것 →
    // "0" 만 success (kiwoom return_code 와 동일 의도 — AI 가 실패를 모르고 fabricate 차단).
    const rtCd = result?.rt_cd;
    const ok = rtCd === undefined || rtCd === null || rtCd === '0';
    const output = { success: ok, data: { apiId: action, trId: isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal, name: meta.name, ...result } };
    if (!ok) output.error = result?.msg1 || `한투 API 오류 (rt_cd=${rtCd})`;
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom — codegen 자동 생성 (scripts/gen.mjs).
 * 키움증권 OPEN API 통합 (208 REST API).
 *
 * LLM 시점: config.json 의 domains[] 가 MCP register_sysmod_tools 에 의해 8개 별도 도구로 분리 등록
 * (sysmod_kiwoom_account / sysmod_kiwoom_chart 등). 모든 도구가 본 단일 모듈로 라우팅. action 으로
 * API ID (ka10001 등) 직접 호출.
 *
 * OAuth + callApi + throttle (초당 5회) 내장.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 카테고리 (POST /api/dostk/{category} + api-id 헤더)
const URL_CATEGORY = {
  "ka00001": "acnt",
  "ka00198": "stkinfo",
  "ka01690": "acnt",
  "ka10001": "stkinfo",
  "ka10002": "stkinfo",
  "ka10003": "stkinfo",
  "ka10004": "mrkcond",
  "ka10005": "mrkcond",
  "ka10006": "mrkcond",
  "ka10007": "mrkcond",
  "ka10008": "frgnistt",
  "ka10009": "frgnistt",
  "ka10010": "sect",
  "ka10011": "mrkcond",
  "ka10013": "stkinfo",
  "ka10014": "shsa",
  "ka10015": "stkinfo",
  "ka10016": "stkinfo",
  "ka10017": "stkinfo",
  "ka10018": "stkinfo",
  "ka10019": "stkinfo",
  "ka10020": "rkinfo",
  "ka10021": "rkinfo",
  "ka10022": "rkinfo",
  "ka10023": "rkinfo",
  "ka10024": "stkinfo",
  "ka10025": "stkinfo",
  "ka10026": "stkinfo",
  "ka10027": "rkinfo",
  "ka10028": "stkinfo",
  "ka10029": "rkinfo",
  "ka10030": "rkinfo",
  "ka10031": "rkinfo",
  "ka10032": "rkinfo",
  "ka10033": "rkinfo",
  "ka10034": "rkinfo",
  "ka10035": "rkinfo",
  "ka10036": "rkinfo",
  "ka10037": "rkinfo",
  "ka10038": "rkinfo",
  "ka10039": "rkinfo",
  "ka10040": "rkinfo",
  "ka10042": "rkinfo",
  "ka10043": "stkinfo",
  "ka10044": "mrkcond",
  "ka10045": "mrkcond",
  "ka10046": "mrkcond",
  "ka10047": "mrkcond",
  "ka10048": "elw",
  "ka10050": "elw",
  "ka10051": "sect",
  "ka10052": "stkinfo",
  "ka10053": "rkinfo",
  "ka10054": "stkinfo",
  "ka10055": "stkinfo",
  "ka10058": "stkinfo",
  "ka10059": "stkinfo",
  "ka10060": "chart",
  "ka10061": "stkinfo",
  "ka10062": "rkinfo",
  "ka10063": "mrkcond",
  "ka10064": "chart",
  "ka10065": "rkinfo",
  "ka10066": "mrkcond",
  "ka10068": "slb",
  "ka10069": "slb",
  "ka10072": "acnt",
  "ka10073": "acnt",
  "ka10074": "acnt",
  "ka10075": "acnt",
  "ka10076": "acnt",
  "ka10077": "acnt",
  "ka10078": "mrkcond",
  "ka10079": "chart",
  "ka10080": "chart",
  "ka10081": "chart",
  "ka10082": "chart",
  "ka10083": "chart",
  "ka10084": "stkinfo",
  "ka10085": "acnt",
  "ka10086": "mrkcond",
  "ka10087": "mrkcond",
  "ka10088": "acnt",
  "ka10094": "chart",
  "ka10095": "stkinfo",
  "ka10098": "rkinfo",
  "ka10099": "stkinfo",
  "ka10100": "stkinfo",
  "ka10101": "stkinfo",
  "ka10102": "stkinfo",
  "ka10131": "frgnistt",
  "ka10170": "acnt",
  "ka10171": "websocket",
  "ka10172": "websocket",
  "ka10173": "websocket",
  "ka10174": "websocket",
  "ka20001": "sect",
  "ka20002": "sect",
  "ka20003": "sect",
  "ka20004": "chart",
  "ka20005": "chart",
  "ka20006": "chart",
  "ka20007": "chart",
  "ka20008": "chart",
  "ka20009": "sect",
  "ka20019": "chart",
  "ka20068": "slb",
  "ka30001": "elw",
  "ka30002": "elw",
  "ka30003": "elw",
  "ka30004": "elw",
  "ka30005": "elw",
  "ka30009": "elw",
  "ka30010": "elw",
  "ka30011": "elw",
  "ka30012": "elw",
  "ka40001": "etf",
  "ka40002": "etf",
  "ka40003": "etf",
  "ka40004": "etf",
  "ka40006": "etf",
  "ka40007": "etf",
  "ka40008": "etf",
  "ka40009": "etf",
  "ka40010": "etf",
  "ka50010": "mrkcond",
  "ka50012": "mrkcond",
  "ka50079": "chart",
  "ka50080": "chart",
  "ka50081": "chart",
  "ka50082": "chart",
  "ka50083": "chart",
  "ka50087": "mrkcond",
  "ka50091": "chart",
  "ka50092": "chart",
  "ka50100": "mrkcond",
  "ka50101": "mrkcond",
  "ka52301": "frgnistt",
  "ka90001": "thme",
  "ka90002": "thme",
  "ka90003": "stkinfo",
  "ka90004": "stkinfo",
  "ka90005": "mrkcond",
  "ka90006": "mrkcond",
  "ka90007": "mrkcond",
  "ka90008": "mrkcond",
  "ka90009": "rkinfo",
  "ka90010": "mrkcond",
  "ka90012": "slb",
  "ka90013": "mrkcond",
  "kt00001": "acnt",
  "kt00002": "acnt",
  "kt00003": "acnt",
  "kt00004": "acnt",
  "kt00005": "acnt",
  "kt00007": "acnt",
  "kt00008": "acnt",
  "kt00009": "acnt",
  "kt00010": "acnt",
  "kt00011": "acnt",
  "kt00012": "acnt",
  "kt00013": "acnt",
  "kt00015": "acnt",
  "kt00016": "acnt",
  "kt00017": "acnt",
  "kt00018": "acnt",
  "kt10000": "ordr",
  "kt10001": "ordr",
  "kt10002": "ordr",
  "kt10003": "ordr",
  "kt10006": "crdordr",
  "kt10007": "crdordr",
  "kt10008": "crdordr",
  "kt10009": "crdordr",
  "kt20016": "stkinfo",
  "kt20017": "stkinfo",
  "kt50000": "ordr",
  "kt50001": "ordr",
  "kt50002": "ordr",
  "kt50003": "ordr",
  "kt50020": "acnt",
  "kt50021": "acnt",
  "kt50030": "acnt",
  "kt50031": "acnt",
  "kt50032": "acnt",
  "kt50075": "acnt",
  "00": "websocket",
  "04": "websocket",
  "0A": "websocket",
  "0B": "websocket",
  "0C": "websocket",
  "0D": "websocket",
  "0E": "websocket",
  "0F": "websocket",
  "0G": "websocket",
  "0H": "websocket",
  "0I": "websocket",
  "0J": "websocket",
  "0U": "websocket",
  "0g": "websocket",
  "0m": "websocket",
  "0s": "websocket",
  "0u": "websocket",
  "0w": "websocket",
  "1h": "websocket"
};
// API ID → 한글명 (에러 메시지 + 결과 enrichment)
const API_NAMES = {
  "au10001": "접근토큰 발급",
  "au10002": "접근토큰폐기",
  "ka00001": "계좌번호조회",
  "ka00198": "실시간종목조회순위",
  "ka01690": "일별잔고수익률",
  "ka10001": "주식기본정보요청",
  "ka10002": "주식거래원요청",
  "ka10003": "체결정보요청",
  "ka10004": "주식호가요청",
  "ka10005": "주식일주월시분요청",
  "ka10006": "주식시분요청",
  "ka10007": "시세표성정보요청",
  "ka10008": "주식외국인종목별매매동향",
  "ka10009": "주식기관요청",
  "ka10010": "업종프로그램요청",
  "ka10011": "신주인수권전체시세요청",
  "ka10013": "신용매매동향요청",
  "ka10014": "공매도추이요청",
  "ka10015": "일별거래상세요청",
  "ka10016": "신고저가요청",
  "ka10017": "상하한가요청",
  "ka10018": "고저가근접요청",
  "ka10019": "가격급등락요청",
  "ka10020": "호가잔량상위요청",
  "ka10021": "호가잔량급증요청",
  "ka10022": "잔량율급증요청",
  "ka10023": "거래량급증요청",
  "ka10024": "거래량갱신요청",
  "ka10025": "매물대집중요청",
  "ka10026": "고저PER요청",
  "ka10027": "전일대비등락률상위요청",
  "ka10028": "시가대비등락률요청",
  "ka10029": "예상체결등락률상위요청",
  "ka10030": "당일거래량상위요청",
  "ka10031": "전일거래량상위요청",
  "ka10032": "거래대금상위요청",
  "ka10033": "신용비율상위요청",
  "ka10034": "외인기간별매매상위요청",
  "ka10035": "외인연속순매매상위요청",
  "ka10036": "외인한도소진율증가상위",
  "ka10037": "외국계창구매매상위요청",
  "ka10038": "종목별증권사순위요청",
  "ka10039": "증권사별매매상위요청",
  "ka10040": "당일주요거래원요청",
  "ka10042": "순매수거래원순위요청",
  "ka10043": "거래원매물대분석요청",
  "ka10044": "일별기관매매종목요청",
  "ka10045": "종목별기관매매추이요청",
  "ka10046": "체결강도추이시간별요청",
  "ka10047": "체결강도추이일별요청",
  "ka10048": "ELW일별민감도지표요청",
  "ka10050": "ELW민감도지표요청",
  "ka10051": "업종별투자자순매수요청",
  "ka10052": "거래원순간거래량요청",
  "ka10053": "당일상위이탈원요청",
  "ka10054": "변동성완화장치발동종목요청",
  "ka10055": "당일전일체결량요청",
  "ka10058": "투자자별일별매매종목요청",
  "ka10059": "종목별투자자기관별요청",
  "ka10060": "종목별투자자기관별차트요청",
  "ka10061": "종목별투자자기관별합계요청",
  "ka10062": "동일순매매순위요청",
  "ka10063": "장중투자자별매매요청",
  "ka10064": "장중투자자별매매차트요청",
  "ka10065": "장중투자자별매매상위요청",
  "ka10066": "장마감후투자자별매매요청",
  "ka10068": "대차거래추이요청",
  "ka10069": "대차거래상위10종목요청",
  "ka10072": "일자별종목별실현손익요청_일자",
  "ka10073": "일자별종목별실현손익요청_기간",
  "ka10074": "일자별실현손익요청",
  "ka10075": "미체결요청",
  "ka10076": "체결요청",
  "ka10077": "당일실현손익상세요청",
  "ka10078": "증권사별종목매매동향요청",
  "ka10079": "주식틱차트조회요청",
  "ka10080": "주식분봉차트조회요청",
  "ka10081": "주식일봉차트조회요청",
  "ka10082": "주식주봉차트조회요청",
  "ka10083": "주식월봉차트조회요청",
  "ka10084": "당일전일체결요청",
  "ka10085": "계좌수익률요청",
  "ka10086": "일별주가요청",
  "ka10087": "시간외단일가요청",
  "ka10088": "미체결 분할주문 상세",
  "ka10094": "주식년봉차트조회요청",
  "ka10095": "관심종목정보요청",
  "ka10098": "시간외단일가등락율순위요청",
  "ka10099": "종목정보 리스트",
  "ka10100": "종목정보 조회",
  "ka10101": "업종코드 리스트",
  "ka10102": "회원사 리스트",
  "ka10131": "기관외국인연속매매현황요청",
  "ka10170": "당일매매일지요청",
  "ka10171": "조건검색 목록조회",
  "ka10172": "조건검색 요청 일반",
  "ka10173": "조건검색 요청 실시간",
  "ka10174": "조건검색 실시간 해제",
  "ka20001": "업종현재가요청",
  "ka20002": "업종별주가요청",
  "ka20003": "전업종지수요청",
  "ka20004": "업종틱차트조회요청",
  "ka20005": "업종분봉조회요청",
  "ka20006": "업종일봉조회요청",
  "ka20007": "업종주봉조회요청",
  "ka20008": "업종월봉조회요청",
  "ka20009": "업종현재가일별요청",
  "ka20019": "업종년봉조회요청",
  "ka20068": "대차거래추이요청(종목별)",
  "ka30001": "ELW가격급등락요청",
  "ka30002": "거래원별ELW순매매상위요청",
  "ka30003": "ELWLP보유일별추이요청",
  "ka30004": "ELW괴리율요청",
  "ka30005": "ELW조건검색요청",
  "ka30009": "ELW등락율순위요청",
  "ka30010": "ELW잔량순위요청",
  "ka30011": "ELW근접율요청",
  "ka30012": "ELW종목상세정보요청",
  "ka40001": "ETF수익율요청",
  "ka40002": "ETF종목정보요청",
  "ka40003": "ETF일별추이요청",
  "ka40004": "ETF전체시세요청",
  "ka40006": "ETF시간대별추이요청",
  "ka40007": "ETF시간대별체결요청",
  "ka40008": "ETF일자별체결요청",
  "ka40009": "ETF시간대별체결요청",
  "ka40010": "ETF시간대별추이요청",
  "ka50010": "금현물체결추이",
  "ka50012": "금현물일별추이",
  "ka50079": "금현물틱차트조회요청",
  "ka50080": "금현물분봉차트조회요청",
  "ka50081": "금현물일봉차트조회요청",
  "ka50082": "금현물주봉차트조회요청",
  "ka50083": "금현물월봉차트조회요청",
  "ka50087": "금현물예상체결",
  "ka50091": "금현물당일틱차트조회요청",
  "ka50092": "금현물당일분봉차트조회요청",
  "ka50100": "금현물 시세정보",
  "ka50101": "금현물 호가",
  "ka52301": "금현물투자자현황",
  "ka90001": "테마그룹별요청",
  "ka90002": "테마구성종목요청",
  "ka90003": "프로그램순매수상위50요청",
  "ka90004": "종목별프로그램매매현황요청",
  "ka90005": "프로그램매매추이요청 시간대별",
  "ka90006": "프로그램매매차익잔고추이요청",
  "ka90007": "프로그램매매누적추이요청",
  "ka90008": "종목시간별프로그램매매추이요청",
  "ka90009": "외국인기관매매상위요청",
  "ka90010": "프로그램매매추이요청 일자별",
  "ka90012": "대차거래내역요청",
  "ka90013": "종목일별프로그램매매추이요청",
  "kt00001": "예수금상세현황요청",
  "kt00002": "일별추정예탁자산현황요청",
  "kt00003": "추정자산조회요청",
  "kt00004": "계좌평가현황요청",
  "kt00005": "체결잔고요청",
  "kt00007": "계좌별주문체결내역상세요청",
  "kt00008": "계좌별익일결제예정내역요청",
  "kt00009": "계좌별주문체결현황요청",
  "kt00010": "주문인출가능금액요청",
  "kt00011": "증거금율별주문가능수량조회요청",
  "kt00012": "신용보증금율별주문가능수량조회요청",
  "kt00013": "증거금세부내역조회요청",
  "kt00015": "위탁종합거래내역요청",
  "kt00016": "일별계좌수익률상세현황요청",
  "kt00017": "계좌별당일현황요청",
  "kt00018": "계좌평가잔고내역요청",
  "kt10000": "주식 매수주문",
  "kt10001": "주식 매도주문",
  "kt10002": "주식 정정주문",
  "kt10003": "주식 취소주문",
  "kt10006": "신용 매수주문",
  "kt10007": "신용 매도주문",
  "kt10008": "신용 정정주문",
  "kt10009": "신용 취소주문",
  "kt20016": "신용융자 가능종목요청",
  "kt20017": "신용융자 가능문의",
  "kt50000": "금현물 매수주문",
  "kt50001": "금현물 매도주문",
  "kt50002": "금현물 정정주문",
  "kt50003": "금현물 취소주문",
  "kt50020": "금현물 잔고확인",
  "kt50021": "금현물 예수금",
  "kt50030": "금현물 주문체결전체조회",
  "kt50031": "금현물 주문체결조회",
  "kt50032": "금현물 거래내역조회",
  "kt50075": "금현물 미체결조회",
  "00": "주문체결",
  "04": "잔고",
  "0A": "주식기세",
  "0B": "주식체결",
  "0C": "주식우선호가",
  "0D": "주식호가잔량",
  "0E": "주식시간외호가",
  "0F": "주식당일거래원",
  "0G": "ETF NAV",
  "0H": "주식예상체결",
  "0I": "국제금환산가격",
  "0J": "업종지수",
  "0U": "업종등락",
  "0g": "주식종목정보",
  "0m": "ELW 이론가",
  "0s": "장시작시간",
  "0u": "ELW 지표",
  "0w": "종목프로그램매매",
  "1h": "VI발동/해제",
  "공통": "오류코드"
};

// 토큰 발급·갱신은 인프라 TokenProvider 가 config.json 의 oauth 스펙으로 처리한다.
// sysmod 는 env 로 주입된 raw 토큰(KIWOOM_ACCESS_TOKEN)을 받아쓰기만 한다 — 토큰 코드 0.

const RATE_LIMIT = 5;
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

async function callApi(base, token, apiId, params = {}, retry = 2) {
  const category = URL_CATEGORY[apiId];
  if (!category) throw new Error(`알 수 없는 API ID: ${apiId} — 이 값을 지어내지 마세요. search_module_actions(query) 로 맞는 액션을 찾고 get_action_schema('kiwoom', action) 으로 파라미터를 확인하세요. 단순 시세·차트·과거 데이터는 yfinance(action='history')가 더 쉽습니다.`);
  const url = `${base}/api/dostk/${category}`;
  await acquireSlot();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${token}`,
      'api-id': apiId,
      'cont-yn': 'N',
      'next-key': '',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, apiId, params, retry - 1);
  }
  if (!resp.ok) {
    // 키움은 토큰 만료 등 일부 오류를 HTTP 4xx/5xx + JSON 바디(return_code/return_msg)로 준다.
    // 바디가 키움 에러 envelope 면 throw 말고 반환 → 상위 return_code 검사(인프라 reactive)가 토큰 무효를 감지.
    const errText = await resp.text().catch(() => '');
    try {
      const j = JSON.parse(errText);
      if (j && (j.return_code !== undefined || j.return_msg !== undefined)) return j;
    } catch { /* JSON 아님 — 아래 throw */ }
    throw new Error(`키움 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }
  return await resp.json();
}

// Standard OHLCV normalization — rename Kiwoom candle vocabulary (dt/cntr_tm/open_pric/high_pric/
// low_pric/cur_prc/trde_qty) to the cross-broker standard {date, open, high, low, close, volume} so
// stock_chart dataCacheKey injection, the timeseries store, and cache_grep all speak one vocabulary
// (yfinance already does). Field-signature detection (a row carrying a date field together with
// open_pric) — no per-action enum, so every chart/daily-price API normalizes uniformly.
// Values arrive as strings, sometimes signed ("+68000") — strip the sign (prices/volumes are absolute).
function kiwoomNum(v) {
  const n = Number(String(v ?? '').replace(/^[+\-]/, ''));
  return Number.isFinite(n) ? n : v;
}
function kiwoomDate(s) {
  s = String(s ?? '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{12,14}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12);
  return s;
}
const CANDLE_FIELD_MAP = [
  ['dt', 'date'], ['cntr_tm', 'date'],
  ['open_pric', 'open'], ['high_pric', 'high'], ['low_pric', 'low'],
  ['cur_prc', 'close'], ['trde_qty', 'volume'],
];
function normalizeCandleRows(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const row of v) {
        if (!row || typeof row !== 'object') continue;
        if (!(('dt' in row || 'cntr_tm' in row) && 'open_pric' in row)) continue;
        for (const [src, dst] of CANDLE_FIELD_MAP) {
          if (src in row) {
            row[dst] = dst === 'date' ? kiwoomDate(row[src]) : kiwoomNum(row[src]);
            if (src !== dst) delete row[src];
          }
        }
      }
    } else if (v && typeof v === 'object') {
      normalizeCandleRows(v, depth + 1);
    }
  }
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 키움 API ID (ka10001 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom 에서 등록하세요.' }));
      return;
    }
    // 토큰 = 인프라(TokenProvider)가 발급·선제갱신해 env 로 주입한 raw 토큰. 무효 시엔 인프라가
    // 응답의 return_code/return_msg 를 보고 재발급 후 1회 재시도하므로, sysmod 는 받아쓰기만 한다 (토큰 코드 0).
    const token = process.env['KIWOOM_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: '키움 접근 토큰 미발급 — 인프라 토큰 발급 실패 또는 앱키 미설정.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    const params = data.params || {};
    const result = await callApi(base, token, action, params);
    normalizeCandleRows(result);
    // 키움 API 자체 오류(return_code≠0)는 HTTP 200 이라 envelope success:true 로 가려졌었음 →
    // AI 가 실패를 못 알아채고 빈/거짓 데이터로 진행(fabricate). return_code 있으면 0 만 성공.
    const rc = result?.return_code;
    const ok = rc === undefined || rc === null || rc === 0;
    const output = { success: ok, data: { apiId: action, name: API_NAMES[action], ...result } };
    if (!ok) output.error = result?.return_msg || `키움 API 오류 (return_code=${rc})`;
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

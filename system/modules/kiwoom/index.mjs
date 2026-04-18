/**
 * Firebat System Module: kiwoom (stock-trading)
 * 키움증권 REST API — 전체 API 지원 (200개+)
 *
 * API 문서: https://openapi.kiwoom.com
 * 인증: appkey + secretkey → OAuth access_token
 * 구조: POST /api/dostk/{category} + apiId 파라미터
 *
 * 편의 액션 → apiId 자동 매핑, 또는 apiId 직접 호출
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// ─── API ID → URL 카테고리 매핑 ───
const API_CATEGORY = {
  // 계좌
  acnt: ['ka00001', 'ka01690', 'ka10072', 'ka10073', 'ka10074', 'ka10075', 'ka10076', 'ka10077', 'ka10085', 'ka10088', 'ka10170', 'kt00001', 'kt00002', 'kt00003', 'kt00004', 'kt00005', 'kt00007', 'kt00008', 'kt00009', 'kt00010', 'kt00011', 'kt00012', 'kt00013', 'kt00015', 'kt00016', 'kt00017', 'kt00018', 'kt50020', 'kt50021', 'kt50030', 'kt50031', 'kt50032', 'kt50075'],
  // 시세
  mrkcond: ['ka10004', 'ka10005', 'ka10006', 'ka10007', 'ka10011', 'ka10044', 'ka10045', 'ka10046', 'ka10047', 'ka10063', 'ka10066', 'ka10078', 'ka10086', 'ka10087', 'ka50010', 'ka50012', 'ka50087', 'ka50100', 'ka50101', 'ka90005', 'ka90006', 'ka90007', 'ka90008', 'ka90010', 'ka90013'],
  // 종목정보
  stkinfo: ['ka00198', 'ka10001', 'ka10002', 'ka10003', 'ka10013', 'ka10015', 'ka10016', 'ka10017', 'ka10018', 'ka10019', 'ka10024', 'ka10025', 'ka10026', 'ka10028', 'ka10043', 'ka10052', 'ka10054', 'ka10055', 'ka10058', 'ka10059', 'ka10061', 'ka10084', 'ka10095', 'ka10099', 'ka10100', 'ka10101', 'ka10102', 'ka90003', 'ka90004', 'kt20016', 'kt20017'],
  // 순위정보
  rkinfo: ['ka10020', 'ka10021', 'ka10022', 'ka10023', 'ka10027', 'ka10029', 'ka10030', 'ka10031', 'ka10032', 'ka10033', 'ka10034', 'ka10035', 'ka10036', 'ka10037', 'ka10038', 'ka10039', 'ka10040', 'ka10042', 'ka10053', 'ka10062', 'ka10065', 'ka10098', 'ka90009'],
  // 주문
  ordr: ['kt10000', 'kt10001', 'kt10002', 'kt10003', 'kt50000', 'kt50001', 'kt50002', 'kt50003'],
  // 차트
  chart: ['ka10060', 'ka10064', 'ka10079', 'ka10080', 'ka10081', 'ka10082', 'ka10083', 'ka10094', 'ka20004', 'ka20005', 'ka20006', 'ka20007', 'ka20008', 'ka20019', 'ka50079', 'ka50080', 'ka50081', 'ka50082', 'ka50083', 'ka50091', 'ka50092'],
  // 기관/외국인
  frgnistt: ['ka10008', 'ka10009', 'ka10131', 'ka52301'],
  // 업종
  sect: ['ka10010', 'ka10051', 'ka20001', 'ka20002', 'ka20003', 'ka20009'],
  // 공매도
  shsa: ['ka10014'],
  // 대차거래
  slb: ['ka10068', 'ka10069', 'ka10105', 'ka10106', 'ka20068', 'ka90012'],
  // 테마
  thme: ['ka90001', 'ka90002'],
  // ELW
  elw: ['ka10048', 'ka10050', 'ka30001', 'ka30002', 'ka30003', 'ka30004', 'ka30005', 'ka30009', 'ka30010', 'ka30011', 'ka30012'],
  // ETF
  etf: ['ka40001', 'ka40002', 'ka40003', 'ka40004', 'ka40006', 'ka40007', 'ka40008', 'ka40009', 'ka40010'],
  // 신용주문
  crdordr: ['kt10006', 'kt10007', 'kt10008', 'kt10009'],
  // 조건검색
  websocket: ['ka10171', 'ka10172', 'ka10173', 'ka10174'],
};

// 역매핑: apiId → category
const ID_TO_CATEGORY = {};
for (const [cat, ids] of Object.entries(API_CATEGORY)) {
  for (const id of ids) ID_TO_CATEGORY[id] = cat;
}

// ─── 편의 액션 → apiId 매핑 ───
const ACTION_MAP = {
  // 시세
  'price':          'ka10001',  // 주식기본정보요청
  'quote':          'ka10004',  // 주식호가요청
  'daily-price':    'ka10086',  // 일별주가요청
  'tick-data':      'ka10005',  // 주식일주월시분요청
  'time-price':     'ka10006',  // 주식시분요청
  'after-hours':    'ka10087',  // 시간외단일가요청
  // 차트
  'chart-tick':     'ka10079',  // 주식틱차트
  'chart-minute':   'ka10080',  // 주식분봉차트
  'chart-daily':    'ka10081',  // 주식일봉차트
  'chart-weekly':   'ka10082',  // 주식주봉차트
  'chart-monthly':  'ka10083',  // 주식월봉차트
  'chart-yearly':   'ka10094',  // 주식년봉차트
  // 주문
  'order-buy':      'kt10000',  // 주식 매수주문
  'order-sell':     'kt10001',  // 주식 매도주문
  'order-modify':   'kt10002',  // 주식 정정주문
  'order-cancel':   'kt10003',  // 주식 취소주문
  // 신용주문
  'credit-buy':     'kt10006',
  'credit-sell':    'kt10007',
  'credit-modify':  'kt10008',
  'credit-cancel':  'kt10009',
  // 금현물 주문
  'gold-buy':       'kt50000',
  'gold-sell':      'kt50001',
  'gold-modify':    'kt50002',
  'gold-cancel':    'kt50003',
  // 계좌
  'account':        'ka00001',  // 계좌번호조회
  'balance':        'kt00018',  // 계좌평가잔고내역요청
  'deposit':        'kt00001',  // 예수금상세현황요청
  'asset':          'kt00003',  // 추정자산조회요청
  'evaluation':     'kt00004',  // 계좌평가현황요청
  'unsettled':      'ka10075',  // 미체결요청
  'settled':        'ka10076',  // 체결요청
  'daily-pnl':      'ka01690',  // 일별잔고수익률
  'realized-pnl':   'ka10074',  // 일자별실현손익요청
  'today-pnl':      'ka10077',  // 당일실현손익상세요청
  'trade-log':      'ka10170',  // 당일매매일지요청
  'account-yield':  'ka10085',  // 계좌수익률요청
  // 종목정보
  'stock-info':     'ka10001',  // 주식기본정보요청
  'trade-broker':   'ka10002',  // 주식거래원요청
  'execution':      'ka10003',  // 체결정보요청
  'credit-trend':   'ka10013',  // 신용매매동향요청
  'trade-detail':   'ka10015',  // 일별거래상세요청
  'stock-list':     'ka10099',  // 종목정보 리스트
  'stock-detail':   'ka10100',  // 종목정보 조회
  'sector-list':    'ka10101',  // 업종코드 리스트
  'broker-list':    'ka10102',  // 회원사 리스트
  // 순위
  'ranking-volume':     'ka10030', // 당일거래량상위
  'ranking-amount':     'ka10032', // 거래대금상위
  'ranking-change':     'ka10027', // 전일대비등락률상위
  'ranking-foreign':    'ka10034', // 외인기간별매매상위
  'ranking-broker':     'ka10038', // 종목별증권사순위
  'ranking-volume-surge': 'ka10023', // 거래량급증
  // 기관/외국인
  'foreign-trade':  'ka10008',  // 주식외국인종목별매매동향
  'institution':    'ka10009',  // 주식기관요청
  // 공매도
  'short-selling':  'ka10014',  // 공매도추이요청
  // 대차거래
  'lending-trend':  'ka10068',  // 대차거래추이요청
  // 테마
  'theme-list':     'ka90001',  // 테마그룹별요청
  'theme-stocks':   'ka90002',  // 테마구성종목요청
  // 프로그램매매
  'program-top50':  'ka90003',  // 프로그램순매수상위50
  // 업종
  'sector-investor': 'ka10051', // 업종별투자자순매수
  // ETF
  'etf-yield':      'ka40001',
  'etf-info':       'ka40002',
  'etf-daily':      'ka40003',
  'etf-all':        'ka40004',
  // 금현물
  'gold-price':     'ka50100',  // 금현물 시세정보
  'gold-quote':     'ka50101',  // 금현물 호가
  'gold-balance':   'kt50020',  // 금현물 잔고확인
  'gold-deposit':   'kt50021',  // 금현물 예수금
  'gold-ccld':      'kt50030',  // 금현물 주문체결전체조회
  'gold-detail':    'kt50031',  // 금현물 주문체결조회
  'gold-history':   'kt50032',  // 금현물 거래내역조회
  'gold-unsettled': 'kt50075',  // 금현물 미체결조회
  'gold-tick-chart':'ka50079',  // 금현물 틱차트
  'gold-minute-chart':'ka50080',// 금현물 분봉차트
  'gold-daily-chart':'ka50081', // 금현물 일봉차트
  'gold-ccnl':     'ka50010',  // 금현물 체결추이
  'gold-daily-trend':'ka50012', // 금현물 일별추이
  'gold-investor':  'ka52301',  // 금현물 투자자현황
  // 업종
  'sector-price':   'ka20001',  // 업종현재가
  'sector-stocks':  'ka20002',  // 업종별주가
  'sector-all':     'ka20003',  // 전업종지수
  'sector-daily':   'ka20009',  // 업종현재가일별
  'sector-tick-chart':'ka20004',// 업종틱차트
  'sector-minute-chart':'ka20005',// 업종분봉차트
  'sector-daily-chart':'ka20006',// 업종일봉차트
  'sector-weekly-chart':'ka20007',// 업종주봉차트
  'sector-monthly-chart':'ka20008',// 업종월봉차트
  'sector-yearly-chart':'ka20019',// 업종년봉차트
  // 추가 계좌
  'daily-deposit':  'kt00002',  // 일별추정예탁자산현황
  'ccld-balance':   'kt00005',  // 체결잔고
  'ccld-detail':    'kt00007',  // 계좌별주문체결내역상세
  'next-settle':    'kt00008',  // 계좌별익일결제예정내역
  'ccld-status':    'kt00009',  // 계좌별주문체결현황
  'withdraw-limit': 'kt00010',  // 주문인출가능금액
  'margin-qty':     'kt00011',  // 증거금율별주문가능수량조회
  'credit-margin':  'kt00012',  // 신용보증금율별주문가능수량조회
  'margin-detail':  'kt00013',  // 증거금세부내역조회
  'trade-history':  'kt00015',  // 위탁종합거래내역
  'daily-yield':    'kt00016',  // 일별계좌수익률상세현황
  'daily-status':   'kt00017',  // 계좌별당일현황
  // 추가 종목정보
  'realtime-rank':  'ka00198',  // 실시간종목조회순위
  'high-low':       'ka10016',  // 신고저가
  'limit-price':    'ka10017',  // 상하한가
  'near-highlow':   'ka10018',  // 고저가근접
  'price-surge':    'ka10019',  // 가격급등락
  'volume-renew':   'ka10024',  // 거래량갱신
  'price-cluster':  'ka10025',  // 매물대집중
  'per-range':      'ka10026',  // 고저PER
  'open-change':    'ka10028',  // 시가대비등락률
  'vi-trigger':     'ka10054',  // 변동성완화장치발동종목
  'today-volume':   'ka10055',  // 당일전일체결량
  // 추가 순위정보
  'ranking-quote':      'ka10020', // 호가잔량상위
  'ranking-quote-surge':'ka10021', // 호가잔량급증
  'ranking-ratio-surge':'ka10022', // 잔량율급증
  'ranking-prev-vol':   'ka10031', // 전일거래량상위
  'ranking-credit-ratio':'ka10033',// 신용비율상위
  'ranking-foreign-cont':'ka10035',// 외인연속순매매상위
  'ranking-foreign-limit':'ka10036',// 외인한도소진율증가상위
  'ranking-foreign-window':'ka10037',// 외국계창구매매상위
  'ranking-broker-trade':'ka10039', // 증권사별매매상위
  'ranking-today-broker':'ka10040', // 당일주요거래원
  'ranking-net-broker':  'ka10042', // 순매수거래원순위
  'ranking-overtime':    'ka10098', // 시간외단일가등락율순위
  'ranking-foreign-inst':'ka90009', // 외국인기관매매상위
  // 추가 분석
  'inst-daily':     'ka10044',  // 일별기관매매종목
  'inst-trend':     'ka10045',  // 종목별기관매매추이
  'strength-time':  'ka10046',  // 체결강도추이시간별
  'strength-daily': 'ka10047',  // 체결강도추이일별
  'broker-trend':   'ka10078',  // 증권사별종목매매동향
  'investor-by-stock':'ka10058',// 투자자별일별매매종목
  'inst-by-stock':  'ka10059',  // 종목별투자자기관별
  'inst-total':     'ka10061',  // 종목별투자자기관별합계
  'same-net':       'ka10062',  // 동일순매매순위
  'intraday-inv':   'ka10063',  // 장중투자자별매매
  'afterclose-inv': 'ka10066',  // 장마감후투자자별매매
  'inst-cont':      'ka10131',  // 기관외국인연속매매현황
  'program-time':   'ka90005',  // 프로그램매매추이시간대별
  'program-arb':    'ka90006',  // 프로그램매매차익잔고추이
  'program-cum':    'ka90007',  // 프로그램매매누적추이
  'program-by-stock':'ka90008', // 종목시간별프로그램매매추이
  'program-daily':  'ka90010',  // 프로그램매매추이일자별
  'program-by-stock-daily':'ka90013',// 종목일별프로그램매매추이
  'program-by-stock-info':'ka90004', // 종목별프로그램매매현황
  // 대차거래
  'lending-top10':  'ka10069',  // 대차거래상위10종목
  'lending-by-stock':'ka20068', // 대차거래추이(종목별)
  'lending-detail': 'ka90012',  // 대차거래내역
  // 조건검색
  'cond-list':      'ka10171',  // 조건검색 목록조회
  'cond-search':    'ka10172',  // 조건검색 요청 일반
  'cond-realtime':  'ka10173',  // 조건검색 요청 실시간
  'cond-cancel':    'ka10174',  // 조건검색 실시간 해제
  // 신용
  'credit-avail':   'kt20016',  // 신용융자 가능종목
  'credit-inquiry': 'kt20017',  // 신용융자 가능문의
};

/**
 * AI가 action 이름을 변형해 보내는 케이스를 정규화.
 * 1) 정확 매칭
 * 2) 카멜/언더스코어/공백 → 케밥
 * 3) 2단어 하이픈 리버스 (daily-chart ↔ chart-daily)
 * 4) 서브스트링 포함 매칭 (price-chart-daily 안에 chart-daily)
 * 5) Jaccard 토큰 오버랩 ≥ 0.5 폴백
 */
function normalizeAction(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const kebab = raw
    .replace(/[_\s]+/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .trim();
  if (ACTION_MAP[kebab]) return kebab;

  const parts = kebab.split('-');
  if (parts.length === 2) {
    const reversed = `${parts[1]}-${parts[0]}`;
    if (ACTION_MAP[reversed]) return reversed;
  }

  // 서브스트링 포함 — 긴 키부터 검사 (chart-daily 가 chart보다 먼저 매칭되도록)
  const keys = Object.keys(ACTION_MAP).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (key.length >= 4 && kebab.includes(key)) return key;
  }

  // Jaccard 토큰 오버랩 폴백
  const tokens = new Set(parts);
  let bestKey = null;
  let bestScore = 0;
  for (const key of keys) {
    const keyTokens = new Set(key.split('-'));
    const inter = [...tokens].filter(t => keyTokens.has(t)).length;
    const uni = new Set([...tokens, ...keyTokens]).size;
    const jac = uni > 0 ? inter / uni : 0;
    if (jac > bestScore) {
      bestScore = jac;
      bestKey = key;
    }
  }
  if (bestKey && bestScore >= 0.5) return bestKey;

  return kebab;
}

/** OAuth 토큰 발급 (Vault 캐싱 — config.json tokenCache 기반) */
async function getAccessToken(base, appKey, appSecret, forceNew = false) {
  // Vault에서 캐시된 토큰 (sandbox가 만료 체크 후 env 주입)
  if (!forceNew) {
    const cached = process.env['KIWOOM_ACCESS_TOKEN'];
    if (cached) return { token: cached, isNew: false };
  }

  const resp = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      secretkey: appSecret,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`토큰 발급 실패: ${resp.status}`);
  const json = await resp.json();
  if (!json.token) throw new Error(`토큰 응답 오류: ${JSON.stringify(json)}`);

  return { token: json.token, isNew: true };
}

// ── Rate Limit (초당 5회 제한, 키움) ─────────────────────────────────────
// 프로세스 레벨 토큰 버킷 — 1초 단위 윈도우 내 5회까지 허용
const RATE_LIMIT = 5;
const WINDOW_MS = 1000;
const _reqTimes = [];

async function acquireSlot() {
  while (true) {
    const now = Date.now();
    // 1초 지난 요청 제거
    while (_reqTimes.length > 0 && now - _reqTimes[0] >= WINDOW_MS) _reqTimes.shift();
    if (_reqTimes.length < RATE_LIMIT) {
      _reqTimes.push(now);
      return;
    }
    // 슬롯이 비기까지 대기
    const waitMs = WINDOW_MS - (now - _reqTimes[0]) + 5;
    await new Promise(r => setTimeout(r, waitMs));
  }
}

/** API 호출 — 자동 throttle + 429 재시도 (최대 2회, 1초 간격) */
async function callApi(base, token, apiId, params = {}, retry = 2) {
  const category = ID_TO_CATEGORY[apiId];
  if (!category) throw new Error(`알 수 없는 API ID: ${apiId}. 지원되는 API 목록은 키움 REST API 문서를 참고하세요.`);

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

  // 429: rate limit 초과 → 1초 대기 후 재시도
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, apiId, params, retry - 1);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`키움 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }

  return await resp.json();
}

/** 오늘 날짜 YYYYMMDD */
function today() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
/** N일 전 날짜 YYYYMMDD */
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10).replace(/-/g,''); }

/** 편의 액션의 기본 파라미터 생성 — 엑셀 Required 필드 기반 디폴트 */
function buildParams(action, data) {
  const p = data.params || {};

  // 종목코드
  if (data.symbol) p.stk_cd = p.stk_cd || data.symbol;

  // 주문 파라미터 (order-*, credit-*, gold-*)
  if (action.startsWith('order-') || action.startsWith('credit-') || action.startsWith('gold-')) {
    if (data.quantity) p.ord_qty = p.ord_qty || String(data.quantity);
    if (data.price !== undefined) p.ord_prc = p.ord_prc || String(data.price);
    if (data.orderNo) {
      p.orig_ord_no = p.orig_ord_no || data.orderNo;
      p.orgn_ord_no = p.orgn_ord_no || data.orderNo;
    }
  }

  // 차트 건수
  if (action.startsWith('chart-') || (action.startsWith('sector-') && action.includes('chart'))
      || (action.startsWith('gold-') && action.includes('chart'))) {
    p.cnt = p.cnt || String(data.count || 30);
  }

  // ─── 액션별 Required 파라미터 디폴트 (엑셀 기반) ───
  switch (action) {
    // ── 시세/종목정보 ──
    case 'realtime-rank': // 실시간종목조회순위 (ka00198)
      p.qry_tp = p.qry_tp || '4'; // 4=당일누적
      break;
    case 'daily-price': // 일별주가요청 (ka10086)
      p.qry_dt = p.qry_dt || today();
      p.indc_tp = p.indc_tp || '0'; // 0=수량
      break;
    case 'credit-trend': // 신용매매동향요청 (ka10013)
      p.dt = p.dt || '1';
      p.qry_tp = p.qry_tp || '1';
      break;
    case 'short-selling': // 공매도추이요청 (ka10014)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      break;
    case 'trade-detail': // 일별거래상세요청 (ka10015)
      p.strt_dt = p.strt_dt || daysAgo(30);
      break;
    case 'high-low': // 신고저가요청 (ka10016)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.ntl_tp = p.ntl_tp || '0';
      p.high_low_close_tp = p.high_low_close_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.updown_incls = p.updown_incls || '1';
      p.dt = p.dt || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'limit-price': // 상하한가요청 (ka10017)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.updown_tp = p.updown_tp || '0';
      p.sort_tp = p.sort_tp || '1';
      p.stk_cnd = p.stk_cnd || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.trde_gold_tp = p.trde_gold_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'near-highlow': // 고저가근접요청 (ka10018)
      p.high_low_tp = p.high_low_tp || '1';
      p.alacc_rt = p.alacc_rt || '5';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'price-surge': // 가격급등락요청 (ka10019)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.flu_tp = p.flu_tp || '1';
      p.tm_tp = p.tm_tp || '0';
      p.tm = p.tm || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.pric_cnd = p.pric_cnd || '0';
      p.updown_incls = p.updown_incls || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'volume-renew': // 거래량갱신요청 (ka10024)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.cycle_tp = p.cycle_tp || '1';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'price-cluster': // 매물대집중요청 (ka10025)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.prps_cnctr_rt = p.prps_cnctr_rt || '10';
      p.cur_prc_entry = p.cur_prc_entry || '0';
      p.prpscnt = p.prpscnt || '5';
      p.cycle_tp = p.cycle_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'per-range': // 고저PER요청 (ka10026)
      p.pertp = p.pertp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'open-change': // 시가대비등락률요청 (ka10028)
      p.sort_tp = p.sort_tp || '1';
      p.trde_qty_cnd = p.trde_qty_cnd || '0';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.updown_incls = p.updown_incls || '1';
      p.stk_cnd = p.stk_cnd || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.trde_prica_cnd = p.trde_prica_cnd || '0';
      p.flu_cnd = p.flu_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'vi-trigger': // 변동성완화장치발동종목요청 (ka10054)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.bf_mkrt_tp = p.bf_mkrt_tp || '0';
      p.motn_tp = p.motn_tp || '0';
      p.skip_stk = p.skip_stk || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.min_trde_qty = p.min_trde_qty || '0';
      p.max_trde_qty = p.max_trde_qty || '0';
      p.trde_prica_tp = p.trde_prica_tp || '0';
      p.min_trde_prica = p.min_trde_prica || '0';
      p.max_trde_prica = p.max_trde_prica || '0';
      p.motn_drc = p.motn_drc || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'today-volume': // 당일전일체결량요청 (ka10055)
      p.tdy_pred = p.tdy_pred || '0';
      break;
    case 'stock-list': // 종목정보 리스트 (ka10099)
      p.mrkt_tp = p.mrkt_tp || '0';
      break;
    case 'sector-list': // 업종코드 리스트 (ka10101)
      p.mrkt_tp = p.mrkt_tp || '0';
      break;

    // ── 순위 ──
    case 'ranking-quote': // 호가잔량상위요청 (ka10020)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.sort_tp = p.sort_tp || '1';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-quote-surge': // 호가잔량급증요청 (ka10021)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      p.sort_tp = p.sort_tp || '1';
      p.tm_tp = p.tm_tp || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-ratio-surge': // 잔량율급증요청 (ka10022)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.rt_tp = p.rt_tp || '1';
      p.tm_tp = p.tm_tp || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-volume-surge': // 거래량급증요청 (ka10023)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.sort_tp = p.sort_tp || '1';
      p.tm_tp = p.tm_tp || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.pric_tp = p.pric_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-change': // 전일대비등락률상위요청 (ka10027)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.sort_tp = p.sort_tp || '1';
      p.trde_qty_cnd = p.trde_qty_cnd || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.updown_incls = p.updown_incls || '1';
      p.pric_cnd = p.pric_cnd || '0';
      p.trde_prica_cnd = p.trde_prica_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-volume': // 당일거래량상위요청 (ka10030)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.sort_tp = p.sort_tp || '1';
      p.mang_stk_incls = p.mang_stk_incls || '1';
      p.crd_tp = p.crd_tp || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.pric_tp = p.pric_tp || '0';
      p.trde_prica_tp = p.trde_prica_tp || '0';
      p.mrkt_open_tp = p.mrkt_open_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-prev-vol': // 전일거래량상위요청 (ka10031)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.qry_tp = p.qry_tp || '1';
      p.rank_strt = p.rank_strt || '1';
      p.rank_end = p.rank_end || '50';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-amount': // 거래대금상위요청 (ka10032)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.mang_stk_incls = p.mang_stk_incls || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-credit-ratio': // 신용비율상위요청 (ka10033)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.stk_cnd = p.stk_cnd || '0';
      p.updown_incls = p.updown_incls || '1';
      p.crd_cnd = p.crd_cnd || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-foreign': // 외인기간별매매상위요청 (ka10034)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      p.dt = p.dt || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-foreign-cont': // 외인연속순매매상위요청 (ka10035)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      p.base_dt_tp = p.base_dt_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-foreign-limit': // 외인한도소진율증가상위 (ka10036)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.dt = p.dt || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-foreign-window': // 외국계창구매매상위요청 (ka10037)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.dt = p.dt || '1';
      p.trde_tp = p.trde_tp || '1';
      p.sort_tp = p.sort_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-broker': // 종목별증권사순위요청 (ka10038)
      p.qry_tp = p.qry_tp || '1';
      break;
    case 'ranking-broker-trade': // 증권사별매매상위요청 (ka10039)
      p.trde_qty_tp = p.trde_qty_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      p.dt = p.dt || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'ranking-net-broker': // 순매수거래원순위요청 (ka10042)
      p.qry_dt_tp = p.qry_dt_tp || '1';
      p.pot_tp = p.pot_tp || '1';
      p.sort_base = p.sort_base || '1';
      break;
    case 'ranking-overtime': // 시간외단일가등락율순위요청 (ka10098)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.sort_base = p.sort_base || '1';
      p.stk_cnd = p.stk_cnd || '0';
      p.trde_qty_cnd = p.trde_qty_cnd || '0';
      p.crd_cnd = p.crd_cnd || '0';
      p.trde_prica = p.trde_prica || '0';
      break;
    case 'ranking-foreign-inst': // 외국인기관매매상위요청 (ka90009)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.qry_dt_tp = p.qry_dt_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;

    // ── 차트 ──
    case 'chart-tick': // 주식틱차트 (ka10079)
      p.tic_scope = p.tic_scope || '1';
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'chart-minute': // 주식분봉차트 (ka10080)
      p.tic_scope = p.tic_scope || '1';
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'chart-daily': // 주식일봉차트 (ka10081)
      p.base_dt = p.base_dt || today();
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'chart-weekly': // 주식주봉차트 (ka10082)
      p.base_dt = p.base_dt || today();
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'chart-monthly': // 주식월봉차트 (ka10083)
      p.base_dt = p.base_dt || today();
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'chart-yearly': // 주식년봉차트 (ka10094)
      p.base_dt = p.base_dt || today();
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;

    // ── 기관/외국인 ──
    case 'inst-daily': // 일별기관매매종목요청 (ka10044)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      p.trde_tp = p.trde_tp || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'inst-trend': // 종목별기관매매추이요청 (ka10045)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      p.orgn_prsm_unp_tp = p.orgn_prsm_unp_tp || '1';
      p.for_prsm_unp_tp = p.for_prsm_unp_tp || '1';
      break;
    case 'sector-investor': // 업종별투자자순매수요청 (ka10051)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'investor-by-stock': // 투자자별일별매매종목요청 (ka10058)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      p.trde_tp = p.trde_tp || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.invsr_tp = p.invsr_tp || '9000';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'inst-by-stock': // 종목별투자자기관별요청 (ka10059)
      p.dt = p.dt || '1';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.trde_tp = p.trde_tp || '1';
      p.unit_tp = p.unit_tp || '1';
      break;
    case 'inst-total': // 종목별투자자기관별합계요청 (ka10061)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.trde_tp = p.trde_tp || '1';
      p.unit_tp = p.unit_tp || '1';
      break;
    case 'same-net': // 동일순매매순위요청 (ka10062)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.mrkt_tp = p.mrkt_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      p.sort_cnd = p.sort_cnd || '1';
      p.unit_tp = p.unit_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'intraday-inv': // 장중투자자별매매요청 (ka10063)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.invsr = p.invsr || '0';
      p.frgn_all = p.frgn_all || '0';
      p.smtm_netprps_tp = p.smtm_netprps_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'afterclose-inv': // 장마감후투자자별매매요청 (ka10066)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.trde_tp = p.trde_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'inst-cont': // 기관외국인연속매매현황요청 (ka10131)
      p.dt = p.dt || today();
      p.mrkt_tp = p.mrkt_tp || '0';
      p.netslmt_tp = p.netslmt_tp || '1';
      p.stk_inds_tp = p.stk_inds_tp || '1';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'broker-trend': // 증권사별종목매매동향요청 (ka10078)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      break;

    // ── 프로그램매매 ──
    case 'program-top50': // 프로그램순매수상위50 (ka90003)
      p.trde_upper_tp = p.trde_upper_tp || '1';
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'program-by-stock-info': // 종목별프로그램매매현황 (ka90004)
      p.dt = p.dt || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'program-time': // 프로그램매매추이 시간대별 (ka90005)
      p.date = p.date || today();
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.min_tic_tp = p.min_tic_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'program-arb': // 차익잔고추이 (ka90006)
      p.date = p.date || today();
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'program-cum': // 누적추이 (ka90007)
      p.date = p.date || today();
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'program-by-stock': // 종목시간별 (ka90008)
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.date = p.date || today();
      break;
    case 'program-daily': // 일자별 (ka90010)
      p.date = p.date || today();
      p.amt_qty_tp = p.amt_qty_tp || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.min_tic_tp = p.min_tic_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;

    // ── 공매도/대차거래 ──
    case 'lending-trend': // 대차거래추이 (ka10068)
      p.all_tp = p.all_tp || '0';
      break;
    case 'lending-top10': // 대차거래상위10종목 (ka10069)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.mrkt_tp = p.mrkt_tp || '0';
      break;
    case 'lending-detail': // 대차거래내역 (ka90012)
      p.dt = p.dt || '1';
      p.mrkt_tp = p.mrkt_tp || '0';
      break;

    // ── 업종 ──
    case 'sector-price': // 업종현재가 (ka20001)
      p.mrkt_tp = p.mrkt_tp || '0';
      break;
    case 'sector-stocks': // 업종별주가 (ka20002)
      p.mrkt_tp = p.mrkt_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'sector-daily': // 업종현재가일별 (ka20009)
      p.mrkt_tp = p.mrkt_tp || '0';
      break;
    case 'sector-tick-chart': // 업종틱차트 (ka20004)
      p.tic_scope = p.tic_scope || '1';
      break;
    case 'sector-minute-chart': // 업종분봉 (ka20005)
      p.tic_scope = p.tic_scope || '1';
      break;
    case 'sector-daily-chart': // 업종일봉 (ka20006)
      p.base_dt = p.base_dt || today();
      break;
    case 'sector-weekly-chart': // 업종주봉 (ka20007)
      p.base_dt = p.base_dt || today();
      break;
    case 'sector-monthly-chart': // 업종월봉 (ka20008)
      p.base_dt = p.base_dt || today();
      break;
    case 'sector-yearly-chart': // 업종년봉 (ka20019)
      p.base_dt = p.base_dt || today();
      break;

    // ── ETF ──
    case 'etf-yield': // ETF수익율 (ka40001)
      p.dt = p.dt || '1';
      break;
    case 'etf-all': // ETF전체시세 (ka40004)
      p.txon_type = p.txon_type || '0';
      p.navpre = p.navpre || '0';
      p.mngmcomp = p.mngmcomp || '';
      p.txon_yn = p.txon_yn || '0';
      p.trace_idex = p.trace_idex || '';
      p.stex_tp = p.stex_tp || '0';
      break;

    // ── 금현물 ──
    case 'gold-daily-trend': // 금현물일별추이 (ka50012)
      p.base_dt = p.base_dt || today();
      break;
    case 'gold-tick-chart': // 금현물틱차트 (ka50079)
      p.tic_scope = p.tic_scope || '1';
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'gold-minute-chart': // 금현물분봉 (ka50080)
      p.tic_scope = p.tic_scope || '1';
      break;
    case 'gold-daily-chart': // 금현물일봉 (ka50081)
      p.base_dt = p.base_dt || today();
      p.upd_stkpc_tp = p.upd_stkpc_tp || '1';
      break;
    case 'gold-quote': // 금현물호가 (ka50101)
      p.tic_scope = p.tic_scope || '1';
      break;
    case 'gold-ccld': // 금현물 주문체결전체조회 (kt50030)
      p.ord_dt = p.ord_dt || today();
      p.mrkt_deal_tp = p.mrkt_deal_tp || '0';
      p.stk_bond_tp = p.stk_bond_tp || '0';
      p.slby_tp = p.slby_tp || '0';
      break;
    case 'gold-detail': // 금현물 주문체결조회 (kt50031)
      p.qry_tp = p.qry_tp || '1';
      p.stk_bond_tp = p.stk_bond_tp || '0';
      p.sell_tp = p.sell_tp || '0';
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'gold-unsettled': // 금현물 미체결조회 (kt50075)
      p.ord_dt = p.ord_dt || today();
      p.mrkt_deal_tp = p.mrkt_deal_tp || '0';
      p.stk_bond_tp = p.stk_bond_tp || '0';
      p.sell_tp = p.sell_tp || '0';
      break;

    // ── 테마 ──
    case 'theme-list': // 테마그룹별 (ka90001)
      p.qry_tp = p.qry_tp || '1';
      p.date_tp = p.date_tp || '1'; // 1일전
      p.flu_pl_amt_tp = p.flu_pl_amt_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'theme-stocks': // 테마구성종목 (ka90002)
      p.stex_tp = p.stex_tp || '0';
      break;

    // ── 계좌 ──
    case 'daily-pnl': // 일별잔고수익률 (ka01690)
      p.qry_dt = p.qry_dt || today();
      break;
    case 'realized-pnl': // 일자별실현손익요청 (ka10074)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      break;
    case 'unsettled': // 미체결요청 (ka10075)
      p.all_stk_tp = p.all_stk_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'settled': // 체결요청 (ka10076)
      p.qry_tp = p.qry_tp || '1';
      p.sell_tp = p.sell_tp || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'account-yield': // 계좌수익률요청 (ka10085)
      p.stex_tp = p.stex_tp || '0';
      break;
    case 'trade-log': // 당일매매일지요청 (ka10170)
      p.ottks_tp = p.ottks_tp || '0';
      p.ch_crd_tp = p.ch_crd_tp || '0';
      break;
    case 'deposit': // 예수금상세현황요청 (kt00001)
      p.qry_tp = p.qry_tp || '1';
      break;
    case 'daily-deposit': // 일별추정예탁자산현황 (kt00002)
      p.start_dt = p.start_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      break;
    case 'asset': // 추정자산조회요청 (kt00003)
      p.qry_tp = p.qry_tp || '1';
      break;
    case 'evaluation': // 계좌평가현황 (kt00004)
      p.qry_tp = p.qry_tp || '1';
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'ccld-balance': // 체결잔고 (kt00005)
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'ccld-detail': // 주문체결내역상세 (kt00007)
      p.qry_tp = p.qry_tp || '1';
      p.stk_bond_tp = p.stk_bond_tp || '0';
      p.sell_tp = p.sell_tp || '0';
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'ccld-status': // 주문체결현황 (kt00009)
      p.stk_bond_tp = p.stk_bond_tp || '0';
      p.mrkt_tp = p.mrkt_tp || '0';
      p.sell_tp = p.sell_tp || '0';
      p.qry_tp = p.qry_tp || '1';
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'withdraw-limit': // 주문인출가능금액 (kt00010)
      p.trde_tp = p.trde_tp || '1';
      p.uv = p.uv || '0';
      break;
    case 'trade-history': // 위탁종합거래내역 (kt00015)
      p.strt_dt = p.strt_dt || daysAgo(30);
      p.end_dt = p.end_dt || today();
      p.tp = p.tp || '0';
      p.gds_tp = p.gds_tp || '0';
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'daily-yield': // 일별계좌수익률상세 (kt00016)
      p.fr_dt = p.fr_dt || daysAgo(30);
      p.to_dt = p.to_dt || today();
      break;
    case 'balance': // 계좌평가잔고내역요청 (kt00018)
      p.qry_tp = p.qry_tp || '1';
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;

    // ── 주문 ──
    case 'order-buy': // 주식매수주문 (kt10000)
    case 'order-sell': // 주식매도주문 (kt10001)
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      p.trde_tp = p.trde_tp || '1'; // 1=지정가
      break;
    case 'order-modify': // 주식정정주문 (kt10002)
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'order-cancel': // 주식취소주문 (kt10003)
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'credit-buy': // 신용매수 (kt10006)
    case 'credit-sell': // 신용매도 (kt10007)
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      p.trde_tp = p.trde_tp || '1';
      if (action === 'credit-sell') p.crd_deal_tp = p.crd_deal_tp || '1';
      break;
    case 'credit-modify': // 신용정정 (kt10008)
    case 'credit-cancel': // 신용취소 (kt10009)
      p.dmst_stex_tp = p.dmst_stex_tp || '0';
      break;
    case 'gold-buy': // 금현물매수 (kt50000)
    case 'gold-sell': // 금현물매도 (kt50001)
      p.trde_tp = p.trde_tp || '1';
      break;

    // ── 기타 ──
    case 'credit-avail': // 신용융자 가능종목 (kt20016)
      p.mrkt_deal_tp = p.mrkt_deal_tp || '0';
      break;
    case 'cond-search': // 조건검색 일반 (ka10172)
    case 'cond-realtime': // 조건검색 실시간 (ka10173)
      p.search_type = p.search_type || '0';
      p.stex_tp = p.stex_tp || '0';
      break;
  }

  return p;
}

// ─── Main ───
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 편의 액션(price, balance 등) 또는 apiId(ka10001 등)를 지정하세요.' }));
      return;
    }

    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom에서 등록해주세요.' }));
      return;
    }

    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    let { token, isNew } = await getAccessToken(base, appKey, appSecret);

    // 편의 액션 → apiId 변환, 또는 직접 apiId 사용
    // AI가 어순 뒤집어 보내는 흔한 실수(daily-chart, weekly-chart 등)도 동일 apiId로 라우팅
    const normalizedAction = normalizeAction(action);
    const apiId = ACTION_MAP[normalizedAction] || normalizedAction;
    const params = buildParams(normalizedAction, data);

    let result = await callApi(base, token, apiId, params);

    // 토큰 무효 감지 (캐시된 토큰이 서버에서 무효화된 경우) — 강제 재발급 후 1회 재시도
    const isTokenInvalid = result?.return_code === 3 || /Token이 유효하지 않습니다|token.*invalid/i.test(result?.return_msg || '');
    if (isTokenInvalid && !isNew) {
      const fresh = await getAccessToken(base, appKey, appSecret, true);
      token = fresh.token;
      isNew = true;
      result = await callApi(base, token, apiId, params);
    }

    const output = {
      success: true,
      data: { apiId, action, ...result },
    };
    // 새 토큰 발급 시 Vault에 캐싱 요청 (TTL은 config.json tokenCache.ttlHours)
    if (isNew) output.__updateSecrets = { KIWOOM_ACCESS_TOKEN: token };
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

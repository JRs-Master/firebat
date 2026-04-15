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

/** OAuth 토큰 발급 */
async function getAccessToken(base, appKey, appSecret) {
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
  return json.token;
}

/** API 호출 */
async function callApi(base, token, apiId, params = {}) {
  const category = ID_TO_CATEGORY[apiId];
  if (!category) throw new Error(`알 수 없는 API ID: ${apiId}. 지원되는 API 목록은 키움 REST API 문서를 참고하세요.`);

  const url = `${base}/api/dostk/${category}`;

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

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`키움 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }

  return await resp.json();
}

/** 편의 액션의 기본 파라미터 생성 */
function buildParams(action, data) {
  const p = data.params || {};

  // 종목코드가 필요한 액션
  if (data.symbol) p.stk_cd = p.stk_cd || data.symbol;

  // 주문 파라미터
  if (action.startsWith('order-') || action.startsWith('credit-') || action.startsWith('gold-')) {
    if (data.quantity) p.ord_qty = p.ord_qty || String(data.quantity);
    if (data.price !== undefined) p.ord_prc = p.ord_prc || String(data.price);
    if (data.orderNo) p.orgn_ord_no = p.orgn_ord_no || data.orderNo;
  }

  // 차트 건수
  if (action.startsWith('chart-') && data.count) {
    p.cnt = p.cnt || String(data.count);
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
    const token = await getAccessToken(base, appKey, appSecret);

    // 편의 액션 → apiId 변환, 또는 직접 apiId 사용
    const apiId = ACTION_MAP[action] || action;
    const params = buildParams(action, data);

    const result = await callApi(base, token, apiId, params);

    console.log(JSON.stringify({
      success: true,
      data: { apiId, action, ...result },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

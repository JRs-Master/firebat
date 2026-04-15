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
  mrkcond: ['ka10004', 'ka10005', 'ka10006', 'ka10007', 'ka10011', 'ka10044', 'ka10045', 'ka10046', 'ka10047', 'ka10063', 'ka10066', 'ka10078', 'ka10086', 'ka10087', 'ka50010', 'ka50012', 'ka50087', 'ka50100', 'ka50101', 'ka90005', 'ka90006', 'ka90007', 'ka90008', 'ka90010', 'ka90013', 'ka52301'],
  // 종목정보
  stkinfo: ['ka00198', 'ka10001', 'ka10002', 'ka10003', 'ka10013', 'ka10015', 'ka10016', 'ka10017', 'ka10018', 'ka10019', 'ka10024', 'ka10025', 'ka10026', 'ka10028', 'ka10043', 'ka10052', 'ka10054', 'ka10055', 'ka10058', 'ka10059', 'ka10061', 'ka10084', 'ka10095', 'ka10099', 'ka10100', 'ka10101', 'ka10102', 'ka90003', 'ka90004', 'kt20016', 'kt20017'],
  // 순위정보
  rkinfo: ['ka10020', 'ka10021', 'ka10022', 'ka10023', 'ka10027', 'ka10029', 'ka10030', 'ka10031', 'ka10032', 'ka10033', 'ka10034', 'ka10035', 'ka10036', 'ka10037', 'ka10038', 'ka10039', 'ka10040', 'ka10042', 'ka10053', 'ka10062', 'ka10065', 'ka10098', 'ka90009'],
  // 주문
  ordr: ['kt10000', 'kt10001', 'kt10002', 'kt10003', 'kt50000', 'kt50001', 'kt50002', 'kt50003'],
  // 차트
  chart: ['ka10060', 'ka10064', 'ka10079', 'ka10080', 'ka10081', 'ka10082', 'ka10083', 'ka10094', 'ka50079', 'ka50080', 'ka50081', 'ka50082', 'ka50083', 'ka50091', 'ka50092'],
  // 기관/외국인
  frgnistt: ['ka10008', 'ka10009', 'ka10131'],
  // 업종
  sect: ['ka10010', 'ka10051'],
  // 공매도
  shsa: ['ka10014'],
  // 대차거래
  slb: ['ka10068', 'ka10069', 'ka10105', 'ka10106', 'ka90012'],
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
async function callApi(base, token, appKey, appSecret, apiId, params = {}) {
  const category = ID_TO_CATEGORY[apiId];
  if (!category) throw new Error(`알 수 없는 API ID: ${apiId}. 지원되는 API 목록은 키움 REST API 문서를 참고하세요.`);

  const url = `${base}/api/dostk/${category}`;
  const body = { apiId, ...params };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${token}`,
      'appkey': appKey,
      'secretkey': appSecret,
    },
    body: JSON.stringify(body),
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
    // 한국어/변형 액션명 → 영문 정규화
    const ALIAS = {
      '현재가': 'price', '주가': 'price', '시세': 'price', '주식현재가': 'price', '주식현재가시세': 'price', '주식시세': 'price',
      '호가': 'quote', '매수': 'order-buy', '매도': 'order-sell', '정정': 'order-modify', '취소': 'order-cancel',
      '잔고': 'balance', '계좌': 'account', '예수금': 'deposit',
      '일봉': 'chart-daily', '차트': 'chart-daily', '분봉': 'chart-minute',
      '거래량순위': 'ranking-volume', '거래량': 'ranking-volume',
    };
    const action = ALIAS[data?.action] || data?.action;
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

    const result = await callApi(base, token, appKey, appSecret, apiId, params);

    console.log(JSON.stringify({
      success: true,
      data: { apiId, action, ...result },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

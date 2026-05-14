#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom-account
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kiwoom.json 입력.
 *
 * 키움증권 계좌 (잔고·예수금·자산·수익률·체결·미체결·매매일지)
 * 33개 API. action = API ID 직접 호출 + params 가 request body.
 *
 * 옛 sysmod_kiwoom (151 actions) 의 도메인별 분리 — OAuth + callApi + throttle 자체 inline.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 카테고리 (POST /api/dostk/{category} + apiId 헤더)
const URL_CATEGORY = {
  "ka00001": "acnt",
  "ka01690": "acnt",
  "ka10072": "acnt",
  "ka10073": "acnt",
  "ka10074": "acnt",
  "ka10075": "acnt",
  "ka10076": "acnt",
  "ka10077": "acnt",
  "ka10085": "acnt",
  "ka10088": "acnt",
  "ka10170": "acnt",
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
  "kt50020": "acnt",
  "kt50021": "acnt",
  "kt50030": "acnt",
  "kt50031": "acnt",
  "kt50032": "acnt",
  "kt50075": "acnt"
};
// API ID → 한글명 (에러 메시지 용)
const API_NAMES = {
  "ka00001": "계좌번호조회",
  "ka01690": "일별잔고수익률",
  "ka10072": "일자별종목별실현손익요청_일자",
  "ka10073": "일자별종목별실현손익요청_기간",
  "ka10074": "일자별실현손익요청",
  "ka10075": "미체결요청",
  "ka10076": "체결요청",
  "ka10077": "당일실현손익상세요청",
  "ka10085": "계좌수익률요청",
  "ka10088": "미체결 분할주문 상세",
  "ka10170": "당일매매일지요청",
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
  "kt50020": "금현물 잔고확인",
  "kt50021": "금현물 예수금",
  "kt50030": "금현물 주문체결전체조회",
  "kt50031": "금현물 주문체결조회",
  "kt50032": "금현물 거래내역조회",
  "kt50075": "금현물 미체결조회"
};

async function getAccessToken(base, appKey, appSecret, forceNew = false) {
  if (!forceNew) {
    const cached = process.env['KIWOOM_ACCESS_TOKEN'];
    if (cached) return { token: cached, isNew: false };
  }
  const resp = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: appSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`토큰 발급 실패: ${resp.status}`);
  const json = await resp.json();
  if (!json.token) throw new Error(`토큰 응답 오류: ${JSON.stringify(json)}`);
  return { token: json.token, isNew: true };
}

// Rate limit: 초당 5회 (키움 공식 한도)
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
  if (!category) throw new Error(`이 sysmod 는 ${apiId} 를 지원하지 않습니다. 본 sysmod 가 지원하는 API: ${Object.keys(URL_CATEGORY).join(', ')}`);
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
    const errText = await resp.text().catch(() => '');
    throw new Error(`키움 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
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
    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom-account 에서 등록해주세요.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    let { token, isNew } = await getAccessToken(base, appKey, appSecret);
    const params = data.params || {};
    let result = await callApi(base, token, action, params);
    const isTokenInvalid = result?.return_code === 3 || /Token이 유효하지 않습니다|token.*invalid/i.test(result?.return_msg || '');
    if (isTokenInvalid && !isNew) {
      const fresh = await getAccessToken(base, appKey, appSecret, true);
      token = fresh.token;
      isNew = true;
      result = await callApi(base, token, action, params);
    }
    const output = { success: true, data: { apiId: action, name: API_NAMES[action], ...result } };
    if (isNew) output.__updateSecrets = { KIWOOM_ACCESS_TOKEN: token };
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

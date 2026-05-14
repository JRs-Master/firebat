#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom-ranking
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kiwoom.json 입력.
 *
 * 키움증권 실시간 순위정보 (등락률·거래량·호가잔량·외인·신용비율 등 23종)
 * 23개 API. action = API ID 직접 호출 + params 가 request body.
 *
 * 옛 sysmod_kiwoom (151 actions) 의 도메인별 분리 — OAuth + callApi + throttle 자체 inline.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 카테고리 (POST /api/dostk/{category} + apiId 헤더)
const URL_CATEGORY = {
  "ka10020": "rkinfo",
  "ka10021": "rkinfo",
  "ka10022": "rkinfo",
  "ka10023": "rkinfo",
  "ka10027": "rkinfo",
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
  "ka10053": "rkinfo",
  "ka10062": "rkinfo",
  "ka10065": "rkinfo",
  "ka10098": "rkinfo",
  "ka90009": "rkinfo"
};
// API ID → 한글명 (에러 메시지 용)
const API_NAMES = {
  "ka10020": "호가잔량상위요청",
  "ka10021": "호가잔량급증요청",
  "ka10022": "잔량율급증요청",
  "ka10023": "거래량급증요청",
  "ka10027": "전일대비등락률상위요청",
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
  "ka10053": "당일상위이탈원요청",
  "ka10062": "동일순매매순위요청",
  "ka10065": "장중투자자별매매상위요청",
  "ka10098": "시간외단일가등락율순위요청",
  "ka90009": "외국인기관매매상위요청"
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
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom-ranking 에서 등록해주세요.' }));
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

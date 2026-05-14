#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom-chart
 * Phase Stock-Split S2 (2026-05-14) — codegen 생성. infra/data/stock-apis-kiwoom.json 입력.
 *
 * 키움증권 차트 (틱/분봉/일봉/주봉/월봉/년봉 — 주식·업종·금현물)
 * 21개 API. action = API ID 직접 호출 + params 가 request body.
 *
 * 옛 sysmod_kiwoom (151 actions) 의 도메인별 분리 — OAuth + callApi + throttle 자체 inline.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 카테고리 (POST /api/dostk/{category} + apiId 헤더)
const URL_CATEGORY = {
  "ka10060": "chart",
  "ka10064": "chart",
  "ka10079": "chart",
  "ka10080": "chart",
  "ka10081": "chart",
  "ka10082": "chart",
  "ka10083": "chart",
  "ka10094": "chart",
  "ka20004": "chart",
  "ka20005": "chart",
  "ka20006": "chart",
  "ka20007": "chart",
  "ka20008": "chart",
  "ka20019": "chart",
  "ka50079": "chart",
  "ka50080": "chart",
  "ka50081": "chart",
  "ka50082": "chart",
  "ka50083": "chart",
  "ka50091": "chart",
  "ka50092": "chart"
};
// API ID → 한글명 (에러 메시지 용)
const API_NAMES = {
  "ka10060": "종목별투자자기관별차트요청",
  "ka10064": "장중투자자별매매차트요청",
  "ka10079": "주식틱차트조회요청",
  "ka10080": "주식분봉차트조회요청",
  "ka10081": "주식일봉차트조회요청",
  "ka10082": "주식주봉차트조회요청",
  "ka10083": "주식월봉차트조회요청",
  "ka10094": "주식년봉차트조회요청",
  "ka20004": "업종틱차트조회요청",
  "ka20005": "업종분봉조회요청",
  "ka20006": "업종일봉조회요청",
  "ka20007": "업종주봉조회요청",
  "ka20008": "업종월봉조회요청",
  "ka20019": "업종년봉조회요청",
  "ka50079": "금현물틱차트조회요청",
  "ka50080": "금현물분봉차트조회요청",
  "ka50081": "금현물일봉차트조회요청",
  "ka50082": "금현물주봉차트조회요청",
  "ka50083": "금현물월봉차트조회요청",
  "ka50091": "금현물당일틱차트조회요청",
  "ka50092": "금현물당일분봉차트조회요청"
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
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom-chart 에서 등록해주세요.' }));
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

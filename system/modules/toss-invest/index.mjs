#!/usr/bin/env node
/**
 * Firebat System Module: toss-invest — 토스증권 Open API (openapi.tossinvest.com).
 *
 * LLM 시점: config.json 의 domains[] 가 토스 태그별 별도 LLM 도구로 분리 등록
 * (sysmod_toss_invest_<domain>). 단일 index.mjs 가 모든 도메인 처리 — action 으로 직접 호출.
 *
 * 토큰: 인프라 TokenProvider 가 config.json 의 token secret(oauth client_credentials)으로
 * 발급·선제 갱신(24h, lifetimeSec 직전)해 env(TOSS_ACCESS_TOKEN)로 주입한다. 모듈은 받아쓰기만 — 토큰 코드 0.
 *
 * 새 endpoint = API_TABLE 한 줄 + 해당 domain.actions 에 추가.
 */

const BASE = 'https://openapi.tossinvest.com';

// action → { method, path, query[], pathParams[], body[], needsAccount, name }
// path 의 {x} 는 pathParams 로 치환. query 는 GET 쿼리스트링, body 는 POST JSON 본문(필드명 = data 키).
// needsAccount=true 면 accountSeq(data) → X-Tossinvest-Account 헤더.
const API_TABLE = {
  // ── Market Data ── (토큰만)
  'orderbook':      { method: 'GET', path: '/api/v1/orderbook',    query: ['symbol'], name: '호가 조회' },
  'prices':         { method: 'GET', path: '/api/v1/prices',       query: ['symbols'], name: '현재가 조회' },
  'trades':         { method: 'GET', path: '/api/v1/trades',       query: ['symbol', 'count'], name: '최근 체결 내역' },
  'price-limits':   { method: 'GET', path: '/api/v1/price-limits', query: ['symbol'], name: '상/하한가' },
  'candles':        { method: 'GET', path: '/api/v1/candles',      query: ['symbol', 'interval', 'count', 'before', 'adjusted'], name: '캔들 차트' },
  // ── Stock Info ── (토큰만)
  'stocks':         { method: 'GET', path: '/api/v1/stocks',       query: ['symbols'], name: '종목 기본 정보' },
  'stock-warnings': { method: 'GET', path: '/api/v1/stocks/{symbol}/warnings', pathParams: ['symbol'], name: '매수 유의사항' },
  // ── Market Info ── (토큰만)
  'exchange-rate':  { method: 'GET', path: '/api/v1/exchange-rate', query: ['baseCurrency', 'quoteCurrency', 'dateTime'], name: '환율' },
  'market-calendar':{ method: 'GET', path: '/api/v1/market-calendar/{market}', pathParams: ['market'], query: ['date'], name: '장 운영 정보' },
  // ── Account ── (토큰만 — accountSeq 진입점)
  'accounts':       { method: 'GET', path: '/api/v1/accounts', name: '계좌 목록' },
  // ── Asset ── (accountSeq 필요)
  'holdings':       { method: 'GET', path: '/api/v1/holdings', query: ['symbol'], needsAccount: true, name: '보유 주식' },
  // ── Order History ── (accountSeq 필요)
  'list-orders':    { method: 'GET', path: '/api/v1/orders', query: ['status', 'symbol', 'from', 'to', 'cursor', 'limit'], needsAccount: true, name: '주문 목록' },
  'order-detail':   { method: 'GET', path: '/api/v1/orders/{orderId}', pathParams: ['orderId'], needsAccount: true, name: '주문 상세' },
  // ── Order Info ── (accountSeq 필요)
  'buying-power':       { method: 'GET', path: '/api/v1/buying-power', query: ['currency'], needsAccount: true, name: '매수 가능 금액' },
  'sellable-quantity':  { method: 'GET', path: '/api/v1/sellable-quantity', query: ['symbol'], needsAccount: true, name: '판매 가능 수량' },
  'commissions':        { method: 'GET', path: '/api/v1/commissions', needsAccount: true, name: '매매 수수료' },
  // ── Order (실매매 — 즉시 전송) ── (accountSeq 필요)
  'create-order':   { method: 'POST', path: '/api/v1/orders', body: ['clientOrderId', 'symbol', 'side', 'orderType', 'quantity', 'orderAmount', 'price', 'timeInForce', 'confirmHighValueOrder'], needsAccount: true, name: '주문 생성' },
  'modify-order':   { method: 'POST', path: '/api/v1/orders/{orderId}/modify', pathParams: ['orderId'], body: ['orderType', 'quantity', 'price', 'confirmHighValueOrder'], needsAccount: true, name: '주문 정정' },
  'cancel-order':   { method: 'POST', path: '/api/v1/orders/{orderId}/cancel', pathParams: ['orderId'], body: [], needsAccount: true, name: '주문 취소' },
};

// 공유 rate limiter — 토스 rate limit group 별 한도는 응답 헤더로 관리되나, 보수적 공통 throttle +
// 429 재시도(Retry-After 존중)로 충분. (그룹별 정밀 제어는 한도 마찰 실측 시.)
const RATE_LIMIT = 10;
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

async function callApi(token, action, data, retry = 2) {
  const meta = API_TABLE[action];
  if (!meta) throw new Error(`알 수 없는 action: ${action}. 토스증권 Open API 문서 참조.`);

  // path param 치환
  let path = meta.path;
  for (const pp of meta.pathParams || []) {
    const v = data[pp];
    if (v === undefined || v === null || v === '') throw new Error(`${action}: ${pp} 필수`);
    path = path.replace(`{${pp}}`, encodeURIComponent(String(v)));
  }

  const url = new URL(`${BASE}${path}`);
  for (const q of meta.query || []) {
    const v = data[q];
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(q, String(v));
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
  };
  if (meta.needsAccount) {
    const acc = data.accountSeq;
    if (acc === undefined || acc === null || acc === '') {
      throw new Error(`${action}: accountSeq 필수 — account 도구의 accounts 로 계좌 조회 후 accountSeq 전달.`);
    }
    headers['X-Tossinvest-Account'] = String(acc);
  }

  await acquireSlot();
  const init = { method: meta.method, headers, signal: AbortSignal.timeout(15000) };
  // POST — body 필드를 data 에서 모아 JSON 전송 (body:[] 면 빈 객체). decimal/문자열 그대로 전달.
  if (meta.method !== 'GET' && meta.body !== undefined) {
    const bodyObj = {};
    for (const f of meta.body) {
      const v = data[f];
      if (v !== undefined && v !== null && v !== '') bodyObj[f] = v;
    }
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(bodyObj);
  }

  const resp = await fetch(url, init);
  if (resp.status === 429 && retry > 0) {
    const ra = Number(resp.headers.get('retry-after')) || 1;
    await new Promise(r => setTimeout(r, ra * 1000 + 100));
    return callApi(token, action, data, retry - 1);
  }

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    // 토스 에러 envelope: API = {error:{requestId,code,message,data}} / OAuth = {error, error_description}.
    const e = json && json.error;
    let code, msg;
    if (e && typeof e === 'object') { code = e.code; msg = e.message || e.code || `HTTP ${resp.status}`; }
    else if (typeof e === 'string') { code = e; msg = json.error_description || e; }
    else msg = `HTTP ${resp.status} ${resp.statusText}`;
    return { _ok: false, _status: resp.status, _code: code, _error: msg };
  }
  // 성공 envelope: {result: ...}
  return { _ok: true, result: json && json.result !== undefined ? json.result : json };
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다 (예: prices, candles, accounts, create-order).' }));
      return;
    }
    const apiKey = process.env['TOSS_API_KEY'];
    const secretKey = process.env['TOSS_SECRET_KEY'];
    if (!apiKey || !secretKey) {
      console.log(JSON.stringify({ success: false, error: 'TOSS_API_KEY / TOSS_SECRET_KEY 미설정. 설정 > 시스템 모듈 > toss-invest 에서 등록하세요.' }));
      return;
    }
    // 인프라 TokenProvider 가 발급·선제 갱신해 env 로 주입한 raw 토큰. 모듈은 받아쓰기만.
    const token = process.env['TOSS_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: '토스 액세스 토큰 미발급 — 인프라 토큰 발급 실패 또는 API Key/Secret Key 오류.' }));
      return;
    }

    const meta = API_TABLE[action];
    const res = await callApi(token, action, data);
    if (!res._ok) {
      const out = { success: false, error: res._error, data: { action, status: res._status } };
      if (res._code) out.data.code = res._code;
      console.log(JSON.stringify(out));
      return;
    }
    console.log(JSON.stringify({ success: true, data: { action, name: meta?.name, result: res.result } }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

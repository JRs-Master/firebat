#!/usr/bin/env node
/**
 * Firebat System Module: toss-invest — 토스증권 Open API (openapi.tossinvest.com).
 *
 * LLM 시점: config.json 의 domains[] 가 도메인별 별도 도구로 분리 등록
 * (sysmod_toss_invest_market_data 등). 단일 index.mjs 가 모든 도메인 처리 — action 으로 직접 호출.
 *
 * 토큰: 인프라 TokenProvider 가 config.json 의 token secret(oauth client_credentials)으로
 * 발급·선제 갱신(24h, lifetimeSec 직전)해 env(TOSS_ACCESS_TOKEN)로 주입한다. 모듈은 받아쓰기만 — 토큰 코드 0.
 *
 * 새 endpoint = API_TABLE 한 줄 + 해당 domain.actions 에 추가. 계좌/주문 도메인은 토스 Open API
 * 확장 시 needsAccount:true + X-Tossinvest-Account 헤더 경로로 추가 (골격 이미 준비됨).
 */

const BASE = 'https://openapi.tossinvest.com';

// action → { method, path, query[], pathParams[], needsAccount, name }
// path 의 {x} 는 pathParams 로 치환. query 는 GET 쿼리스트링. needsAccount=true 면 X-Tossinvest-Account 헤더 필요.
const API_TABLE = {
  // ── Market Data ──────────────────────────────────────────────
  'orderbook':      { method: 'GET', path: '/api/v1/orderbook',    query: ['symbol'], name: '호가 조회' },
  'prices':         { method: 'GET', path: '/api/v1/prices',       query: ['symbols'], name: '현재가 조회' },
  'trades':         { method: 'GET', path: '/api/v1/trades',       query: ['symbol', 'count'], name: '최근 체결 내역' },
  'price-limits':   { method: 'GET', path: '/api/v1/price-limits', query: ['symbol'], name: '상/하한가' },
  'candles':        { method: 'GET', path: '/api/v1/candles',      query: ['symbol', 'interval', 'count', 'before', 'adjusted'], name: '캔들 차트' },
  // ── Stock Info ───────────────────────────────────────────────
  'stocks':         { method: 'GET', path: '/api/v1/stocks',       query: ['symbols'], name: '종목 기본 정보' },
  'stock-warnings': { method: 'GET', path: '/api/v1/stocks/{symbol}/warnings', pathParams: ['symbol'], name: '매수 유의사항' },
  // ── Market Info ──────────────────────────────────────────────
  'exchange-rate':  { method: 'GET', path: '/api/v1/exchange-rate', query: ['baseCurrency', 'quoteCurrency', 'dateTime'], name: '환율' },
  'market-calendar':{ method: 'GET', path: '/api/v1/market-calendar/{market}', pathParams: ['market'], query: ['date'], name: '장 운영 정보' },
};

// 공유 rate limiter — 토스 rate limit group(MARKET_DATA 등)별 한도는 응답 헤더로 관리되나, 보수적
// 공통 throttle + 429 재시도로 충분. (그룹별 정밀 제어는 한도 마찰 실측 시.)
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
    if (!acc) throw new Error(`${action}: accountSeq 필수 (accounts 조회 후 X-Tossinvest-Account)`);
    headers['X-Tossinvest-Account'] = String(acc);
  }

  await acquireSlot();
  const init = { method: meta.method, headers, signal: AbortSignal.timeout(15000) };
  if (meta.method !== 'GET' && meta.body && data.body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(data.body);
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
    let msg;
    if (e && typeof e === 'object') msg = e.message || e.code || `HTTP ${resp.status}`;
    else if (typeof e === 'string') msg = json.error_description || e;
    else msg = `HTTP ${resp.status} ${resp.statusText}`;
    return { _ok: false, _status: resp.status, _error: msg };
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
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다 (예: prices, candles).' }));
      return;
    }
    const clientId = process.env['TOSS_CLIENT_ID'];
    const clientSecret = process.env['TOSS_CLIENT_SECRET'];
    if (!clientId || !clientSecret) {
      console.log(JSON.stringify({ success: false, error: 'TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 미설정. 설정 > 시스템 모듈 > toss-invest 에서 등록하세요.' }));
      return;
    }
    // 인프라 TokenProvider 가 발급·선제 갱신해 env 로 주입한 raw 토큰. 모듈은 받아쓰기만.
    const token = process.env['TOSS_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: '토스 액세스 토큰 미발급 — 인프라 토큰 발급 실패 또는 client_id/secret 오류.' }));
      return;
    }

    const meta = API_TABLE[action];
    const res = await callApi(token, action, data);
    if (!res._ok) {
      console.log(JSON.stringify({ success: false, error: res._error, data: { action, status: res._status } }));
      return;
    }
    console.log(JSON.stringify({ success: true, data: { action, name: meta?.name, result: res.result } }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

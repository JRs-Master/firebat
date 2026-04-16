/**
 * Firebat System Module: upbit (crypto-trading)
 * 업비트 Open API — 전체 API 지원
 *
 * API 문서: https://docs.upbit.com
 * SDK 참조: https://github.com/upbit-official/upbit-sdk-typescript
 * 인증: access_key + secret_key → JWT (HS256)
 *
 * 편의 액션 → endpoint 자동 매핑, 또는 endpoint + method 직접 호출
 */

import crypto from 'crypto';

const BASE = 'https://api.upbit.com';

// ─── 편의 액션 → { method, endpoint, auth, buildParams } 매핑 ───
const ACTION_MAP = {
  // ══ 자산 ══
  'accounts':        { method: 'GET', endpoint: '/v1/accounts', auth: true },

  // ══ 주문 ══
  'order-chance':    { method: 'GET', endpoint: '/v1/orders/chance', auth: true },
  'order-detail':    { method: 'GET', endpoint: '/v1/order', auth: true },
  'order-create':    { method: 'POST', endpoint: '/v1/orders', auth: true },
  'order-cancel':    { method: 'DELETE', endpoint: '/v1/order', auth: true },
  'order-cancel-and-new': { method: 'POST', endpoint: '/v1/orders/cancel_and_new', auth: true },
  'order-cancel-uuids':   { method: 'DELETE', endpoint: '/v1/orders/uuids', auth: true },
  'order-cancel-open':    { method: 'DELETE', endpoint: '/v1/orders/open', auth: true },
  'order-list-uuids':     { method: 'GET', endpoint: '/v1/orders/uuids', auth: true },
  'order-list-closed':    { method: 'GET', endpoint: '/v1/orders/closed', auth: true },
  'order-list-open':      { method: 'GET', endpoint: '/v1/orders/open', auth: true },
  'order-test':      { method: 'POST', endpoint: '/v1/orders/test', auth: true },

  // ══ 캔들 (Quotation — 인증 불필요) ══
  'candle-seconds':  { method: 'GET', endpoint: '/v1/candles/seconds', auth: false },
  'candle-minutes':  { method: 'GET', endpoint: '/v1/candles/minutes/{unit}', auth: false },
  'candle-days':     { method: 'GET', endpoint: '/v1/candles/days', auth: false },
  'candle-weeks':    { method: 'GET', endpoint: '/v1/candles/weeks', auth: false },
  'candle-months':   { method: 'GET', endpoint: '/v1/candles/months', auth: false },
  'candle-years':    { method: 'GET', endpoint: '/v1/candles/years', auth: false },

  // ══ 체결 ══
  'trades':          { method: 'GET', endpoint: '/v1/trades/ticks', auth: false },

  // ══ Ticker (현재가) ══
  'ticker':          { method: 'GET', endpoint: '/v1/ticker', auth: false },
  'ticker-all':      { method: 'GET', endpoint: '/v1/ticker/all', auth: false },

  // ══ 호가 ══
  'orderbook':       { method: 'GET', endpoint: '/v1/orderbook', auth: false },
  'orderbook-instruments': { method: 'GET', endpoint: '/v1/orderbook/instruments', auth: false },

  // ══ 마켓 (거래쌍 목록) ══
  'markets':         { method: 'GET', endpoint: '/v1/market/all', auth: false },

  // ══ 출금 ══
  'withdraw-detail': { method: 'GET', endpoint: '/v1/withdraw', auth: true },
  'withdraw-list':   { method: 'GET', endpoint: '/v1/withdraws', auth: true },
  'withdraw-cancel': { method: 'DELETE', endpoint: '/v1/withdraws/coin', auth: true },
  'withdraw-coin':   { method: 'POST', endpoint: '/v1/withdraws/coin', auth: true },
  'withdraw-krw':    { method: 'POST', endpoint: '/v1/withdraws/krw', auth: true },
  'withdraw-addresses': { method: 'GET', endpoint: '/v1/withdraws/coin_addresses', auth: true },
  'withdraw-chance': { method: 'GET', endpoint: '/v1/withdraws/chance', auth: true },

  // ══ 입금 ══
  'deposit-detail':  { method: 'GET', endpoint: '/v1/deposit', auth: true },
  'deposit-list':    { method: 'GET', endpoint: '/v1/deposits', auth: true },
  'deposit-create-address': { method: 'POST', endpoint: '/v1/deposits/generate_coin_address', auth: true },
  'deposit-krw':     { method: 'POST', endpoint: '/v1/deposits/krw', auth: true },
  'deposit-addresses': { method: 'GET', endpoint: '/v1/deposits/coin_addresses', auth: true },
  'deposit-address': { method: 'GET', endpoint: '/v1/deposits/coin_address', auth: true },
  'deposit-chance':  { method: 'GET', endpoint: '/v1/deposits/chance/coin', auth: true },

  // ══ 서비스 정보 ══
  'wallet-status':   { method: 'GET', endpoint: '/v1/status/wallet', auth: true },
  'api-keys':        { method: 'GET', endpoint: '/v1/api_keys', auth: true },
};

// ─── 액션별 파라미터 빌드 ───
function buildParams(action, input) {
  const p = {};

  switch (action) {
    // ── 주문 ──
    case 'order-chance':
      if (input.market) p.market = input.market;
      break;
    case 'order-detail':
      if (input.uuid) p.uuid = input.uuid;
      if (input.identifier) p.identifier = input.identifier;
      break;
    case 'order-create':
    case 'order-test':
      if (input.market) p.market = input.market;
      if (input.side) p.side = input.side;
      if (input.volume) p.volume = input.volume;
      if (input.price) p.price = input.price;
      if (input.ord_type) p.ord_type = input.ord_type;
      if (input.identifier) p.identifier = input.identifier;
      if (input.time_in_force) p.time_in_force = input.time_in_force;
      if (input.smp_type) p.smp_type = input.smp_type;
      break;
    case 'order-cancel':
      if (input.uuid) p.uuid = input.uuid;
      if (input.identifier) p.identifier = input.identifier;
      break;
    case 'order-cancel-and-new':
      if (input.prev_order_uuid) p.prev_order_uuid = input.prev_order_uuid;
      if (input.prev_order_identifier) p.prev_order_identifier = input.prev_order_identifier;
      if (input.new_ord_type) p.new_ord_type = input.new_ord_type;
      if (input.new_volume) p.new_volume = input.new_volume;
      if (input.new_price) p.new_price = input.new_price;
      if (input.new_identifier) p.new_identifier = input.new_identifier;
      if (input.new_time_in_force) p.new_time_in_force = input.new_time_in_force;
      if (input.new_smp_type) p.new_smp_type = input.new_smp_type;
      break;
    case 'order-cancel-uuids':
      if (input.uuids) p.uuids = input.uuids;
      break;
    case 'order-cancel-open':
      if (input.market) p.market = input.market;
      if (input.side) p.side = input.side;
      break;
    case 'order-list-uuids':
      if (input.uuids) p.uuids = input.uuids;
      if (input.order_by) p.order_by = input.order_by;
      break;
    case 'order-list-closed':
      if (input.market) p.market = input.market;
      if (input.state) p.state = input.state;
      if (input.states) p.states = input.states;
      if (input.order_by) p.order_by = input.order_by;
      if (input.limit) p.limit = input.limit;
      if (input.from) p.from = input.from;
      if (input.to) p.to = input.to;
      break;
    case 'order-list-open':
      if (input.market) p.market = input.market;
      if (input.state) p.state = input.state;
      if (input.states) p.states = input.states;
      if (input.order_by) p.order_by = input.order_by;
      if (input.page) p.page = input.page;
      if (input.limit) p.limit = input.limit;
      break;

    // ── 캔들 ──
    case 'candle-seconds':
    case 'candle-minutes':
    case 'candle-days':
    case 'candle-weeks':
    case 'candle-months':
    case 'candle-years':
      if (input.market) p.market = input.market;
      if (input.to) p.to = input.to;
      if (input.count) p.count = input.count;
      if (action === 'candle-days' && input.converting_price_unit) {
        p.convertingPriceUnit = input.converting_price_unit;
      }
      break;

    // ── 체결 ──
    case 'trades':
      if (input.market) p.market = input.market;
      if (input.to) p.to = input.to;
      if (input.count) p.count = input.count;
      if (input.cursor) p.cursor = input.cursor;
      if (input.days_ago) p.daysAgo = input.days_ago;
      break;

    // ── Ticker ──
    case 'ticker':
      if (input.markets) p.markets = input.markets;
      else if (input.market) p.markets = input.market;
      break;
    case 'ticker-all':
      if (input.quote_currencies) p.quote_currencies = input.quote_currencies;
      break;

    // ── 호가 ──
    case 'orderbook':
      if (input.markets) p.markets = input.markets;
      else if (input.market) p.markets = input.market;
      if (input.level) p.level = input.level;
      if (input.count) p.count = input.count;
      break;
    case 'orderbook-instruments':
      if (input.markets) p.markets = input.markets;
      else if (input.market) p.markets = input.market;
      break;

    // ── 마켓 ──
    case 'markets':
      if (input.is_details !== undefined) p.isDetails = input.is_details;
      break;

    // ── 출금 ──
    case 'withdraw-detail':
      if (input.uuid) p.uuid = input.uuid;
      if (input.txid) p.txid = input.txid;
      if (input.currency) p.currency = input.currency;
      break;
    case 'withdraw-list':
      if (input.currency) p.currency = input.currency;
      if (input.state) p.state = input.state;
      if (input.uuids) p.uuids = input.uuids;
      if (input.txids) p.txids = input.txids;
      if (input.order_by) p.order_by = input.order_by;
      if (input.page) p.page = input.page;
      if (input.limit) p.limit = input.limit;
      if (input.from) p.from = input.from;
      if (input.to) p.to = input.to;
      break;
    case 'withdraw-cancel':
      if (input.uuid) p.uuid = input.uuid;
      break;
    case 'withdraw-coin':
      if (input.currency) p.currency = input.currency;
      if (input.net_type) p.net_type = input.net_type;
      if (input.amount) p.amount = input.amount;
      if (input.address) p.address = input.address;
      if (input.secondary_address) p.secondary_address = input.secondary_address;
      if (input.transaction_type) p.transaction_type = input.transaction_type;
      break;
    case 'withdraw-krw':
      if (input.amount) p.amount = input.amount;
      if (input.two_factor_type) p.two_factor_type = input.two_factor_type;
      break;
    case 'withdraw-chance':
      if (input.currency) p.currency = input.currency;
      if (input.net_type) p.net_type = input.net_type;
      break;

    // ── 입금 ──
    case 'deposit-detail':
      if (input.uuid) p.uuid = input.uuid;
      if (input.txid) p.txid = input.txid;
      if (input.currency) p.currency = input.currency;
      break;
    case 'deposit-list':
      if (input.currency) p.currency = input.currency;
      if (input.state) p.state = input.state;
      if (input.uuids) p.uuids = input.uuids;
      if (input.txids) p.txids = input.txids;
      if (input.order_by) p.order_by = input.order_by;
      if (input.page) p.page = input.page;
      if (input.limit) p.limit = input.limit;
      if (input.from) p.from = input.from;
      if (input.to) p.to = input.to;
      break;
    case 'deposit-create-address':
      if (input.currency) p.currency = input.currency;
      if (input.net_type) p.net_type = input.net_type;
      break;
    case 'deposit-krw':
      if (input.amount) p.amount = input.amount;
      if (input.two_factor_type) p.two_factor_type = input.two_factor_type;
      break;
    case 'deposit-address':
      if (input.currency) p.currency = input.currency;
      if (input.net_type) p.net_type = input.net_type;
      break;
    case 'deposit-chance':
      if (input.currency) p.currency = input.currency;
      if (input.net_type) p.net_type = input.net_type;
      break;
  }

  // 직접 호출 시 params 병합
  if (input.params && typeof input.params === 'object') {
    Object.assign(p, input.params);
  }

  return p;
}

// ─── JWT 토큰 생성 (업비트 인증) ───
function createToken(accessKey, secretKey, queryParams) {
  const payload = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };

  // 파라미터가 있으면 query_hash 추가
  if (queryParams && Object.keys(queryParams).length > 0) {
    const queryString = buildQueryString(queryParams);
    const hash = crypto.createHash('sha512').update(queryString, 'utf-8').digest('hex');
    payload.query_hash = hash;
    payload.query_hash_alg = 'SHA512';
  }

  // JWT HS256 수동 생성 (jsonwebtoken 의존성 없이)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secretKey).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

// ─── 쿼리스트링 빌드 (배열 파라미터 지원) ───
function buildQueryString(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // uuids[]=xxx&uuids[]=yyy 형식
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(v)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

// ─── API 호출 ───
async function callApi(method, endpoint, params, accessKey, secretKey, needAuth) {
  const headers = { 'Content-Type': 'application/json' };

  if (needAuth) {
    if (!accessKey || !secretKey) {
      throw new Error('UPBIT_ACCESS_KEY, UPBIT_SECRET_KEY가 필요합니다. 설정 > API 키에서 등록해주세요.');
    }
    const token = createToken(accessKey, secretKey, method === 'GET' || method === 'DELETE' ? params : params);
    headers['Authorization'] = `Bearer ${token}`;
  }

  let url = `${BASE}${endpoint}`;
  const fetchOpts = { method, headers };

  if (method === 'GET' || method === 'DELETE') {
    const qs = buildQueryString(params);
    if (qs) url += `?${qs}`;
  } else {
    fetchOpts.body = JSON.stringify(params);
  }

  const res = await fetch(url, fetchOpts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error?.name || text;
    throw new Error(`업비트 API 오류 (${res.status}): ${errMsg}`);
  }

  return data;
}

// ─── 메인 ───
async function main(input) {
  const { action, endpoint: directEndpoint, method: directMethod } = input;
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;

  try {
    let method, endpoint, needAuth;

    if (directEndpoint) {
      // 직접 호출 모드
      method = (directMethod || 'GET').toUpperCase();
      endpoint = directEndpoint;
      needAuth = !endpoint.startsWith('/v1/candles') &&
                 !endpoint.startsWith('/v1/trades') &&
                 !endpoint.startsWith('/v1/ticker') &&
                 !endpoint.startsWith('/v1/orderbook') &&
                 !endpoint.startsWith('/v1/market');
    } else {
      const spec = ACTION_MAP[action];
      if (!spec) {
        console.log(JSON.stringify({ success: false, error: `알 수 없는 액션: ${action}` }));
        process.exit(1);
      }
      method = spec.method;
      endpoint = spec.endpoint;
      needAuth = spec.auth;

      // 분봉: {unit} 치환
      if (action === 'candle-minutes') {
        const unit = input.unit || 1;
        endpoint = endpoint.replace('{unit}', String(unit));
      }
    }

    const params = directEndpoint ? (input.params || {}) : buildParams(action, input);
    const data = await callApi(method, endpoint, params, accessKey, secretKey, needAuth);

    console.log(JSON.stringify({
      success: true,
      data: {
        action: action || 'direct',
        endpoint,
        ...( Array.isArray(data) ? { items: data, count: data.length } : data ),
      },
    }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const parsed = JSON.parse(raw);
    const input = parsed.data ?? parsed;
    await main(input);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: `입력 파싱 실패: ${err.message}` }));
    process.exit(1);
  }
});

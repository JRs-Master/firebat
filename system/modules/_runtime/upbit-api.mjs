/**
 * Upbit dialect — shared by the two modules that speak it.
 *
 * The split is not about code. It is about which actions a caller can reach and which credentials
 * the process is handed: `upbit` declares the private actions and the API keys, `upbit-quotes`
 * declares neither. A hub instance can be allowed the quote module without that allowing it to
 * read the operator's balance, and no list of forbidden action names has to be kept correct for
 * that to hold — the enum the framework validates against simply does not contain them, and the
 * sandbox injects no key into a module that declares no secret.
 *
 * Lives outside both because neither owns it. `_runtime` has no config.json, so the module scan
 * skips it.
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

/** i18n 에러 — main 의 catch 에서 errorKey/errorParams 추출. */
class I18nError extends Error {
  constructor(key, params) {
    super(key);
    this.errorKey = key;
    this.errorParams = params || {};
  }
}

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.upbit.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

// ─── JWT 토큰 생성 (업비트 인증) ───
function createToken(accessKey, secretKey, queryParams) {
  const payload = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };

  // 파라미터가 있으면 query_hash 추가 — 인코딩되지 않은 문자열 기준(문서 명시).
  if (queryParams && Object.keys(queryParams).length > 0) {
    const queryString = buildQueryStrings(queryParams).raw;
    const hash = crypto.createHash('sha512').update(queryString, 'utf-8').digest('hex');
    payload.query_hash = hash;
    payload.query_hash_alg = 'SHA512';
  }

  // HS512, which is what the exchange documents — the signature algorithm, not the query hash.
  // This was HS256 while `query_hash_alg` already said SHA512, a mismatch nothing here could have
  // caught: no key has ever been registered, so an authenticated call has never been made.
  const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha512', secretKey)
    .update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

// ─── 쿼리스트링 빌드 (배열 파라미터 지원) ───
/** The query string, in the two forms the exchange asks for.
 *
 * The signature covers the UNENCODED string while the URL carries the ENCODED one — the docs are
 * explicit about both, and using one string for both jobs only works while every value happens to
 * encode to itself. It stops working the moment a timestamp appears: `+09:00` becomes `%2B09%3A00`
 * in the URL, and a hash taken over that does not match what the server computes. The failure is
 * a 401 on exactly the endpoints worth calling.
 *
 * Brackets stay literal in both: `uuids[]=a&uuids[]=b` is the documented shape and the docs
 * exclude `[` and `]` from encoding.
 */
function buildQueryStrings(params) {
  const raw = [];
  const encoded = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const list = Array.isArray(value) ? value : [value];
    const suffix = Array.isArray(value) ? '[]' : '';
    for (const v of list) {
      raw.push(`${key}${suffix}=${v}`);
      encoded.push(`${encodeURIComponent(key)}${suffix}=${encodeURIComponent(v)}`);
    }
  }
  return { raw: raw.join('&'), encoded: encoded.join('&') };
}

function buildQueryString(params) {
  return buildQueryStrings(params).encoded;
}

// ─── API 호출 ───
async function callApi(method, endpoint, params, accessKey, secretKey, needAuth) {
  const headers = { 'Content-Type': 'application/json' };

  if (needAuth) {
    if (!accessKey || !secretKey) {
      throw new I18nError('error.api_key_missing', {});
    }
    // The hash covers the same parameters whatever the verb: for a body request the exchange
    // turns the JSON into a query string and hashes that. The branch that used to be here chose
    // between two identical values.
    const token = createToken(accessKey, secretKey, params);
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

  // The exchange states the remaining budget on every response, per API group. Passing it on is
  // the difference between a caller that can slow down and one that finds out by being blocked.
  const remaining = res.headers.get('remaining-req');

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error?.name || text;
    // These three say what to do about them; a bare status code does not.
    const hint =
      res.status === 429 ? ' — 요청 한도를 넘었습니다. 잔여 한도: ' + (remaining || '알 수 없음')
      : res.status === 418 ? ' — 한도 초과로 일시 차단된 상태입니다. 잠시 후 다시 시도하세요.'
      : res.status === 401 ? ' — 인증 실패입니다. API Key 와 허용 IP 를 확인하세요.'
      : '';
    throw new I18nError('error.api_status',
      { status: String(res.status), message: String(errMsg) + hint });
  }

  return data;
}

// ─── 메인 ───

// ── Candles, by interval ─────────────────────────────────────────────────────────────────────
// The neutral shape every broker in this system answers: {symbol, interval}. Upbit splits
// timeframes across endpoints (minutes carry the unit in the path, days/weeks/months are their
// own), and the caller should no more know that here than it should know a Kiwoom API id. A
// strategy changing from 5-minute to hourly is a settings edit, not a code edit.
// A hard stop on paging: 20,000 bars is a hundred calls, which is already generous
// against a ten-per-second limit shared with everything else asking for candles.
const MAX_PAGED_BARS = 20000;
const UPBIT_MINUTE_UNITS = { '1m': '1', '3m': '3', '5m': '5', '10m': '10', '15m': '15',
                             '30m': '30', '60m': '60', '1h': '60', '240m': '240', '4h': '240' };
const UPBIT_PERIODS = { '1d': 'candle-days', '1w': 'candle-weeks',
                        '1M': 'candle-months', '1y': 'candle-years' };

/** `get_candles` → the concrete action and inputs the dispatcher below already understands. */
function normalizeCandleRequest(input) {
  const symbol = String(input.symbol ?? input.market ?? '').trim();
  if (!symbol) throw new Error('get_candles: symbol 이 필요합니다 (예: KRW-BTC).');
  const interval = String(input.interval ?? '1d').trim();
  // The exchange defaults `count` to 1. A caller that forgets it gets a single bar, and the
  // analyser then reports no signals — which reads as a quiet market rather than a missing
  // argument. 200 is the documented maximum and what a series is for.
  const out = { ...input, market: symbol, count: Number(input.count) > 0 ? input.count : 200 };
  const seconds = /^(\d+)s$/i.exec(interval);
  if (seconds) {
    return { ...out, action: 'candle-seconds', unit: seconds[1] };
  }
  const unit = UPBIT_MINUTE_UNITS[interval];
  if (unit) {
    return { ...out, action: 'candle-minutes', unit };
  }
  const period = UPBIT_PERIODS[interval];
  if (!period) {
    throw new Error(
      `get_candles: interval='${interval}' 은 지원하지 않습니다 — ` +
      `${[...Object.keys(UPBIT_MINUTE_UNITS), ...Object.keys(UPBIT_PERIODS)].join(', ')} 중 하나.`);
  }
  return { ...out, action: period };
}


// Upbit names OHLCV its own way and answers newest-first. Everything downstream — the analyser,
// the backtest, the chart — reads one shape, so the translation belongs to the module that speaks
// the dialect, exactly as it does for the stock brokers. Without it every bar is silently dropped:
// the analyser looks for `close`, finds `trade_price`, and reports a series of length zero.
const UPBIT_CANDLE_MAP = [
  ['candle_date_time_kst', 'date'], ['opening_price', 'open'], ['high_price', 'high'],
  ['low_price', 'low'], ['trade_price', 'close'], ['candle_acc_trade_volume', 'volume'],
];

function normalizeUpbitCandles(rows) {
  if (!Array.isArray(rows)) return rows;
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('trade_price' in row)) continue;
    const bar = { ...row };
    for (const [from, to] of UPBIT_CANDLE_MAP) {
      if (from in bar) {
        bar[to] = to === 'date' ? String(bar[from]).replace('T', ' ') : Number(bar[from]);
        delete bar[from];
      }
    }
    out.push(bar);
  }
  // Oldest first. A series handed over backwards makes every crossing fire the wrong way round,
  // and nothing downstream can tell that from a strategy that simply loses.
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}



// ── The screen ───────────────────────────────────────────────────────────────────────────────
// There is no saved condition to run here the way a stock broker has one, but a single public
// call answers every pair in a market with its 24-hour turnover — and "the most traded names
// right now" is a screen. Ranking is done here rather than by the caller for the same reason the
// order dialect is: a model that picks the names can pick names that do not exist.
/** Pairs the exchange has flagged. Ranking by turnover finds these first, by construction.
 *
 * One of the caution flags is literally "trading volume soaring", so a screen that sorts on
 * 24-hour turnover surfaces a pair under investigation ahead of everything healthy. The exchange
 * publishes the flags; not reading them would mean the screen actively prefers them.
 */
function flaggedPairs(rows) {
  const out = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const ev = r && r.market_event;
    if (!ev) continue;
    const caution = ev.caution && typeof ev.caution === 'object'
      ? Object.values(ev.caution).some(Boolean) : false;
    if (ev.warning === true || caution) out.add(r.market);
  }
  return out;
}

function screenTickers(rows, opts) {
  const top = Math.max(1, Math.min(Number(opts.top) || 10, 50));
  const minTurnover = Number(opts.minTurnover) || 0;
  const flagged = opts.flagged instanceof Set ? opts.flagged : new Set();
  const ranked = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object' && Number.isFinite(Number(r.acc_trade_price_24h)))
    .filter(r => Number(r.acc_trade_price_24h) >= minTurnover)
    .filter(r => !flagged.has(r.market))
    .sort((a, b) => Number(b.acc_trade_price_24h) - Number(a.acc_trade_price_24h))
    .slice(0, top);
  return {
    excluded: [...flagged],
    symbols: ranked.map(r => r.market),
    rows: ranked.map(r => ({
      symbol: r.market,
      turnover24h: Number(r.acc_trade_price_24h),
      price: Number(r.trade_price),
      // Signed, so a caller can tell a name that is up from one that is down. `change_rate` is
      // the absolute value and would read as a rise on the way down.
      changeRate: Number(r.signed_change_rate),
    })),
  };
}

// ── Standard order contract ──────────────────────────────────────────────────────────────────
// The same neutral shape the stock brokers answer, so one pipeline places orders at either.
//
// Three things here invert silently and are written down once:
//   * `bid` is buy and `ask` is sell — nothing in the words says which.
//   * A market BUY is `ord_type=price` and its `price` is the TOTAL to spend, not a unit price.
//     A market SELL is `ord_type=market` and carries `volume` instead. The same field name means
//     two different quantities depending on the side.
//   * Fees differ by the market's quote currency: 0.05% on KRW pairs, 0.25% on BTC and USDT.
//     A backtest costed at the KRW rate is wrong by five times on a BTC pair.
const UPBIT_SIDE = { buy: 'bid', sell: 'ask' };
const UPBIT_FEE_RATE = { KRW: 0.0005, BTC: 0.0025, USDT: 0.0025 };

function upbitFeeRate(market) {
  return UPBIT_FEE_RATE[String(market ?? '').split('-')[0].toUpperCase()] ?? 0.0025;
}


/** The price step a market accepts, computed from the published ladder.
 *
 * The exchange also states it outright — `orderbook/instruments` returns `tick_size` per market —
 * and that is the authority when the two disagree. This exists so placing an order costs one call
 * instead of two; `get_tick_size` asks the exchange when it matters.
 *
 *
 * Nobody calling `place_order` should have to know the ladder, and a strategy that computed
 * "3% below the bid" will land off it almost every time — so the price is floored to the step
 * here. Floored, never rounded up: rounding up a buy spends more than the caller asked for.
 */
function upbitTickSize(price) {
  if (!(price > 0)) throw new Error('place_order: price 는 0보다 커야 합니다.');
  if (price < 0.00001) return 1e-8;
  const decade = Math.floor(Math.log10(price));
  if (decade < 3) return Math.pow(10, decade - 2);
  if (decade >= 6) return 1000;
  const base = Math.pow(10, decade - 3);
  const leading = price / Math.pow(10, decade);
  return Math.min(base * (leading >= 5 ? 5 : 1), 1000);
}

function upbitRoundPrice(price) {
  const tick = upbitTickSize(price);
  // Integer arithmetic where the tick is whole, so 159399000 does not come back as 159398999.99.
  if (tick >= 1) return Math.floor(price / tick) * tick;
  const scale = Math.round(1 / tick);
  return Math.floor(price * scale) / scale;
}

/** A number written out in full.
 *
 * `String(0.00000001)` is "1e-8", and no exchange parses that — it is the smallest lot Upbit
 * accepts, so the one quantity most likely to be written in exponent form is also a legal order.
 * Trailing zeros go, because "0.00142857000" is uglier than it needs to be and some venues count
 * the decimals.
 */
function plainNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = String(n);
  // `String` already gives the shortest text that round-trips, so use it whenever it is not in
  // exponent form. Reaching for toFixed unconditionally re-introduces the binary noise it is
  // supposed to avoid — 256410.25641 comes back as 256410.256410000002.
  if (!/e/i.test(s)) return s;
  return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

function upbitOrderParams(data) {
  const market = String(data.symbol ?? data.market ?? '').trim();
  if (!market) throw new Error('place_order: symbol 이 필요합니다 (예: KRW-BTC).');
  const side = UPBIT_SIDE[String(data.side ?? '').toLowerCase()];
  if (!side) throw new Error("place_order: side 는 'buy' 또는 'sell' 이어야 합니다.");
  const type = String(data.orderType ?? 'limit').toLowerCase();
  const qty = Number(data.qty);
  const price = Number(data.price);
  const amount = Number(data.amount);

  // The caller's own id, carried to the exchange. It is unique per account and can never be
  // reused, which is exactly what makes a resend safe: the second attempt is refused by the
  // exchange rather than becoming a second position. Our order key is already that value.
  const identifier = String(data.clientOrderId ?? data.identifier ?? '').trim().slice(0, 64);
  const withId = (o) => (identifier ? { ...o, identifier } : o);

  if (type === 'limit') {
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('place_order: 지정가에는 qty 가 필요합니다.');
    if (!Number.isFinite(price) || price <= 0) throw new Error('place_order: 지정가에는 price 가 필요합니다.');
    return withId({ market, side, ord_type: 'limit', volume: plainNum(qty),
                    price: plainNum(upbitRoundPrice(price)) });
  }
  if (type !== 'market') {
    throw new Error(`place_order: orderType='${type}' 은 지원하지 않습니다 — limit, market.`);
  }
  if (side === 'bid') {
    // Total to spend. `qty * price` is accepted as a convenience, but one of them must be there:
    // a market buy with a unit price and no total is the mistake this branch exists to refuse.
    const total = Number.isFinite(amount) && amount > 0
      ? amount
      : (Number.isFinite(qty) && Number.isFinite(price) ? qty * price : NaN);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('place_order: 시장가 매수에는 `amount`(총 금액)가 필요합니다 — 업비트의 '
        + '시장가 매수는 수량이 아니라 쓸 금액으로 냅니다.');
    }
    return withId({ market, side, ord_type: 'price', price: plainNum(Math.floor(total)) });
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('place_order: 시장가 매도에는 qty 가 필요합니다.');
  }
  return withId({ market, side, ord_type: 'market', volume: plainNum(qty) });
}

function upbitQueryParams(action, data) {
  const market = String(data.symbol ?? data.market ?? '').trim();
  if (action === 'list_open_orders') {
    const p = { states: ['wait', 'watch'] };
    if (market) p.market = market;
    return { action: 'order-list-open', params: p };
  }
  if (action === 'list_fills') {
    const p = { states: ['done', 'cancel'] };
    if (market) p.market = market;
    if (data.limit) p.limit = data.limit;
    return { action: 'order-list-closed', params: p };
  }
  return { action: 'accounts', params: {} };
}

const UPBIT_STANDARD = ['place_order', 'cancel_order', 'list_open_orders', 'list_fills',
                        'get_balance'];
/** The read half of the contract — these answer with a list, and every broker names it `rows`. */
const NEUTRAL_QUERIES = ['list_open_orders', 'list_fills', 'get_balance'];

async function main(input) {
  const wantsCandles = Boolean(input && input.action === 'get_candles');
  // The exchange's own answer for the price step, for when the computed ladder is not enough.
  if (input && input.action === 'get_tick_size') {
    input = { ...input, action: 'orderbook-instruments',
              markets: String(input.symbol ?? input.markets ?? '').trim() };
  }
  const wantsScreen = Boolean(input && input.action === 'screen');
  const screenTop = wantsScreen ? input.top : undefined;
  const screenMin = wantsScreen ? input.minTurnover : undefined;
  const screenIncludeFlagged = wantsScreen ? input.includeFlagged : undefined;
  if (wantsScreen) {
    input = { ...input, action: 'ticker-all',
              quote_currencies: String(input.quote ?? 'KRW').toUpperCase() };
  }
  const neutral = input && UPBIT_STANDARD.includes(input.action) ? input.action : null;
  if (neutral) {
    try {
      if (neutral === 'place_order') {
        const params = upbitOrderParams(input);
        // No paper account exists here, but the exchange will validate an order without placing
        // it. That is the rung between a backtest and real money — `mock` sends the same order to
        // the validator, so the shape is proven by the exchange rather than by us.
        const action = input.mock === true ? 'order-test' : 'order-create';
        input = { ...input, ...params, action, _feeRate: upbitFeeRate(params.market) };
      } else if (neutral === 'cancel_order') {
        const uuid = String(input.brokerOrderNo ?? input.uuid ?? '').trim();
        const identifier = String(input.clientOrderId ?? '').trim();
        if (!uuid && !identifier) {
          throw new Error('cancel_order: brokerOrderNo(uuid) 또는 clientOrderId 가 필요합니다.');
        }
        input = { ...input, action: 'order-cancel',
                  ...(uuid ? { uuid } : { identifier }) };
      } else {
        const mapped = upbitQueryParams(neutral, input);
        input = { ...input, ...mapped.params, action: mapped.action };
      }
    } catch (e) {
      console.log(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }
  if (wantsCandles) {
    try {
      input = normalizeCandleRequest(input);
    } catch (e) {
      console.log(JSON.stringify({ success: false, error: e.message }));
      return;
    }
  }
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
        outErr('error.unknown_action', { action: String(action) });
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
    let data = await callApi(method, endpoint, params, accessKey, secretKey, needAuth);
    // Only the neutral request is translated. The raw candle-* actions keep answering exactly what
    // the exchange said, because something is already reading them that way.
    if (wantsCandles) {
      // One call answers 200 bars. A scalping rule measured on 200 five-minute bars is measured
      // on sixteen hours, which is not a measurement — so `bars` pages backwards until it has
      // what was asked for. The exchange's own `to` cursor does the paging; nothing about this
      // needs a library, and adding one to a sandboxed module to get a loop would be a poor
      // trade. Capped, and it stops early when history runs out rather than looping forever.
      const want = Math.min(Math.max(Number(input.bars) || 0, 0), MAX_PAGED_BARS);
      data = normalizeUpbitCandles(data);
      if (want > data.length) {
        let cursor = data.length ? data[0].date : null;
        let pages = 0;
        while (cursor && data.length < want) {
          // The candle group allows ten calls a second across every caller on this IP, and this
          // loop is not the only one asking. Pacing it costs a few seconds on a long history and
          // avoids a 429 that would drop the whole series — found by tripping it.
          if (pages++) await new Promise(r => setTimeout(r, 120));
          const page = await callApi(method, endpoint,
            { ...params, to: `${String(cursor).replace(' ', 'T')}+09:00` },
            accessKey, secretKey, needAuth);
          const rows = normalizeUpbitCandles(page);
          // History ran out, or the exchange refused. Either way, return what was gathered —
          // a short series the caller can see is better than an error that loses all of it.
          if (!rows.length) break;
          const before = data.length;
          // Merge on the timestamp: the cursor bar comes back on the next page too.
          const seen = new Set(data.map(r => r.date));
          data = [...rows.filter(r => !seen.has(r.date)), ...data];
          if (data.length === before) break;   // no progress — stop rather than spin
          cursor = rows[0].date;
        }
        data = data.slice(-want);
      }
    }
    if (wantsScreen) {
      // A second call, deliberately: the flags live on the pair list, not on the ticker, and a
      // screen that cannot see them would rank a flagged pair first.
      let flagged = new Set();
      if (screenIncludeFlagged !== true) {
        try {
          flagged = flaggedPairs(await callApi('GET', '/v1/market/all',
            { is_details: 'true' }, accessKey, secretKey, false));
        } catch {
          // Better to screen without the filter than to return nothing; the caller is told.
          flagged = new Set();
        }
      }
      const picked = screenTickers(data, { top: screenTop, minTurnover: screenMin, flagged });
      console.log(JSON.stringify({ success: true, data: {
        action: 'screen', endpoint,
        symbols: picked.symbols, records: picked.rows, count: picked.symbols.length,
        excludedFlagged: picked.excluded.length,
        note: ('24시간 누적 거래대금 상위입니다 — 이 목록이 곧 화면입니다. '
               + '거래소가 유의·주의로 표시한 종목은 제외했습니다(거래량 급등 경보가 있어, '
               + '거래대금 순 정렬은 그런 종목을 먼저 집습니다). '
               + '조회 결과가 비면 목록을 비우지 말고 직전 것을 유지하세요.'),
      } }));
      return;
    }

    console.log(JSON.stringify({
      success: true,
      data: {
        action: neutral || action || 'direct',
        apiAction: action || 'direct',
        endpoint,
        ...(neutral === 'place_order'
          ? { clientOrderId: input.clientOrderId ?? null, sentParams: params,
              feeRate: input._feeRate, validatedOnly: input.action === 'order-test' }
          : {}),
        ...( Array.isArray(data) ? { records: data, count: data.length } : data ),
        // The neutral queries answer under the neutral name. `records` is this module's own
        // convention for a list and stays, but a caller written against the contract must not
        // have to know that one broker says `rows` and another says `records` — that knowledge
        // is exactly what the contract exists to remove, and a pipeline reading `.rows` worked
        // on kiwoom and resolved to nothing here.
        ...( NEUTRAL_QUERIES.includes(neutral) && Array.isArray(data) ? { rows: data } : {} ),
      },
    }));
  } catch (err) {
    if (err instanceof I18nError) outErr(err.errorKey, err.errorParams);
    else outErr('error.runtime', { message: err.message });
    process.exit(1);
  }
}

export { main };

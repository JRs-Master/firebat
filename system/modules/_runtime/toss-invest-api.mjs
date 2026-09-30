/**
 * Toss Securities dialect — shared by the two modules that speak it.
 *
 * The split is not about code. It is about which actions a caller can reach and which credentials
 * the process is handed. Lives outside both because neither owns it; `_runtime` has no
 * config.json, so the module scan skips it.
 */
// This import sat INSIDE the docblock above (an insert-at-line-2 slip), so the file parsed and
// every call died at the first rate slot with "acquireShared is not defined" — but only once
// credentials existed, which is why the module looked fine locally and in a keyless dry run.
// Found 2026-08-08 by the all-services sweep; nothing routinely calls Toss, so it sat latent.
import { acquireSlot as acquireShared } from './rate-window.mjs';
const BASE = 'https://openapi.tossinvest.com';

// action → { method, path, query[], pathParams[], body[], needsAccount, name }
// {x} in path is filled from pathParams. query = GET query string, body = POST JSON body
// (field names = data keys). needsAccount=true sends accountSeq(data) as X-Tossinvest-Account.
const API_TABLE = {
  // ── Market Data ── (token only)
  'orderbook':      { method: 'GET', path: '/api/v1/orderbook',    query: ['symbol'], name: '호가 조회' },
  'prices':         { method: 'GET', path: '/api/v1/prices',       query: ['symbols'], name: '현재가 조회' },
  'trades':         { method: 'GET', path: '/api/v1/trades',       query: ['symbol', 'count'], name: '최근 체결 내역' },
  'price-limits':   { method: 'GET', path: '/api/v1/price-limits', query: ['symbol'], name: '상/하한가' },
  'candles':        { method: 'GET', path: '/api/v1/candles',      query: ['symbol', 'interval', 'count', 'before', 'adjusted'], name: '캔들 차트' },
  // ── Stock Info ── (token only)
  'stocks':         { method: 'GET', path: '/api/v1/stocks',       query: ['symbols'], name: '종목 기본 정보' },
  'stock-warnings': { method: 'GET', path: '/api/v1/stocks/{symbol}/warnings', pathParams: ['symbol'], name: '매수 유의사항' },
  // ── Market Info ── (token only)
  'exchange-rate':  { method: 'GET', path: '/api/v1/exchange-rate', query: ['baseCurrency', 'quoteCurrency', 'dateTime'], name: '환율' },
  'market-calendar':{ method: 'GET', path: '/api/v1/market-calendar/{market}', pathParams: ['market'], query: ['date'], name: '장 운영 정보' },
  // ── Account ── (token only — the accountSeq entry point)
  'accounts':       { method: 'GET', path: '/api/v1/accounts', name: '계좌 목록' },
  // ── Asset ── (needs accountSeq)
  'holdings':       { method: 'GET', path: '/api/v1/holdings', query: ['symbol'], needsAccount: true, name: '보유 주식' },
  // ── Order History ── (needs accountSeq)
  'list-orders':    { method: 'GET', path: '/api/v1/orders', query: ['status', 'symbol', 'from', 'to', 'cursor', 'limit'], needsAccount: true, name: '주문 목록' },
  'order-detail':   { method: 'GET', path: '/api/v1/orders/{orderId}', pathParams: ['orderId'], needsAccount: true, name: '주문 상세' },
  // ── Order Info ── (needs accountSeq)
  'buying-power':       { method: 'GET', path: '/api/v1/buying-power', query: ['currency'], needsAccount: true, name: '매수 가능 금액' },
  'sellable-quantity':  { method: 'GET', path: '/api/v1/sellable-quantity', query: ['symbol'], needsAccount: true, name: '판매 가능 수량' },
  'commissions':        { method: 'GET', path: '/api/v1/commissions', needsAccount: true, name: '매매 수수료' },
  // ── Order (REAL trades — sent immediately) ── (needs accountSeq)
  'create-order':   { method: 'POST', path: '/api/v1/orders', body: ['clientOrderId', 'symbol', 'side', 'orderType', 'quantity', 'orderAmount', 'price', 'timeInForce', 'confirmHighValueOrder'], needsAccount: true, name: '주문 생성' },
  'modify-order':   { method: 'POST', path: '/api/v1/orders/{orderId}/modify', pathParams: ['orderId'], body: ['orderType', 'quantity', 'price', 'confirmHighValueOrder'], needsAccount: true, name: '주문 정정' },
  'cancel-order':   { method: 'POST', path: '/api/v1/orders/{orderId}/cancel', pathParams: ['orderId'], body: [], needsAccount: true, name: '주문 취소' },
  // ── Ranking ── (token only)
  'rankings':       { method: 'GET', path: '/api/v1/rankings', query: ['type', 'marketCountry', 'duration', 'excludeInvestmentCaution', 'count'], name: '주식 랭킹' },
  // ── Market Indicators ── (token only — fixed 8 symbols: KOSPI/KOSDAQ/KR_BOND_2Y~30Y)
  'market-indicator-prices':  { method: 'GET', path: '/api/v1/market-indicators/prices', query: ['symbols'], name: '시장 지표 현재가' },
  'market-indicator-candles': { method: 'GET', path: '/api/v1/market-indicators/{symbol}/candles', pathParams: ['symbol'], query: ['interval', 'count', 'before'], name: '시장 지표 캔들' },
  'investor-trading':         { method: 'GET', path: '/api/v1/market-indicators/{symbol}/investor-trading', pathParams: ['symbol'], query: ['interval', 'count', 'until'], name: '투자자별 매매대금' },
  // ── Conditional Order (REAL reserved trades — the broker's server watches the price, watching starts at registration) ── (needs accountSeq)
  'create-conditional-order': { method: 'POST', path: '/api/v1/conditional-orders', body: ['symbol', 'type', 'quantity', 'orderType', 'expireDate', 'first', 'second', 'clientOrderId', 'confirmHighValueOrder'], needsAccount: true, name: '조건주문 생성' },
  'modify-conditional-order': { method: 'POST', path: '/api/v1/conditional-orders/{conditionalOrderId}/modify', pathParams: ['conditionalOrderId'], body: ['type', 'quantity', 'orderType', 'expireDate', 'first', 'second', 'confirmHighValueOrder'], needsAccount: true, name: '조건주문 수정' },
  'cancel-conditional-order': { method: 'DELETE', path: '/api/v1/conditional-orders/{conditionalOrderId}', pathParams: ['conditionalOrderId'], needsAccount: true, name: '조건주문 취소' },
  // ── Conditional Order History ── (needs accountSeq)
  'list-conditional-orders':  { method: 'GET', path: '/api/v1/conditional-orders', query: ['status', 'symbol', 'cursor', 'limit'], needsAccount: true, name: '조건주문 목록' },
  'conditional-order-detail': { method: 'GET', path: '/api/v1/conditional-orders/{conditionalOrderId}', pathParams: ['conditionalOrderId'], needsAccount: true, name: '조건주문 상세' },
};

// Toss counts per rate-limit group and reports the allowance in response headers; a conservative
// shared throttle plus 429 retry (honouring Retry-After) covers it until a group actually bites.
// The window is the shared one, in a file: the array that used to be here was per process, and a
// scheduled cycle is a dozen of them.
const RATE_LIMIT = 10;
const WINDOW_MS = 1000;
const acquireSlot = () => acquireShared('toss', RATE_LIMIT, WINDOW_MS);

async function callApi(token, action, data, retry = 2) {
  const meta = API_TABLE[action];
  if (!meta) throw new Error(`알 수 없는 action: ${action}. 토스증권 Open API 문서 참조.`);

  // fill path params
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
  // POST — collect body fields from data into JSON (body:[] sends an empty object); decimals and strings pass through untouched.
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
  // 204 No Content = success without body (conditional order cancel).
  if (resp.status === 204) return { _ok: true, result: { canceled: true } };

  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    // Toss error envelopes: API = {error:{requestId,code,message,data}} / OAuth = {error, error_description}.
    const e = json && json.error;
    let code, msg;
    if (e && typeof e === 'object') { code = e.code; msg = e.message || e.code || `HTTP ${resp.status}`; }
    else if (typeof e === 'string') { code = e; msg = json.error_description || e; }
    else msg = `HTTP ${resp.status} ${resp.statusText}`;
    return { _ok: false, _status: resp.status, _code: code, _error: msg };
  }
  // success envelope: {result: ...}
  return { _ok: true, result: json && json.result !== undefined ? json.result : json };
}

// ── Neutral contract ─────────────────────────────────────────────────────────────────────────
// The five calls every trading module answers in one shape — place_order · cancel_order ·
// list_open_orders · list_fills · get_balance — so autotrade can trade here without knowing
// Toss's own names. Rows come back as `data.rows` with the field names autotrade already reads
// (orderId · symbol · quantity · avgPrice · filledQuantity · paid_fee).
const NEUTRAL = new Set(['place_order', 'cancel_order', 'list_open_orders', 'list_fills', 'get_balance']);

// US fractional trading, as the spec (1.2.19) states it: a fractional BUY is an amount order
// (`orderAmount`, dollars, MARKET only), a fractional SELL is a MARKET order with a fractional
// `quantity` (6 decimals at most), and both are accepted only from the regular open until one
// hour before the regular close.
const FRACTION_DP = 6;
const MIN_AMOUNT_USD = 1;

/** "us" | "kr" — from the call, else from the symbol's shape (6 characters led by a digit = Seoul). */
function marketOf(data, symbol) {
  const m = String(data.market ?? '').trim().toLowerCase();
  if (m === 'us' || m === 'kr') return m;
  return /^[0-9][0-9A-Z]{5}$/.test(String(symbol || '')) ? 'kr' : 'us';
}

/** A row's market, read off the row — holdings say `marketCountry`, orders only a currency. */
function rowMarket(row) {
  const c = String(row?.marketCountry ?? '').toUpperCase();
  if (c === 'US' || c === 'KR') return c.toLowerCase();
  const cur = String(row?.currency ?? '').toUpperCase();
  return cur === 'USD' ? 'us' : cur === 'KRW' ? 'kr' : '';
}

/** Down to `dp` decimals, never up — selling one unit more than is held is refused. The small
 * epsilon only absorbs binary representation (0.111283 × 1e6 = 111282.99999999999). */
function floorDecimal(n, dp) {
  const f = Math.pow(10, dp);
  const v = Math.floor(n * f + 1e-7) / f;
  return v.toFixed(dp).replace(/\.?0+$/, '');
}

/** US limit prices: two decimals from $1, four below, truncated (the spec's rule). KR: whole won. */
function priceText(market, price) {
  if (market === 'kr') return String(Math.round(price));
  return floorDecimal(price, price >= 1 ? 2 : 4);
}

/** Toss takes 36 chars of [A-Za-z0-9_-]. A key that already fits goes through unchanged, so the
 * same order key is the same idempotency key; anything else is hashed to one that does. */
async function clientIdOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (/^[A-Za-z0-9_-]{1,36}$/.test(s)) return s;
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

const accountCache = new Map();

/** The account a neutral call runs on: `accountSeq` if given, else the alias (`accountNo` or
 * `accountSeq`) matched against the account list, else the only account there is. */
async function accountSeqOf(token, data) {
  if (data.accountSeq !== undefined && data.accountSeq !== null && data.accountSeq !== '') return data.accountSeq;
  const alias = String(data.account ?? '').trim();
  if (accountCache.has(alias)) return accountCache.get(alias);
  const res = await callApi(token, 'accounts', {});
  if (!res._ok) throw new Error(`accounts: ${res._error}`);
  const list = Array.isArray(res.result) ? res.result : [];
  let hit = null;
  if (alias) hit = list.find(a => String(a?.accountNo) === alias || String(a?.accountSeq) === alias) || null;
  else if (list.length === 1) hit = list[0];
  if (!hit) {
    throw new Error(alias
      ? `계좌 '${alias}' 를 찾지 못했습니다 — accounts 응답의 accountNo 또는 accountSeq 로 적어 주세요.`
      : `계좌가 ${list.length}개라 고를 수 없습니다 — account 에 accountNo 또는 accountSeq 를 적어 주세요.`);
  }
  accountCache.set(alias, hit.accountSeq);
  return hit.accountSeq;
}

const lower = v => String(v ?? '').toLowerCase();

/** A Toss order row, in the neutral vocabulary. */
function orderRow(o) {
  const ex = o?.execution || {};
  return {
    orderId: o?.orderId, symbol: o?.symbol, side: lower(o?.side), status: o?.status,
    orderType: lower(o?.orderType), quantity: o?.quantity, orderAmount: o?.orderAmount,
    price: o?.price, currency: o?.currency, orderedAt: o?.orderedAt,
    filledQuantity: ex.filledQuantity ?? null,
  };
}

// Statuses after which an order's fill total no longer changes.
const DONE = new Set(['FILLED', 'CANCELED', 'REJECTED', 'REPLACED', 'CANCEL_REJECTED', 'REPLACE_REJECTED']);

/** An order's executions, restated as its running total — Toss has no per-execution id, so the
 * row is the order saying how much of it has filled so far. `orderDone` marks a total that will
 * not grow again: an amount order's filled quantity is whatever the dollars bought, so the order's
 * own requested quantity cannot say when it is complete. */
function fillRow(o) {
  const ex = o?.execution || {};
  const qty = Number(ex.filledQuantity);
  if (!(qty > 0)) return null;
  return {
    orderId: o.orderId, symbol: o.symbol, side: lower(o.side), status: o.status,
    filledQuantity: ex.filledQuantity, avgPrice: ex.averageFilledPrice,
    filledAmount: ex.filledAmount, paid_fee: ex.commission ?? '0',
    filledAt: ex.filledAt ?? null, currency: o.currency, orderDone: DONE.has(String(o.status)),
  };
}

/** Seoul date `daysAgo` days back — list-orders filters by the order's creation date in KST. */
function kstDate(daysAgo) {
  const t = new Date(Date.now() + 9 * 3600e3 - daysAgo * 86400e3);
  return t.toISOString().slice(0, 10);
}

async function listOrders(token, accountSeq, status, extra = {}) {
  const out = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await callApi(token, 'list-orders', { accountSeq, status, ...extra, ...(cursor ? { cursor } : {}) });
    if (!res._ok) throw new Error(`list-orders(${status}): ${res._error}`);
    const r = res.result || {};
    out.push(...(Array.isArray(r.orders) ? r.orders : []));
    if (status !== 'CLOSED' || !r.hasNext || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

async function neutral(token, action, data) {
  const accountSeq = await accountSeqOf(token, data);
  const wantMarket = data.market ? lower(data.market) : '';
  const inMarket = row => !wantMarket || !rowMarket(row) || rowMarket(row) === wantMarket;
  const symbolFilter = data.symbol ? { symbol: String(data.symbol) } : {};

  if (action === 'get_balance') {
    const res = await callApi(token, 'holdings', { accountSeq, ...symbolFilter });
    if (!res._ok) return { success: false, error: res._error, data: { action, status: res._status, code: res._code } };
    const items = Array.isArray(res.result?.items) ? res.result.items : [];
    const rows = items.filter(inMarket).map(i => ({
      symbol: i.symbol, name: i.name, quantity: i.quantity, avgPrice: i.averagePurchasePrice,
      lastPrice: i.lastPrice, currency: i.currency, marketCountry: i.marketCountry,
      purchaseAmount: i.marketValue?.purchaseAmount, marketValue: i.marketValue?.amount,
      profitRate: i.profitLoss?.rate,
    }));
    return { success: true, data: { action, rows, rowsField: 'result.items', accountSeq } };
  }

  if (action === 'list_open_orders') {
    const orders = await listOrders(token, accountSeq, 'OPEN', symbolFilter);
    return { success: true, data: { action, rows: orders.filter(inMarket).map(orderRow), rowsField: 'result.orders', accountSeq } };
  }

  if (action === 'list_fills') {
    // Closed orders from the last few Seoul days, plus open ones already partly filled. The
    // window is wider than any order the ledger still waits on, and a row seen twice is a
    // restatement, not a second fill.
    const since = { from: String(data.from || kstDate(3)), ...symbolFilter };
    const closed = await listOrders(token, accountSeq, 'CLOSED', { ...since, limit: 100 });
    const open = await listOrders(token, accountSeq, 'OPEN', symbolFilter);
    const rows = [...closed, ...open].filter(inMarket).map(fillRow).filter(Boolean);
    return { success: true, data: { action, rows, rowsField: 'result.orders[].execution', accountSeq } };
  }

  if (action === 'cancel_order') {
    const orderId = String(data.brokerOrderNo ?? data.orderId ?? '').trim();
    if (!orderId) throw new Error('cancel_order: brokerOrderNo 가 필요합니다 (주문 응답의 orderId).');
    const res = await callApi(token, 'cancel-order', { accountSeq, orderId });
    if (!res._ok) return { success: false, error: res._error, data: { action, status: res._status, code: res._code, orderId } };
    return { success: true, data: { action, orderId, ...(res.result && typeof res.result === 'object' ? res.result : {}) } };
  }

  // place_order
  const side = lower(data.side);
  if (side !== 'buy' && side !== 'sell') throw new Error("place_order: side 는 'buy' 또는 'sell' 이어야 합니다.");
  const symbol = String(data.symbol ?? '').trim();
  if (!symbol) throw new Error('place_order: symbol 이 필요합니다.');
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('place_order: qty 는 0 보다 커야 합니다.');
  const market = marketOf(data, symbol);
  const type = lower(data.orderType || 'limit');
  const whole = Math.abs(qty - Math.round(qty)) < 1e-9;
  const body = { symbol, side: side.toUpperCase() };
  const cid = await clientIdOf(data.clientOrderId);
  if (cid) body.clientOrderId = cid;
  if (whole) {
    body.quantity = String(Math.round(qty));
    if (type === 'market') {
      body.orderType = 'MARKET';
    } else {
      const price = Number(data.price);
      if (!(price > 0)) throw new Error('place_order: 지정가 주문에는 price 가 필요합니다.');
      body.orderType = 'LIMIT';
      body.price = priceText(market, price);
    }
  } else {
    if (market !== 'us') throw new Error('place_order: 소수점 수량은 미국 주식만 주문할 수 있습니다.');
    body.orderType = 'MARKET';
    if (side === 'sell') {
      body.quantity = floorDecimal(qty, FRACTION_DP);
      if (!(Number(body.quantity) > 0)) throw new Error(`place_order: 매도 수량 ${qty} 이 소수점 ${FRACTION_DP}자리 아래라 주문할 수 없습니다.`);
    } else {
      const price = Number(data.price);
      if (!(price > 0)) throw new Error('place_order: 소수점 매수는 금액 주문이라 price(현재가)가 필요합니다 — 금액 = qty × price.');
      const amount = Math.round(qty * price * 100) / 100;
      if (amount < MIN_AMOUNT_USD) throw new Error(`place_order: 금액 주문은 $${MIN_AMOUNT_USD} 이상이어야 합니다 (지금 $${amount.toFixed(2)}).`);
      body.orderAmount = amount.toFixed(2);
    }
  }
  const res = await callApi(token, 'create-order', { accountSeq, ...body });
  if (!res._ok) {
    return { success: false, error: res._error, data: { action, status: res._status, code: res._code, clientOrderId: data.clientOrderId ?? null, sentParams: body } };
  }
  return { success: true, data: { action, ...(res.result || {}), clientOrderId: data.clientOrderId ?? null, sentParams: body, market } };
}

async function main(data) {

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
    // Raw token issued and proactively refreshed by the infra TokenProvider, injected via env — the module only consumes it.
    const token = process.env['TOSS_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: '토스 액세스 토큰 미발급 — 인프라 토큰 발급 실패 또는 API Key/Secret Key 오류.' }));
      return;
    }

    if (NEUTRAL.has(action)) {
      let out;
      try { out = await neutral(token, action, data); }
      catch (e) { out = { success: false, error: e.message, data: { action } }; }
      console.log(JSON.stringify(out));
      return;
    }
    // The schema takes these case-insensitively (the neutral contract speaks lower case); Toss only
    // accepts upper case, so a raw call is lifted here rather than refused there.
    for (const k of ['side', 'orderType', 'market']) {
      if (typeof data[k] === 'string') data = { ...data, [k]: data[k].toUpperCase() };
    }
    const meta = API_TABLE[action];
    const res = await callApi(token, action, data);
    if (!res._ok) {
      const out = { success: false, error: res._error, data: { action, status: res._status } };
      if (res._code) out.data.code = res._code;
      console.log(JSON.stringify(out));
      return;
    }
    // Standard OHLCV normalization — rename Toss candle fields (timestamp/openPrice/…, string
    // values) to the cross-broker standard {date, open, high, low, close, volume} so stock_chart
    // dataCacheKey injection, the timeseries store, and cache_grep all speak one vocabulary
    // (yfinance/kiwoom/korea-invest mirror this). Field-signature detection (result.candles rows),
    // not an action gate — covers candles and market-indicator-candles alike. nextBefore passes through.
    if (res.result && Array.isArray(res.result.candles)) {
      const num = v => { const n = Number(v); return Number.isFinite(n) ? n : v; };
      for (const row of res.result.candles) {
        if (!row || typeof row !== 'object') continue;
        const ts = row.timestamp ?? row.dateTime ?? row.dt;
        if (ts !== undefined) { row.date = String(ts); delete row.timestamp; delete row.dateTime; delete row.dt; }
        if ('openPrice' in row) { row.open = num(row.openPrice); delete row.openPrice; }
        if ('highPrice' in row) { row.high = num(row.highPrice); delete row.highPrice; }
        if ('lowPrice' in row) { row.low = num(row.lowPrice); delete row.lowPrice; }
        if ('closePrice' in row) { row.close = num(row.closePrice); delete row.closePrice; }
        if ('volume' in row) row.volume = num(row.volume);
        else if ('tradingVolume' in row) { row.volume = num(row.tradingVolume); delete row.tradingVolume; }
      }
    }
    // Identity echo — a call that named one instrument answers with Toss's own name for it
    // FIRST (rows carry {symbol, name} — measured live 2026-08-17), so a symbol that drifted
    // from the conversation's lookup exposes itself where the caller reads.
    const identity = identityOf(data, res.result);
    console.log(JSON.stringify({ success: true, data: { ...(identity ? { identity } : {}), action, name: meta?.name, result: res.result } }));
}

/** "symbol = name", read off the reply itself. Only speaks when the call named exactly one
 * symbol and a reply row carries its name — a list where no row matches stays silent. */
function identityOf(data, result) {
  const raw = typeof data?.symbol === 'string' ? data.symbol : typeof data?.symbols === 'string' ? data.symbols : '';
  const wanted = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (wanted.length !== 1) return null;
  const rows = Array.isArray(result) ? result : Array.isArray(result?.stocks) ? result.stocks : Array.isArray(result?.prices) ? result.prices : null;
  const row = rows?.find(r => r && typeof r === 'object' && r.symbol === wanted[0] && typeof r.name === 'string' && r.name.trim());
  return row ? `${wanted[0]} = ${row.name.trim()}` : null;
}


export { main };

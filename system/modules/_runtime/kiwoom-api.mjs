/**
 * 키움증권 dialect — shared by the two modules that speak it.
 *
 * The split is not about code. It is about which actions a caller can reach and which credentials
 * the process is handed. Lives outside both because neither owns it; `_runtime` has no
 * config.json, so the module scan skips it.
 */

import { roundToKrxTick } from './krx-tick.mjs';
import { usOrderPrice } from './us-tick.mjs';
import { acquireSlot } from './rate-window.mjs';
const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// 토큰 발급·갱신은 인프라 TokenProvider 가 config.json 의 oauth 스펙으로 처리한다.
// sysmod 는 env 로 주입된 raw 토큰(KIWOOM_ACCESS_TOKEN)을 받아쓰기만 한다 — 토큰 코드 0.

// Kiwoom counts against the app key, and the practice domain is tighter than the live one — the
// same shape as Korea Investment, where live is five and practice is one. Five held on the live
// host and the practice host still answered 허용된 요청 개수를 초과 with the file window in place
// (2026-08-03), so the practice allowance is its own number and a conservative one: a cycle that
// takes a few seconds longer is not a cost, and a refused candle fetch kills the cycle.
//
// The window lives in a file because each step of a cycle is its own process — the array that used
// to hold it was empty on every call, so nothing was limited at all.
const RATE_LIMIT_REAL = 5;
const RATE_LIMIT_MOCK = 2;

// The continuation cursor the last response carried. Kiwoom paginates chart calls through the
// `cont-yn` / `next-key` header pair, and the body alone cannot say whether more exists — so the
// headers are kept here rather than discarded, and `fetchCandles` below is the only reader.
let LAST_CONT = { contYn: 'N', nextKey: '' };

/**
 * The row for one action, out of what dispatch injected. A neutral name resolves to one of
 * several vendor endpoints by market, side or interval, so its declaration carries them all and
 * the row is picked by id — the branch stays in the dialect, the endpoints stay in the
 * declaration.
 */
function metaOf(call, apiId) {
  if (!call || typeof call !== 'object') return null;
  if (call.id === apiId) return call;
  for (const v of Object.values(call)) if (v && typeof v === 'object' && v.id === apiId) return v;
  return null;
}

async function callApi(base, token, meta, apiId, params = {}, retry = 2, cont = null) {
  const path = meta?.path || '';
  if (!path) throw new Error(`알 수 없는 API ID: ${apiId} — 이 값을 지어내지 마세요. search_module_actions(query) 로 맞는 액션을 찾고 get_action_schema('kiwoom', action) 으로 파라미터를 확인하세요. 단순 시세·차트·과거 데이터는 yfinance(action='history')가 더 쉽습니다.`);
  const url = `${base}${path}`;
  const isMock = base.includes('mock');
  await acquireSlot(`kiwoom-${isMock ? 'mock' : 'real'}`,
                    isMock ? RATE_LIMIT_MOCK : RATE_LIMIT_REAL);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${token}`,
      'api-id': apiId,
      'cont-yn': cont?.contYn === 'Y' ? 'Y' : 'N',
      'next-key': cont?.nextKey || '',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, meta, apiId, params, retry - 1, cont);
  }
  LAST_CONT = {
    contYn: resp.headers.get('cont-yn') || 'N',
    nextKey: resp.headers.get('next-key') || '',
  };
  if (!resp.ok) {
    // 키움은 토큰 만료 등 일부 오류를 HTTP 4xx/5xx + JSON 바디(return_code/return_msg)로 준다.
    // 바디가 키움 에러 envelope 면 throw 말고 반환 → 상위 return_code 검사(인프라 reactive)가 토큰 무효를 감지.
    const errText = await resp.text().catch(() => '');
    try {
      const j = JSON.parse(errText);
      if (j && (j.return_code !== undefined || j.return_msg !== undefined)) return j;
    } catch { /* JSON 아님 — 아래 throw */ }
    throw new Error(`키움 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }
  // A 200 that is not JSON is usually the wrong host or an interstitial page, and
  // "Unexpected token '<'" says none of that. Report what came back instead.
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    const head = text.trim().slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`키움 API ${apiId}: 응답이 JSON 이 아닙니다 (HTTP ${resp.status}, ${url}) — ${head}`);
  }
}

// Standard OHLCV normalization — rename Kiwoom candle vocabulary (dt/cntr_tm/open_pric/high_pric/
// low_pric/cur_prc/trde_qty) to the cross-broker standard {date, open, high, low, close, volume} so
// stock_chart dataCacheKey injection, the timeseries store, and cache_grep all speak one vocabulary
// (yfinance already does). Field-signature detection (a row carrying a date field together with
// open_pric) — no per-action enum, so every chart/daily-price API normalizes uniformly.
// Values arrive as strings, sometimes signed ("+68000") — strip the sign (prices/volumes are absolute).
function kiwoomNum(v) {
  const n = Number(String(v ?? '').replace(/^[+\-]/, ''));
  return Number.isFinite(n) ? n : v;
}
function kiwoomDate(s) {
  s = String(s ?? '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{12,14}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12);
  return s;
}
const CANDLE_FIELD_MAP = [
  ['dt', 'date'], ['cntr_tm', 'date'],
  ['open_pric', 'open'], ['high_pric', 'high'], ['low_pric', 'low'],
  ['cur_prc', 'close'], ['trde_qty', 'volume'],
];
// Signed change against the previous session's close — `pred_pre` keeps its sign, unlike prices.
function kiwoomSigned(v) {
  const n = Number(String(v ?? '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}
function normalizeCandleRows(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const row of v) {
        if (!row || typeof row !== 'object') continue;
        if (!(('dt' in row || 'cntr_tm' in row) && 'open_pric' in row)) continue;
        // The previous session's official close, before the price keys are renamed.
        //
        // Every consumer wants this number and none of them can derive it: reading "the last bar of
        // the previous calendar day" out of a minute series gives an AFTER-HOURS print, because
        // `_AL` (SOR) covers NXT and NXT trades until 20:00. That is how SK Hynix came to show
        // +23.11% against 1,359,000 when the close was 1,322,000 (2026-07-31). The broker states it
        // on every candle as `pred_pre`; the module that knows that vocabulary converts it, so no
        // consumer has to guess at session hours.
        const chg = kiwoomSigned(row.pred_pre);
        const cur = Number(String(row.cur_prc ?? '').replace(/^[+\-]/, ''));
        if (chg !== null && Number.isFinite(cur)) {
          row.prevClose = cur - chg;
        }
        for (const [src, dst] of CANDLE_FIELD_MAP) {
          if (src in row) {
            row[dst] = dst === 'date' ? kiwoomDate(row[src]) : kiwoomNum(row[src]);
            if (src !== dst) delete row[src];
          }
        }
      }
    } else if (v && typeof v === 'object') {
      normalizeCandleRows(v, depth + 1);
    }
  }
}

// base_dt (chart endpoint's query end-date anchor) — the API semantics are "latest = today".
// Static bindings (page bake / scheduled pages) carry no date (a fixed one would go stale), so
// default an empty base_dt to today (KST) for chart-endpoint calls. Covers bake, rebake, and any
// model call that omits it — the module owns this "latest" dialect, not the caller.
function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}


// ── Standard order contract ──────────────────────────────────────────────────────────────────
// One neutral shape every broker accepts, translated here into this broker's own vocabulary.
//
// The alternative is the caller knowing that a buy is kt10000, that the exchange goes in
// `dmst_stex_tp`, and that a market order is trde_tp "3" — at which point adding a broker stops
// being a declaration and becomes an edit to whoever places orders. The dialect belongs to the
// module that speaks it.
//
// A client id rides along so a retry cannot become a second order: Kiwoom has no idempotency key
// of its own, so the caller's ledger is the only thing that can tell "sent twice" from "filled
// twice", and it needs the same id back to do it.
const ORDER_TRADE_TYPE = { limit: '0', market: '3', conditional: '5', best: '6', priority: '7' };
// The US side is a different family of endpoints with its own vocabulary: two-digit trade types,
// an exchange code rather than a domestic-exchange flag, and a separate account ledger. Same six
// neutral calls though — a strategy written for Seoul runs in New York by naming the market.
const US_TRADE_TYPE = { limit: '00', market: '03', loc: '30', moc: '33' };
const US_EXCHANGE = { NASD: 'ND', NASDAQ: 'ND', ND: 'ND', NYSE: 'NY', NY: 'NY',
                      AMEX: 'NA', NA: 'NA' };

function isUs(data) {
  const m = String(data.market ?? '').toLowerCase();
  if (m === 'us') return true;
  if (m === 'kr') return false;
  // Unstated: a six-digit code is a KRX listing and a ticker is not.
  return !/^\d{6}$/.test(String(data.symbol ?? '').trim());
}

function usStex(data, name) {
  const raw = String(data.stexTp ?? data.exchange ?? 'ND').toUpperCase();
  const code = US_EXCHANGE[raw];
  if (!code) throw new Error(`${name}: 미국 거래소 '${raw}' 는 지원하지 않습니다 — NASD, NYSE, AMEX.`);
  return code;
}

/**
 * Split a domestic code into the code an order takes and the book it belongs to.
 *
 * The exchange is a SUFFIX on quotes — `005930` is KRX alone, `_NX` is NXT, `_AL` is the two
 * combined — and the screener answers with it, so the suffix is how a symbol arrives. Orders do
 * not take it: `kt10000` refuses `000660_AL` with `1902: 종목 정보가 없습니다`, which is what four
 * live orders hit on 2026-08-04. The book it named is not lost though — it is the `dmst_stex_tp`
 * the same call already carries, so the suffix moves there rather than being dropped.
 *
 * An explicit `exchange` wins: the suffix is how a symbol was quoted, not an instruction.
 */
const STEX_BY_SUFFIX = { _AL: 'SOR', _NX: 'NXT' };
function krxSymbol(data) {
  const raw = String(data.symbol ?? '').trim();
  const at = raw.lastIndexOf('_');
  const suffix = at > 0 ? raw.slice(at) : '';
  const fromSuffix = STEX_BY_SUFFIX[suffix.toUpperCase()];
  // A practice account routes to KRX and nothing else: SOR is refused outright with
  // `RC9000: 모의투자에서는 해당업무가 제공되지 않습니다` (measured 2026-08-04, the order that got
  // past the symbol fix). Same shape as its request limit being 2/s where the live one is 5 — the
  // practice domain is a smaller venue, not the same venue with test money. Forced rather than
  // defaulted, because an explicit SOR there is a request the account cannot carry out.
  const stex = data.mock
    ? 'KRX'
    : String(data.exchange ?? fromSuffix ?? 'SOR').toUpperCase();
  return { code: fromSuffix ? raw.slice(0, at) : raw, stex };
}

function orderParams(data) {
  const { code: symbol, stex } = krxSymbol(data);
  const qty = Number(data.qty);
  if (!symbol) throw new Error('place_order: symbol 이 필요합니다 (예: "005930").');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('place_order: qty 는 1 이상이어야 합니다.');
  const type = String(data.orderType ?? 'limit').toLowerCase();
  const trde_tp = ORDER_TRADE_TYPE[type];
  if (!trde_tp) {
    throw new Error(`place_order: orderType='${type}' 은 지원하지 않습니다 — ${Object.keys(ORDER_TRADE_TYPE).join(', ')} 중 하나.`);
  }
  const price = Number(data.price);
  if (type === 'limit' && (!Number.isFinite(price) || price <= 0)) {
    throw new Error('place_order: 지정가 주문에는 price 가 필요합니다.');
  }
  const params = {
    // KRX / NXT / SOR — SOR routes across both, which is what a plain "buy this" means.
    dmst_stex_tp: stex,
    stk_cd: symbol,
    ord_qty: String(Math.trunc(qty)),
    trde_tp,
  };
  // A market order carries no unit price; sending one is rejected. A limit one has to sit on the
  // exchange's grid — truncating to an integer is not enough, and off-grid is refused outright.
  if (type !== 'market' && Number.isFinite(price) && price > 0) {
    params.ord_uv = String(roundToKrxTick(price, data.side));
  }
  if (data.conditionPrice) {
    params.cond_uv = String(roundToKrxTick(Number(data.conditionPrice), data.side));
  }
  return params;
}

function cancelParams(data) {
  const orderNo = String(data.brokerOrderNo ?? '').trim();
  if (!orderNo) throw new Error('cancel_order: brokerOrderNo 가 필요합니다 (주문 접수 응답의 주문번호).');
  const { code: symbol, stex } = krxSymbol(data);
  if (!symbol) throw new Error('cancel_order: symbol 이 필요합니다.');
  return {
    dmst_stex_tp: stex,
    orig_ord_no: orderNo,
    stk_cd: symbol,
    // "0" = whatever is left unfilled, which is what cancelling an order means.
    cncl_qty: data.qty ? String(Math.trunc(Number(data.qty))) : '0',
  };
}

/** Neutral action → { apiId, params }. Unknown side/action is refused rather than guessed. */
function standardOrder(action, data) {
  const us = isUs(data);
  if (action === 'cancel_order') {
    if (!us) return { apiId: 'kt10003', params: cancelParams(data) };
    const orderNo = String(data.brokerOrderNo ?? '').trim();
    const symbol = String(data.symbol ?? '').trim();
    if (!orderNo) throw new Error('cancel_order: brokerOrderNo 가 필요합니다.');
    if (!symbol) throw new Error('cancel_order: symbol 이 필요합니다.');
    return { apiId: 'ust20003', params: {
      orig_ord_no: orderNo, stex_tp: usStex(data, 'cancel_order'), stk_cd: symbol } };
  }
  const side = String(data.side ?? '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error("place_order: side 는 'buy' 또는 'sell' 이어야 합니다.");
  }
  if (!us) return { apiId: side === 'buy' ? 'kt10000' : 'kt10001', params: orderParams(data) };
  const symbol = String(data.symbol ?? '').trim();
  const qty = Number(data.qty);
  if (!symbol) throw new Error('place_order: symbol 이 필요합니다.');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('place_order: qty 는 1 이상이어야 합니다.');
  const type = String(data.orderType ?? 'limit').toLowerCase();
  const trde_tp = US_TRADE_TYPE[type];
  if (!trde_tp) {
    throw new Error(`place_order: orderType='${type}' 은 미국 주문에 없습니다 — ${Object.keys(US_TRADE_TYPE).join(', ')}.`);
  }
  const price = Number(data.price);
  if (type === 'limit' && !(price > 0)) {
    throw new Error('place_order: 지정가 주문에는 price 가 필요합니다.');
  }
  const params = {
    stk_cd: symbol, stex_tp: usStex(data, 'place_order'),
    ord_qty: String(Math.trunc(qty)), trde_tp,
  };
  // A market order there takes an empty unit price, not a zero and not the last trade. A limit one
  // has to fit the venue's decimals — `String(price)` sent 497.041665 and was refused outright
  // (1517, 2026-08-05). The KRX path had this from the start; the overseas path never did.
  params.ord_uv = type === 'market' ? '' : usOrderPrice(price, data.side);
  return { apiId: side === 'buy' ? 'ust20000' : 'ust20001', params };
}


// ── Standard account queries ─────────────────────────────────────────────────────────────────
// The read half of the neutral contract. Placing an order through `place_order` and then reading
// it back through `ka10075 {all_stk_tp:'0', trde_tp:'0', stex_tp:'0'}` would put the dialect right
// back in the caller — and this broker uses two different exchange vocabularies depending on the
// action (`stex_tp` 0/1/2 for order queries, `dmst_stex_tp` KRX/NXT for the balance). Whoever
// reconciles should not have to know that.
//
// Side coding is inverted from the obvious reading — 1 is sell, 2 is buy — which is exactly the
// kind of thing that silently returns the wrong half of the account. It is written down once here.
const QUERY_SIDE = { sell: '1', buy: '2' };
const STEX_TP = { SOR: '0', KRX: '1', NXT: '2' };
const DMST_STEX = { SOR: 'KRX', KRX: 'KRX', NXT: 'NXT' };

function sideCode(data) {
  const side = String(data.side ?? '').toLowerCase();
  if (!side) return '0'; // no side given = both, which is what reconciling an account wants
  const code = QUERY_SIDE[side];
  if (!code) throw new Error("side 는 'buy' 또는 'sell' 이어야 합니다 (생략하면 매수·매도 전체).");
  return code;
}

function exchangeOf(data, table, name) {
  const ex = String(data.exchange ?? 'SOR').toUpperCase();
  const code = table[ex];
  if (!code) throw new Error(`${name}: exchange='${ex}' 는 지원하지 않습니다 — KRX, NXT, SOR 중 하나.`);
  return code;
}

/** Neutral query → { apiId, params }. */
function standardQuery(action, data) {
  const symbol = String(data.symbol ?? '').trim();
  if (isUs(data)) {
    // The US ledger is its own set of endpoints; `stex_tp` may be left out to mean every exchange,
    // which is what reconciling an account wants when it is not asking about one symbol.
    const params = {};
    if (symbol) {
      params.stk_cd = symbol;
      params.stex_tp = usStex(data, action);
    }
    if (action === 'get_balance') {
      return { apiId: 'ust21070', params };
    }
    // 0 = both sides, which is what a reconciliation reads.
    params.slby_tp = { sell: '1', buy: '2' }[String(data.side ?? '').toLowerCase()] || '0';
    return { apiId: action === 'list_open_orders' ? 'ust21050' : 'ust21510', params };
  }
  if (action === 'list_open_orders') {
    const params = {
      all_stk_tp: symbol ? '1' : '0',
      trde_tp: sideCode(data),
      stex_tp: exchangeOf(data, STEX_TP, 'list_open_orders'),
    };
    if (symbol) params.stk_cd = symbol;
    return { apiId: 'ka10075', params };
  }
  if (action === 'list_fills') {
    const params = {
      qry_tp: symbol ? '1' : '0',
      sell_tp: sideCode(data),
      stex_tp: exchangeOf(data, STEX_TP, 'list_fills'),
    };
    if (symbol) params.stk_cd = symbol;
    // Paging runs backwards here: the broker returns executions OLDER than this order number.
    // Calling it `since` would read as "newer than", and a caller chasing new fills with it would
    // quietly get none of them.
    if (data.beforeOrderNo) params.ord_no = String(data.beforeOrderNo).trim();
    return { apiId: 'ka10076', params };
  }
  // Per-symbol rows, always: a summed balance cannot be compared against a per-symbol ledger.
  return {
    apiId: 'kt00018',
    params: { qry_tp: '2', dmst_stex_tp: exchangeOf(data, DMST_STEX, 'get_balance') },
  };
}

const STANDARD_QUERIES = ['list_open_orders', 'list_fills', 'get_balance'];

/** The one list in an account response, named by the response rather than by us.
 *
 * These endpoints answer with scalars plus a single row array, but the array's field name is not
 * documented and differs per endpoint. Taking the sole list needs no such name; when there is more
 * than one candidate nothing is picked and the names are reported, because a caller reconciling an
 * account would rather see "which of these two" than silently settle the wrong list.
 */
function pickRows(payload) {
  const arrays = Object.entries(payload).filter(([, v]) =>
    Array.isArray(v) && v.every(row => row && typeof row === 'object' && !Array.isArray(row)));
  if (!arrays.length) return null;
  const filled = arrays.filter(([, v]) => v.length > 0);
  const pick = filled.length === 1 ? filled[0] : (arrays.length === 1 ? arrays[0] : null);
  if (!pick) return { candidates: arrays.map(([k]) => k) };
  return { field: pick[0], rows: pick[1] };
}


// How many pages a single candle request may walk. One page is a few hundred bars, so this is
// thousands — far past any rule's window, and a stop in case the venue never says it is done.
const MAX_CANDLE_PAGES = 20;

/** One call, or as many as it takes to reach `want` bars. Returns the venue's own envelope. */
async function fetchCandles(base, token, meta, apiId, params, want) {
  const first = await callApi(base, token, meta, apiId, params);
  const target = Math.floor(Number(want) || 0);
  const picked = pickRows(first);
  if (target <= 0 || !picked?.field) return first;

  const field = picked.field;
  let rows = picked.rows;
  let cont = LAST_CONT;
  let pages = 1;
  // Kiwoom answers newest-first, so a later page is older bars: append, and the analyser sorts.
  while (rows.length < target && cont.contYn === 'Y' && cont.nextKey && pages < MAX_CANDLE_PAGES) {
    pages += 1;
    const next = await callApi(base, token, meta, apiId, params, 2, cont);
    cont = LAST_CONT;
    const more = pickRows(next);
    if (!more?.field || !more.rows.length) break;
    rows = rows.concat(more.rows);
  }
  // Trimmed to what was asked for. Handing back more is not free — every row travels through the
  // cache, the analyser and the backtest — and handing back a page boundary's worth of extra bars
  // makes two runs of the same rule disagree about how much history it saw.
  return { ...first, [field]: rows.slice(0, target), _pages: pages };
}


// ── Candles, by interval ─────────────────────────────────────────────────────────────────────
// Every timeframe is its own API here — minute bars are ka10080 with a tic_scope, daily is
// ka10081, weekly ka10082, monthly ka10083 — and the US chart set is a different family again.
// A caller that has to know which is which cannot switch a strategy from 5-minute to hourly
// without editing the call, and a strategy measured on one timeframe and traded on another is
// measuring something else entirely. So the interval is the argument and the dialect stays here.
const MINUTE_SCOPES = { '1m': '1', '3m': '3', '5m': '5', '10m': '10', '15m': '15',
                        '30m': '30', '45m': '45', '60m': '60', '1h': '60' };
const PERIOD_APIS = { '1d': 'ka10081', '1w': 'ka10082', '1M': 'ka10083', '1y': 'ka10094' };
const US_PERIOD_APIS = { '1d': 'usa06012', '1w': 'usa06013', '1M': 'usa06014', '1y': 'usa06015' };

function candleParams(action, data) {
  const symbol = String(data.symbol ?? '').trim();
  if (!symbol) throw new Error('get_candles: symbol 이 필요합니다.');
  const interval = String(data.interval ?? '1d').trim();
  const us = String(data.market ?? '').toLowerCase() === 'us' || Boolean(data.stexTp);
  const params = { stk_cd: symbol, upd_stkpc_tp: String(data.adjusted === false ? '0' : '1') };
  if (us) params.stex_tp = String(data.stexTp ?? 'ND');
  // A tick chart counts trades, not time — `100t` is a hundred-trade bar.
  const tick = /^(\d+)t$/i.exec(interval);
  if (tick) {
    params.tic_scope = tick[1];
    return { apiId: us ? 'usa06010' : 'ka10079', params };
  }
  const scope = MINUTE_SCOPES[interval];
  if (scope) {
    params.tic_scope = scope;
    return { apiId: us ? 'usa06011' : 'ka10080', params };
  }
  const apiId = (us ? US_PERIOD_APIS : PERIOD_APIS)[interval];
  if (!apiId) {
    throw new Error(
      `get_candles: interval='${interval}' 은 지원하지 않습니다 — ` +
      `${[...Object.keys(MINUTE_SCOPES), ...Object.keys(PERIOD_APIS), '100t'].join(', ')} 중 하나.`);
  }
  if (data.baseDate) params.base_dt = String(data.baseDate).replace(/-/g, '');
  return { apiId, params };
}

async function main(data) {

    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 키움 API ID (ka10001 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom 에서 등록하세요.' }));
      return;
    }
    // 토큰 = 인프라(TokenProvider)가 발급·선제갱신해 env 로 주입한 raw 토큰. 무효 시엔 인프라가
    // 응답의 return_code/return_msg 를 보고 재발급 후 1회 재시도하므로, sysmod 는 받아쓰기만 한다 (토큰 코드 0).
    const token = process.env['KIWOOM_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: '키움 접근 토큰 미발급 — 인프라 토큰 발급 실패 또는 앱키 미설정.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    let apiId = action;
    let params = data.params || {};
    if (action === 'place_order' || action === 'cancel_order') {
      const mapped = standardOrder(action, data);
      apiId = mapped.apiId;
      params = mapped.params;
    } else if (action === 'get_candles') {
      const mapped = candleParams(action, data);
      apiId = mapped.apiId;
      params = mapped.params;
    } else if (STANDARD_QUERIES.includes(action)) {
      const mapped = standardQuery(action, data);
      apiId = mapped.apiId;
      params = mapped.params;
    }
    // Resolve the row as soon as `apiId` is settled — a neutral name has just picked its branch,
    // and everything below (the chart default, the request, the reply's name) reads it.
    const meta = metaOf(data._call, apiId);
    if (!meta?.path) {
      console.log(JSON.stringify({ success: false, error:
        `${apiId} 의 엔드포인트 선언(_call)이 오지 않았습니다 — actions.json 의 그 액션에 _call 이 있는지 확인하세요.` }));
      return;
    }
    if (meta.path.includes('/chart') && !params.base_dt) params.base_dt = kstToday();
    // The practice host routes to KRX and nothing else. The neutral order path has forced this
    // since 2026-08-04, but a raw call carries its own params and sailed past that guard with
    // dmst_stex_tp: "SOR" — refused as RC9000 (measured 2026-08-06, the liquidation pass). The
    // guard belongs to the venue fact, not to one entry path.
    if (isMock && typeof params.dmst_stex_tp === 'string'
        && params.dmst_stex_tp.toUpperCase() !== 'KRX') {
      params = { ...params, dmst_stex_tp: 'KRX' };
    }
    const result = action === 'get_candles'
      ? await fetchCandles(base, token, meta, apiId, params, data.bars)
      : await callApi(base, token, meta, apiId, params);
    normalizeCandleRows(result);
    // 키움 API 자체 오류(return_code≠0)는 HTTP 200 이라 envelope success:true 로 가려졌었음 →
    // AI 가 실패를 못 알아채고 빈/거짓 데이터로 진행(fabricate). return_code 있으면 0 만 성공.
    const rc = result?.return_code;
    const ok = rc === undefined || rc === null || rc === 0;
    const output = { success: ok, data: { apiId, name: meta?.name, ...result } };
    // Echo the caller's id and the request that went out — the ledger matches on the first and
    // the response schema is read off the second later, since it is not documented anywhere.
    if (action === 'place_order' || action === 'cancel_order') {
      output.data.clientOrderId = data.clientOrderId ?? null;
      output.data.sentParams = params;
    }
    if (action === 'get_candles' && ok) {
      // The neutral contract should answer in a neutral shape. Without this the bars were only
      // reachable through the framework's auto-cache key, so anything calling the module directly
      // — a hand-run of the cycle before the exchange opens, most of all — saw an empty answer
      // and could not tell it from a symbol with no history.
      const picked = pickRows(result);
      if (picked?.field) {
        output.data.rows = picked.rows;
        output.data.rowsField = picked.field;
        output.data.count = picked.rows.length;
      } else if (picked?.candidates) {
        output.data.rowsCandidates = picked.candidates;
      }
    }
    if (STANDARD_QUERIES.includes(action) && ok) {
      // `rows` so the caller does not need the undocumented field name, `rowsField` so the name
      // becomes visible the first time a real response arrives.
      const picked = pickRows(result);
      if (picked?.field) {
        output.data.rows = picked.rows;
        output.data.rowsField = picked.field;
      } else if (picked?.candidates) {
        output.data.rowsCandidates = picked.candidates;
      }
      output.data.sentParams = params;
    }
    if (!ok) output.error = result?.return_msg || `키움 API 오류 (return_code=${rc})`;
    console.log(JSON.stringify(output));
}


export { main };

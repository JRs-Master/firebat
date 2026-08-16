/**
 * Korea Investment & Securities dialect — shared by the two modules that speak it.
 *
 * The split is not about code. It is about which actions a caller can reach and which credentials
 * the process is handed. Lives outside both because neither owns it; `_runtime` has no
 * config.json, so the module scan skips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { roundToKrxTick } from './krx-tick.mjs';
import { usOrderPrice } from './us-tick.mjs';
import { acquireSlot as acquireShared } from './rate-window.mjs';

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// Token issuance/refresh is the infra TokenProvider's job, driven by config.json's oauth
// spec. The sysmod only consumes the raw env-injected token (KIS_ACCESS_TOKEN) — zero token code.

// The two domains do not allow the same rate, and the tighter one is the rung of the ladder every
// strategy has to pass through: paper trading on the practice account hit "초당 거래건수를
// 초과하였습니다" on the second call of a cycle, which reads as a broken cycle rather than as a
// speed limit. Measured 2026-08-02 — a candle fetch that pages twice is already over it.
const RATE_LIMIT_REAL = 5;
const RATE_LIMIT_MOCK = 1;
const WINDOW_MS = 1000;
let _rateLimit = RATE_LIMIT_REAL;

// The window itself is in `_runtime/rate-window.mjs`, shared with the other dialects — it was
// written here first and Kiwoom never got it, which is how that one ended up with no limiter.
const acquireSlot = (isMock) => acquireShared(`kis-${isMock ? 'mock' : 'real'}`, _rateLimit, WINDOW_MS);

/**
 * The row for one action, out of what dispatch injected.
 *
 * `_call` is the declaration for the action that was CALLED. A neutral name resolves to one of
 * several vendor endpoints depending on market and side, so its declaration carries them keyed by
 * whatever the branch is called and the row is picked by id — the branch stays here, where the
 * market and the side are, and the endpoints stay in the declaration, where the vendor's facts are.
 */
function metaOf(call, apiId) {
  if (!call || typeof call !== 'object') return null;
  if (call.id === apiId) return call;
  for (const v of Object.values(call)) if (v && typeof v === 'object' && v.id === apiId) return v;
  return null;
}

async function callApi(base, token, appKey, appSecret, meta, action, query = {}, body = {}, isMock = false, retry = 3, trIdOverride = '') {
  if (!meta) throw new Error(`알 수 없는 API ID: ${action} — 이 값을 지어내지 마세요. search_module_actions(query) 로 맞는 액션을 찾고 get_action_schema('korea-invest', action) 으로 파라미터를 확인하세요. 단순 시세·차트·과거 데이터는 yfinance(action='history')가 더 쉽습니다.`);
  // Some sheet entries hold a sentence covering several ids (buy and sell on one line) rather
  // than a single id. Whoever knows which side this call is resolves it and passes it in.
  const trId = trIdOverride || (isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal);
  if (isMock && !meta.trIdMock) throw new Error(`${action} (${meta.name}) 은 모의투자 미지원입니다.`);
  let url = `${base}${meta.path}`;
  if (meta.method === 'GET' && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'authorization': `Bearer ${token}`,
    'appkey': appKey,
    'appsecret': appSecret,
    'tr_id': trId,
    'custtype': 'P',
  };
  _rateLimit = isMock ? RATE_LIMIT_MOCK : RATE_LIMIT_REAL;
  await acquireSlot(isMock);
  const init = { method: meta.method, headers, signal: AbortSignal.timeout(15000) };
  if (meta.method !== 'GET' && Object.keys(body).length > 0) init.body = JSON.stringify(body);
  const resp = await fetch(url, init);
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1, trIdOverride);
  }
  if (!resp.ok) {
    // KIS reports some errors (token expiry EGW00123, ...) as HTTP 500 with a JSON body
    // (rt_cd/msg1/msg_cd). If the body is a KIS error envelope, return it instead of throwing —
    // the rt_cd check downstream (infra's reactive path) is what detects an invalid token.
    const errText = await resp.text().catch(() => '');
    try {
      const j = JSON.parse(errText);
      if (j && (j.rt_cd !== undefined || j.msg_cd !== undefined)) {
        // The venue refuses on rate over this path too — same lie, different HTTP status. The
        // HTTP-200 retry below never saw these, so a throttled read escaped as an error the
        // caller then misread as an empty account (measured 2026-08-06, the liquidation check).
        if (retry > 0 && String(j.msg1 || '').includes('초당 거래건수')) {
          await new Promise(r => setTimeout(r, WINDOW_MS * (3 - retry) + 200));
          return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1, trIdOverride);
        }
        return j;
      }
    } catch { /* JSON 아님 — 아래 throw */ }
    throw new Error(`KIS API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }
  const payload = await resp.json();
  // The venue also refuses on rate with HTTP 200 and an error body. Returning it as-is makes a
  // throttled call look like an account with nothing in it, which is the worst possible lie to
  // tell something that reconciles positions.
  if (retry > 0 && String(payload?.msg1 || '').includes('초당 거래건수')) {
    await new Promise(r => setTimeout(r, WINDOW_MS * (3 - retry) + 200));
    return callApi(base, token, appKey, appSecret, action, query, body, isMock, retry - 1, trIdOverride);
  }
  return payload;
}

// Standard OHLCV normalization — rename KIS candle vocabulary to the cross-broker standard
// {date, open, high, low, close, volume} so stock_chart dataCacheKey injection, the timeseries
// store, and cache_grep all speak one vocabulary (yfinance already does). Field-signature
// detection (no per-action enum): a row is a candle when it carries a date field together with a
// close-price field. Covers 국내 일/주/월(stck_bsop_date+stck_clpr), 국내 분봉(stck_cntg_hour+
// stck_prpr), 해외(xymd+clos). Values arrive as strings — Number() them.
function kisNum(v) {
  const n = Number(String(v ?? '').replace(/^[+-]/, ''));
  return Number.isFinite(n) ? n : v;
}
function kisDate8(s) {
  // \d was missing its backslash, so YYYYMMDD never matched and KIS dates stayed unhyphenated
  // while kiwoom's did — the two brokers' `date` vocabularies silently diverged.
  s = String(s ?? '');
  return /^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s;
}
function normalizeCandleRow(row) {
  // Overseas period quotes (HHDFS76240000 family): xymd + clos (+open/high/low/tvol)
  if ('xymd' in row && 'clos' in row) {
    row.date = kisDate8(row.xymd); delete row.xymd;
    row.close = kisNum(row.clos); delete row.clos;
    if ('open' in row) row.open = kisNum(row.open);
    if ('high' in row) row.high = kisNum(row.high);
    if ('low' in row) row.low = kisNum(row.low);
    if ('tvol' in row) { row.volume = kisNum(row.tvol); delete row.tvol; }
    return;
  }
  // Domestic: stck_bsop_date + (stck_clpr for day/week/month | stck_prpr for minute bars)
  if ('stck_bsop_date' in row && ('stck_clpr' in row || 'stck_prpr' in row)) {
    const day = kisDate8(row.stck_bsop_date); delete row.stck_bsop_date;
    if ('stck_cntg_hour' in row) {
      const t = String(row.stck_cntg_hour).padStart(6, '0');
      row.date = day + ' ' + t.slice(0, 2) + ':' + t.slice(2, 4);
      delete row.stck_cntg_hour;
    } else {
      row.date = day;
    }
    if ('stck_oprc' in row) { row.open = kisNum(row.stck_oprc); delete row.stck_oprc; }
    if ('stck_hgpr' in row) { row.high = kisNum(row.stck_hgpr); delete row.stck_hgpr; }
    if ('stck_lwpr' in row) { row.low = kisNum(row.stck_lwpr); delete row.stck_lwpr; }
    if ('stck_clpr' in row) { row.close = kisNum(row.stck_clpr); delete row.stck_clpr; }
    else if ('stck_prpr' in row) { row.close = kisNum(row.stck_prpr); delete row.stck_prpr; }
    if ('acml_vol' in row) { row.volume = kisNum(row.acml_vol); delete row.acml_vol; }
    else if ('cntg_vol' in row) { row.volume = kisNum(row.cntg_vol); delete row.cntg_vol; }
  }
}
// Candle "latest" dialect — KIS anchors chart queries on an explicit time/date, but a page binding
// (publish bake / rebake / fresh-on-visit seed) carries no clock: a value frozen at authoring time
// would return the same stale window on every later visit. So when the anchor is omitted, default
// it to now/today (KST) — the module owns this dialect, not the caller. Mirrors kiwoom `base_dt`.
function kstParts() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    hms: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`,
  };
}
// Intraday-minute actions anchor on FID_INPUT_HOUR_1 (query end time); period actions anchor on
// FID_INPUT_DATE_2 (end date, with DATE_1 as the window start).
const MINUTE_ANCHOR_ACTIONS = new Set(['v1_국내주식-022', '국내주식-213', 'v1_국내주식-045', 'v1_국내선물-012']);
const PERIOD_ANCHOR_ACTIONS = new Set(['v1_국내주식-016', 'v1_국내주식-021', 'v1_국내선물-008', 'v1_해외주식-010']);
function applyLatestDefaults(action, query) {
  const { day, hms } = kstParts();
  if (MINUTE_ANCHOR_ACTIONS.has(action) && !query.FID_INPUT_HOUR_1) {
    query.FID_INPUT_HOUR_1 = hms;
  }
  if (PERIOD_ANCHOR_ACTIONS.has(action)) {
    if (!query.FID_INPUT_DATE_2) query.FID_INPUT_DATE_2 = day;
    if (!query.FID_INPUT_DATE_1) {
      // ~4 months back — enough for MA60 on daily candles.
      const d = new Date(Date.now() + 9 * 3600 * 1000 - 120 * 86400 * 1000);
      const p = (n) => String(n).padStart(2, '0');
      query.FID_INPUT_DATE_1 = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
    }
  }
}

function normalizeCandles(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const row of v) { if (row && typeof row === 'object') normalizeCandleRow(row); }
    } else if (v && typeof v === 'object') {
      normalizeCandles(v, depth + 1);
    }
  }
}

// ── Standard broker contract ─────────────────────────────────────────────────────────────────
// The same six calls every broker answers, translated here into this one's vocabulary. The point
// is that whoever places an order does not learn that a domestic buy is TTTC0012U, that the same
// call overseas is TTTT1002U, that the account number splits into two body fields, or that the
// exchange is spelled NASD when ordering and NAS when asking for a chart. Swapping brokers should
// be a declaration, not an edit to the caller.
const NEUTRAL = new Set(['place_order', 'cancel_order', 'list_open_orders', 'list_fills',
                         'get_balance', 'get_candles']);

/** The transaction id for this call, chosen from the spec sheet's own labelling.
 *
 * These entries do not hold one id. `v1_국내주식-001` carries "(매도) TTTC0011U (매수) TTTC0012U"
 * — one line covering both sides — and sending that sentence as the `tr_id` header is what this
 * module did until now, which is why an order through this broker has never once been accepted.
 * Reading the label rather than hardcoding the id means a regenerated table stays correct.
 */
function pickTrId(meta, isMock, hint) {
  const raw = String((isMock ? meta.trIdMock : meta.trIdReal) || '').trim();
  if (!raw) {
    throw new Error(isMock
      ? `${meta.name} 은 모의투자를 지원하지 않습니다 — 실전 계좌로 호출하세요.`
      : `${meta.name} 의 tr_id 가 비어 있습니다.`);
  }
  const pairs = [...raw.matchAll(/\(([^)]*)\)\s*([A-Z]{4,}\d{3,}[A-Z]?)/g)]
    .map(m => ({ label: m[1].replace(/\s/g, ''), id: m[2] }));
  if (!pairs.length) return raw;                       // a single bare id
  const hit = hint ? pairs.find(p => p.label.includes(hint)) : null;
  if (hit) return hit.id;
  throw new Error(
    `${meta.name}: '${hint}' 에 해당하는 tr_id 를 찾지 못했습니다 — 후보 ` +
    pairs.map(p => `${p.label}=${p.id}`).join(', '));
}

/** CANO + ACNT_PRDT_CD from the registered account number. */
function accountParts(data) {
  const digits = String(data.accountNo ?? '').replace(/\D/g, '');
  if (digits.length < 8) {
    throw new Error('계좌번호가 없습니다 — 설정 > 시스템 모듈 > korea-invest 에서 계좌를 등록하고 '
                    + '그 별칭으로 호출하세요.');
  }
  // The product code is the last two of a ten-digit number; an eight-digit one is the account
  // without it, and 01 is the ordinary cash account every retail login has.
  return { CANO: digits.slice(0, 8), ACNT_PRDT_CD: digits.length >= 10 ? digits.slice(8, 10) : '01' };
}

/** kr or us — declared, or read off the symbol shape (six digits is a KRX code). */
function marketOf(data) {
  const m = String(data.market ?? '').toLowerCase();
  if (m === 'kr' || m === 'us') return m;
  return /^\d{6}$/.test(String(data.symbol ?? '').trim()) ? 'kr' : 'us';
}

// Ordering and asking for a chart use different spellings of the same exchange.
const US_ORDER_EXCG = { NASD: 'NASD', NAS: 'NASD', NASDAQ: 'NASD', NYSE: 'NYSE', NYS: 'NYSE',
                        AMEX: 'AMEX', AMS: 'AMEX' };
const US_QUOTE_EXCD = { NASD: 'NAS', NYSE: 'NYS', AMEX: 'AMS' };

function usExchange(data) {
  const raw = String(data.exchange ?? 'NASD').toUpperCase();
  const code = US_ORDER_EXCG[raw];
  if (!code) {
    throw new Error(`exchange='${raw}' 는 지원하지 않습니다 — NASD, NYSE, AMEX 중 하나.`);
  }
  return code;
}

function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function requireQty(data) {
  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty 는 1 이상이어야 합니다.');
  return String(Math.trunc(qty));
}

function sideHint(data, kr) {
  const side = String(data.side ?? '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('side 는 buy 또는 sell 이어야 합니다.');
  }
  // The sheet labels the domestic pair 매수/매도 and the overseas one 미국매수/미국매도.
  return (kr ? '' : '미국') + (side === 'buy' ? '매수' : '매도');
}

/** A neutral call → what this broker's HTTP layer needs. */
function standardCall(action, data) {
  const kr = marketOf(data) === 'kr';
  const symbol = String(data.symbol ?? '').trim();
  const type = String(data.orderType ?? 'limit').toLowerCase();
  const price = Number(data.price);

  if (action === 'place_order') {
    if (!symbol) throw new Error('place_order: symbol 이 필요합니다.');
    const acct = accountParts(data);
    const qty = requireQty(data);
    if (kr) {
      // 00 지정가 · 01 시장가. A market order carries no unit price; sending one is refused.
      const market = type === 'market';
      if (!market && !(price > 0)) throw new Error('place_order: 지정가 주문에는 price 가 필요합니다.');
      return { apiId: 'v1_국내주식-001', hint: sideHint(data, true), body: {
        ...acct, PDNO: symbol, ORD_DVSN: market ? '01' : '00',
        // Not `trunc`: an integer is still off-grid in a hundred-won band, which is what the
        // venue refused with 호가단위 오류.
        ORD_QTY: qty, ORD_UNPR: market ? '0' : String(roundToKrxTick(price, data.side)),
      }};
    }
    // ORD_DVSN has no 시장가 code here (00 지정가 · 32 LOO · 34 LOC · 35 TWAP · 36 VWAP), which read
    // as "this venue has no market order". It is the PRICE field that carries it — the sheet says
    // of OVRS_ORD_UNPR: "시장가의 경우 1주당 가격을 공란으로 비우지 않음 '0'으로 입력". Measured
    // 2026-08-08 on the mock account: 00 + "0" is accepted and fills at the touch every time
    // (MSFT 4 @502.55 · AMZN 14 @276.725 · TSLA 6 @330.695, all sent with unit price 0).
    // So a market intent goes out as a market order. `marketableLimitPct` is now what an explicit
    // *bounded* one asks for — a limit priced through the spread — rather than the only shape.
    const market = type === 'market';
    const bounded = market && data.marketableLimitPct != null;
    if ((!market || bounded) && !(price > 0)) {
      throw new Error('place_order: 해외 지정가 주문에는 price 가 필요합니다'
                      + (market ? ' (marketableLimitPct 는 price 를 넘긴 지정가입니다).' : '.'));
    }
    const buying = String(data.side ?? '').toLowerCase() === 'buy';
    const slip = bounded ? Number(data.marketableLimitPct) / 100 : 0;
    // `toFixed(2)` was legal but rounds in whichever direction is nearer — which can push a buy
    // further across the spread than asked — and truncates a sub-dollar price to two decimals
    // where four are allowed. Same helper as kiwoom now: one venue, one rule.
    const unpr = market && !bounded ? '0'
      : usOrderPrice(bounded ? price * (buying ? 1 + slip : 1 - slip) : price, data.side);
    return { apiId: 'v1_해외주식-001', hint: sideHint(data, false), body: {
      ...acct, OVRS_EXCG_CD: usExchange(data), PDNO: symbol, ORD_QTY: qty,
      OVRS_ORD_UNPR: unpr, ORD_SVR_DVSN_CD: '0', ORD_DVSN: '00',
      // 제거 = 매수 / "00" = 매도 (sheet). It was missing because the neutral path had never placed
      // a US sell — every US order until today was a buy, where the field must be absent.
      ...(buying ? {} : { SLL_TYPE: '00' }),
    }};
  }

  if (action === 'cancel_order') {
    const orderNo = String(data.brokerOrderNo ?? '').trim();
    if (!orderNo) throw new Error('cancel_order: brokerOrderNo 가 필요합니다.');
    const acct = accountParts(data);
    if (kr) {
      return { apiId: 'v1_국내주식-003', hint: '', body: {
        ...acct, KRX_FWDG_ORD_ORGNO: String(data.orderBranch ?? ''), ORGN_ODNO: orderNo,
        ORD_DVSN: '00', RVSE_CNCL_DVSN_CD: '02',
        // Cancelling means whatever is left, so the whole-order flag carries it and the quantity
        // is ignored — passing a stale one would cancel the wrong amount.
        ORD_QTY: '0', ORD_UNPR: '0', QTY_ALL_ORD_YN: 'Y',
      }};
    }
    return { apiId: 'v1_해외주식-003', hint: '정정·취소', body: {
      ...acct, OVRS_EXCG_CD: usExchange(data), PDNO: symbol, ORGN_ODNO: orderNo,
      RVSE_CNCL_DVSN_CD: '02', ORD_QTY: String(Math.trunc(Number(data.qty) || 0)),
      OVRS_ORD_UNPR: '0', ORD_SVR_DVSN_CD: '0',
    }};
  }

  if (action === 'get_balance') {
    const acct = accountParts(data);
    if (kr) {
      return { apiId: 'v1_국내주식-006', hint: '', query: {
        ...acct, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00',
        CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      }};
    }
    return { apiId: 'v1_해외주식-006', hint: '', query: {
      ...acct, OVRS_EXCG_CD: usExchange(data), TR_CRCY_CD: String(data.currency ?? 'USD'),
      CTX_AREA_FK200: '', CTX_AREA_NK200: '',
    }};
  }

  if (action === 'list_open_orders' || action === 'list_fills') {
    const acct = accountParts(data);
    const open = action === 'list_open_orders';
    const from = String(data.from ?? '').replace(/-/g, '') || kstDate(-7);
    const to = String(data.to ?? '').replace(/-/g, '') || kstDate(0);
    if (kr) {
      // One endpoint answers both — 01 filled, 02 resting. Two neutral calls, one dialect.
      return { apiId: 'v1_국내주식-005', hint: '3개월이내', query: {
        ...acct, INQR_STRT_DT: from, INQR_END_DT: to, SLL_BUY_DVSN_CD: '00',
        INQR_DVSN: '00', PDNO: symbol, CCLD_DVSN: open ? '02' : '01',
        ORD_GNO_BRNO: '', ODNO: '', INQR_DVSN_3: '00', INQR_DVSN_1: '',
        CTX_AREA_FK100: '', CTX_AREA_NK100: '',
      }};
    }
    // Overseas: the dedicated unfilled endpoint has no mock id at all, and 주문체결내역 splits
    // the same way (01/02) while working in both. Using it for both keeps the mock rung of the
    // ladder usable, which is the whole point of having one.
    return { apiId: 'v1_해외주식-007', hint: '', query: {
      ...acct, PDNO: symbol, ORD_STRT_DT: from, ORD_END_DT: to,
      SLL_BUY_DVSN: '00', CCLD_NCCS_DVSN: open ? '02' : '01',
      OVRS_EXCG_CD: usExchange(data), SORT_SQN: 'DS', ORD_DT: '', ORD_GNO_BRNO: '', ODNO: '',
      CTX_AREA_NK200: '', CTX_AREA_FK200: '',
    }};
  }

  throw new Error(`standardCall: ${action} 은 중립 계약에 없습니다.`);
}

// ── Candles ──────────────────────────────────────────────────────────────────────────────────
// Both endpoints answer at most a hundred bars, and a rule with a 60-period average says nothing
// at all until it has more than that. So the interval is the argument, the paging lives here, and
// the caller asks for a bar count exactly as it does of every other broker.
const KR_PERIOD = { '1d': 'D', '1w': 'W', '1M': 'M', '1y': 'Y' };
const US_PERIOD = { '1d': '0', '1w': '1', '1M': '2' };
const PERIOD_DAYS = { D: 1, W: 7, M: 31, Y: 366 };
const CANDLE_PAGE = 100;
const MAX_CANDLE_PAGES = 12;

function candleRows(result) {
  for (const k of ['output2', 'output1', 'output']) {
    if (Array.isArray(result?.[k])) return result[k];
  }
  return [];
}

function shiftDate8(d8, days) {
  const t = new Date(Date.UTC(Number(d8.slice(0, 4)), Number(d8.slice(4, 6)) - 1,
                              Number(d8.slice(6, 8)) + days));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
}

async function fetchCandles(ctx, data) {
  const symbol = String(data.symbol ?? '').trim();
  if (!symbol) throw new Error('get_candles: symbol 이 필요합니다.');
  const interval = String(data.interval ?? '1d').trim();
  const kr = marketOf(data) === 'kr';
  const want = Math.max(1, Math.min(Number(data.bars) || 200, CANDLE_PAGE * MAX_CANDLE_PAGES));
  const period = (kr ? KR_PERIOD : US_PERIOD)[interval];
  if (!period) {
    throw new Error(
      `get_candles: interval='${interval}' 은 지원하지 않습니다 — ` +
      `${Object.keys(kr ? KR_PERIOD : US_PERIOD).join(', ')} 중 하나. ` +
      '분봉은 이 브로커의 기간별시세 엔드포인트에 없습니다.');
  }
  const apiId = kr ? 'v1_국내주식-016' : 'v1_해외주식-010';
  const meta = metaOf(ctx.call_, apiId);
  const trId = pickTrId(meta, ctx.isMock, '');
  const span = Math.ceil(CANDLE_PAGE * 1.7) * (PERIOD_DAYS[period] || 1);
  const byDate = new Map();
  let stopped = null;
  let cursor = String(data.baseDate ?? '').replace(/-/g, '') || kstDate(0);
  for (let page = 0; page < MAX_CANDLE_PAGES && byDate.size < want; page += 1) {
    const query = kr
      ? { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: symbol,
          // A page reaches back far enough to fill itself whatever the period is; the response is
          // capped at a hundred rows and the cursor then moves by what actually came back.
          FID_INPUT_DATE_1: shiftDate8(cursor, -span), FID_INPUT_DATE_2: cursor,
          FID_PERIOD_DIV_CODE: period, FID_ORG_ADJ_PRC: data.adjusted === false ? '1' : '0' }
      : { AUTH: '', EXCD: US_QUOTE_EXCD[usExchange(data)], SYMB: symbol,
          GUBN: period, BYMD: cursor, MODP: data.adjusted === false ? '0' : '1' };
    const result = await ctx.call(apiId, trId, query, {});
    if (result?.rt_cd !== undefined && result.rt_cd !== '0') {
      // Page one failing is the call failing; a later page failing still has bars to hand back —
      // but it has to say so. A silently short history is a rule fitted on whatever survived the
      // throttle, and nothing downstream can tell that from a young listing.
      if (page === 0) throw new Error(result.msg1 || `한투 API 오류 (rt_cd=${result.rt_cd})`);
      stopped = result.msg1 || `rt_cd=${result.rt_cd}`;
      break;
    }
    const rows = candleRows(result);
    if (!rows.length) break;
    let oldest = null;
    for (const row of rows) {
      normalizeCandleRow(row);
      const date = String(row.date ?? '');
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, row);
      const d8 = date.replace(/-/g, '');
      if (!oldest || d8 < oldest) oldest = d8;
    }
    if (!oldest || oldest >= cursor) break;   // no progress — stop rather than loop
    cursor = shiftDate8(oldest, -1);
  }
  const all = [...byDate.values()]
    .filter(r => Number(r.close) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const out = all.slice(-want);
  return { rows: out, apiId, interval, market: kr ? 'kr' : 'us',
           short: out.length < want ? { asked: want, got: out.length, stopped } : null };
}

/** The one row list, by this broker's own naming: output1 is the detail, output2 the summary. */
function neutralRows(result) {
  for (const k of ['output1', 'output']) {
    if (Array.isArray(result?.[k])) return { field: k, rows: result[k] };
  }
  const arrays = Object.entries(result || {}).filter(([, v]) => Array.isArray(v));
  return arrays.length === 1 ? { field: arrays[0][0], rows: arrays[0][1] } : { field: null, rows: [] };
}

async function main(data) {

    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 한투 API ID (v1_국내주식-008 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIS_APP_KEY'];
    const appSecret = process.env['KIS_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > korea-invest 에서 등록하세요.' }));
      return;
    }
    // Token = the raw one the infra TokenProvider issued, proactively refreshed and injected
    // via env. On invalidation the infra reads rt_cd/msg1 off the response, reissues and
    // retries once — the sysmod only consumes it (zero token code).
    const token = process.env['KIS_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: 'KIS 접근 토큰 미발급 — 인프라 토큰 발급 실패 또는 앱키 미설정.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;

    // ── Neutral contract ──────────────────────────────────────────────────────────────────
    if (NEUTRAL.has(action)) {
      const ctx = {
        isMock,
        call_: data._call,
        call: (apiId, trId, q, b) =>
          callApi(base, token, appKey, appSecret, metaOf(data._call, apiId), apiId, q, b, isMock, 2, trId),
      };
      if (action === 'get_candles') {
        const out = await fetchCandles(ctx, data);
        console.log(JSON.stringify({ success: true, data: { action, ...out, count: out.rows.length } }));
        return;
      }
      const mapped = standardCall(action, data);
      const meta = metaOf(data._call, mapped.apiId);
      const trId = pickTrId(meta, isMock, mapped.hint);
      const result = await ctx.call(mapped.apiId, trId, mapped.query || {}, mapped.body || {});
      const ok = result?.rt_cd === undefined || result.rt_cd === null || result.rt_cd === '0';
      const out = { success: ok, data: { action, apiId: mapped.apiId, trId, ...result } };
      if (!ok) out.error = result?.msg1 || `한투 API 오류 (rt_cd=${result?.rt_cd})`;
      if (action === 'place_order' || action === 'cancel_order') {
        // The ledger matches on the caller's id, and the response schema is read off the request
        // later — it is documented nowhere, so the request that produced it is kept beside it.
        out.data.clientOrderId = data.clientOrderId ?? null;
        out.data.sentBody = mapped.body;
      } else if (ok) {
        const picked = neutralRows(result);
        out.data.rows = picked.rows;
        out.data.rowsField = picked.field;
      }
      console.log(JSON.stringify(out));
      return;
    }

    const query = data.query || {};
    const body = data.body || {};
    // The account digits are already resolved — the framework injected `accountNo` alongside the
    // credentials. A raw call that omits CANO/ACNT_PRDT_CD gets them filled here instead of being
    // refused with "INPUT_FIELD_NAME CANO" (measured 2026-08-06: the model hand-built a balance
    // query and dropped the one field only the registry knows). Explicit values still win.
    if (data.accountNo) {
      const acct = accountParts(data);
      for (const target of [query, body]) {
        if (target && typeof target === 'object' && Object.keys(target).length > 0) {
          if (!target.CANO && acct.CANO) target.CANO = acct.CANO;
          if (!target.ACNT_PRDT_CD && acct.ACNT_PRDT_CD) target.ACNT_PRDT_CD = acct.ACNT_PRDT_CD;
        }
      }
    }
    applyLatestDefaults(action, query);
    // The sheet's tr_id can be a SENTENCE covering both sides — "(매도) VTTC0011U (매수) …". The
    // neutral path has resolved that with the side it knows since the first order ever refused;
    // a raw call pushed the sentence straight into the HTTP header, where fetch dies on the first
    // Korean byte (measured 2026-08-06: four sell cards in a row, "ByteString … 47588" — that
    // code point is 매). Resolve it the same way here, or say in words what is missing.
    let rawTrId = '';
    const metaRaw = metaOf(data._call, action);
    if (metaRaw) {
      const candidate = isMock && metaRaw.trIdMock ? metaRaw.trIdMock : metaRaw.trIdReal;
      if (/[^ -~]/.test(String(candidate ?? ''))) {
        const side = String(data.side ?? '').toLowerCase();
        const hint = data.hint || (side === 'buy' ? '매수' : side === 'sell' ? '매도' : '');
        if (!hint) {
          console.log(JSON.stringify({ success: false, error:
            `${action} 의 tr_id 는 매수/매도로 갈립니다 — side: "buy" 또는 "sell" 을 함께 보내거나, `
            + '중립 계약 place_order 를 사용하세요.' }));
          return;
        }
        rawTrId = pickTrId(metaRaw, isMock, hint);
      }
    }
    const meta = metaOf(data._call, action);
    const result = await callApi(base, token, appKey, appSecret, meta, action, query, body, isMock, 3, rawTrId);
    normalizeCandles(result);
    // KIS rt_cd: "0" = ok, anything else = error. It rides an HTTP 200, so the envelope used
    // to mask it as success:true → only "0" is success now (same intent as kiwoom's
    // return_code — stops the AI fabricating over a failure it never saw).
    const rtCd = result?.rt_cd;
    const ok = rtCd === undefined || rtCd === null || rtCd === '0';
    const output = { success: ok, data: { apiId: action, trId: isMock && meta.trIdMock ? meta.trIdMock : meta.trIdReal, name: meta.name, ...result } };
    if (!ok) output.error = result?.msg1 || `한투 API 오류 (rt_cd=${rtCd})`;
    console.log(JSON.stringify(output));
}


export { main };

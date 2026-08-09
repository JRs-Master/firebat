/**
 * Firebat System Module: binance (market data)
 *
 * Public market data only — candles, ticker, order book, trades, symbols. It cannot read an
 * account and cannot place an order: those actions are not declared and the module declares no
 * API keys, so the sandbox injects none.
 *
 * Why this module exists: Upbit lists a few hundred pairs and Binance lists thousands, so the
 * question "analyse a coin Upbit does not carry" used to be answered with a raw `network_request`
 * to api.binance.com — which gets no auto-cache envelope, no timeseries store, no rate window, and
 * no neutral contract. Declaring it as a module gives all four for free.
 *
 * Base URL: `data-api.binance.vision` is Binance's documented market-data-only host. Using it
 * keeps this module structurally unable to reach a trading endpoint even if a future edit tried.
 *
 * The venue counts a WEIGHT per request, not a request count, and repeated 429s earn an IP ban
 * that scales from 2 minutes to 3 days. So every call spends its documented weight in the shared
 * file window before going out, and a 418 is never retried.
 */
import { acquireSlot } from '../_runtime/rate-window.mjs';

const MARKET_DATA_HOST = 'https://data-api.binance.vision';
// Only used when the market-data host itself is unreachable — a transport failure, never an
// HTTP error. Both serve the same public endpoints.
const FALLBACK_HOST = 'https://api.binance.com';

// The venue publishes 6000 weight/minute per IP. We spend against a deliberately lower ceiling:
// the cost of being early is a short wait, and the cost of being late is an IP ban that would
// take every crypto quote down with it.
const WEIGHT_LIMIT_PER_MIN = 2400;
const WINDOW_MS = 60_000;
const RATE_BUCKET = 'binance-ip';

/** Documented request weights (Binance spot API). A route missing here is charged the default. */
const WEIGHTS = {
  '/api/v3/ping': 1,
  '/api/v3/time': 1,
  '/api/v3/exchangeInfo': 20,
  '/api/v3/klines': 2,
  '/api/v3/uiKlines': 2,
  '/api/v3/avgPrice': 2,
  '/api/v3/aggTrades': 4,
  '/api/v3/trades': 25,
  '/api/v3/ticker': 4,
};

/** Weights that depend on the arguments, not just the route. */
function weightOf(path, params) {
  if (path === '/api/v3/depth') {
    const n = Number(params.limit) || 100;
    if (n <= 100) return 5;
    if (n <= 500) return 25;
    if (n <= 1000) return 50;
    return 250;
  }
  if (path === '/api/v3/ticker/24hr') {
    if (params.symbol) return 2;
    if (!params.symbols) return 80;              // every symbol at once
    const n = JSON.parse(params.symbols).length;
    return n <= 20 ? 2 : n <= 100 ? 40 : 80;
  }
  if (path === '/api/v3/ticker/price' || path === '/api/v3/ticker/bookTicker') {
    return params.symbol ? 2 : 4;
  }
  return WEIGHTS[path] ?? 5;
}

const INTERVAL_MS = {
  '1s': 1e3, '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3, '12h': 43200e3,
  '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3,
};

/**
 * Binance intervals are CASE-SENSITIVE and the two cases collide on one letter: `1m` is one
 * minute, `1M` is one month. A caller who lowercases everything silently gets minutes where they
 * asked for months, so unknown spellings are refused by name rather than guessed into place.
 */
function normalizeInterval(raw) {
  const v = String(raw ?? '1d').trim();
  if (INTERVAL_MS[v]) return v;
  const alias = {
    '1mo': '1M', '1month': '1M', month: '1M', monthly: '1M',
    '1week': '1w', week: '1w', weekly: '1w',
    '1day': '1d', day: '1d', daily: '1d', d: '1d',
    hour: '1h', hourly: '1h', h: '1h', minute: '1m', min: '1m',
  }[v.toLowerCase()];
  if (alias) return alias;
  throw new Error(
    `interval '${raw}' 은 바이낸스가 모르는 값입니다. 쓸 수 있는 값: ${Object.keys(INTERVAL_MS).join(', ')} ` +
    `(대소문자 구분 — '1m' 은 1분, '1M' 은 1개월입니다)`
  );
}

/**
 * Symbols arrive in whatever shape the caller had at hand — `BTC`, `btcusdt`, `BTC/USDT`,
 * `BTC-USDT`. Binance wants `BTCUSDT`. A bare base asset takes the quote currency, USDT by
 * default, because that is where the depth is.
 */
function normalizeSymbol(raw, quote = 'USDT') {
  if (raw == null || raw === '') return undefined;
  let s = String(raw).trim().toUpperCase().replace(/[\/\-_]/g, '');
  const q = String(quote).toUpperCase();
  const KNOWN_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'BRL'];
  if (!KNOWN_QUOTES.some(k => s.endsWith(k) && s.length > k.length)) s += q;
  return s;
}

/** `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS`, or epoch ms → epoch ms. */
function toMs(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{11,}$/.test(s)) return Number(s);
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(iso.endsWith('Z') || /[+\-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  if (Number.isNaN(ms)) throw new Error(`날짜 '${v}' 를 읽지 못했습니다. YYYY-MM-DD 또는 밀리초 값으로 주십시오.`);
  return ms;
}

function msToStamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function request(path, params = {}, { host = MARKET_DATA_HOST } = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  const weight = weightOf(path, clean);
  await acquireSlot(RATE_BUCKET, WEIGHT_LIMIT_PER_MIN, WINDOW_MS, weight);

  const qs = new URLSearchParams(clean).toString();
  const url = `${host}${path}${qs ? '?' + qs : ''}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    // A transport failure on the market-data host is worth one try on the main host; an HTTP
    // error is not (the venue answered, and answering twice would just spend weight again).
    if (host === MARKET_DATA_HOST) return request(path, params, { host: FALLBACK_HOST });
    throw new Error(`바이낸스에 연결하지 못했습니다: ${err.message}`);
  }

  if (res.status === 418) {
    const until = res.headers.get('retry-after');
    throw new Error(
      `바이낸스가 이 서버 IP 를 일시 차단했습니다(418). ${until ? `${until}초 후` : '잠시 후'} 풀립니다. ` +
      `차단은 반복될수록 길어지므로(최대 3일) 자동 재시도하지 않습니다.`
    );
  }
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after') || 0);
    if (after > 0 && after <= 5) {
      await new Promise(r => setTimeout(r, after * 1000 + 100));
      return request(path, params, { host });
    }
    throw new Error(`바이낸스 요청 한도를 넘었습니다(429). ${after || '잠시'}초 후에 다시 시도해 주십시오.`);
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const code = body && body.code;
    const msg = (body && body.msg) || String(body).slice(0, 200);
    throw new Error(`바이낸스 ${path} 호출 실패 (HTTP ${res.status}${code ? `, code ${code}` : ''}): ${msg}`);
  }
  return body;
}

/** Binance kline tuple → the neutral bar every analyser in Firebat already reads. */
function toBar(k) {
  return {
    date: msToStamp(k[0]),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    volume: Number(k[5]),
    quoteVolume: Number(k[7]),
    trades: Number(k[8]),
    closeTime: msToStamp(k[6]),
  };
}

const MAX_PER_CALL = 1000;   // venue cap for klines
const MAX_PAGES = 20;        // 20,000 bars — enough for an 8-year daily study, bounded on purpose
const PAGE_GAP_MS = 120;

/**
 * Candles, paging when more than one call's worth is asked for.
 *
 * The venue returns oldest-first from `startTime`, so paging walks forward from the last open
 * time. Without a start we compute one from the interval so that "give me 3000 4h bars" works the
 * same way "give me 3000 bars since 2018" does.
 */
async function fetchCandles({ symbol, interval, limit, startMs, endMs }) {
  const want = Math.max(1, Math.min(Number(limit) || 500, MAX_PER_CALL * MAX_PAGES));
  const step = INTERVAL_MS[interval];
  let cursor = startMs;
  if (cursor === undefined && want > MAX_PER_CALL) {
    cursor = (endMs ?? Date.now()) - want * step;
  }

  const bars = [];
  let pages = 0;
  let truncated = false;
  for (;;) {
    const need = Math.min(MAX_PER_CALL, want - bars.length);
    const page = await request('/api/v3/klines', {
      symbol, interval, limit: need, startTime: cursor, endTime: endMs,
    });
    pages += 1;
    if (!Array.isArray(page) || page.length === 0) break;
    for (const k of page) bars.push(toBar(k));
    if (bars.length >= want || page.length < need) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    cursor = page[page.length - 1][0] + step;
    if (endMs !== undefined && cursor > endMs) break;
    await new Promise(r => setTimeout(r, PAGE_GAP_MS));
  }

  // Paging can overlap by a bar at the seam; open time is the venue's own unique key.
  const seen = new Set();
  const rows = bars.filter(b => (seen.has(b.date) ? false : (seen.add(b.date), true)))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows: rows.slice(-want), pages, truncated };
}

/** 24h ticker rows → a ranked screen, the same shape the Upbit screen answers with. */
function toScreenRow(t) {
  return {
    symbol: t.symbol,
    price: Number(t.lastPrice),
    changePct: Number(t.priceChangePercent),
    volume: Number(t.volume),
    quoteVolume: Number(t.quoteVolume),
    trades: Number(t.count),
    high: Number(t.highPrice),
    low: Number(t.lowPrice),
  };
}

async function dispatch(input) {
  const action = input.action;
  const quote = String(input.quote || 'USDT').toUpperCase();
  const symbol = normalizeSymbol(input.symbol, quote);
  const note = {};
  if (input.symbol && symbol !== String(input.symbol).toUpperCase()) {
    note.symbolNormalized = `${input.symbol} → ${symbol}`;
  }

  switch (action) {
    case 'get_candles':
    case 'klines': {
      if (!symbol) throw new Error('symbol 이 필요합니다 (예: BTCUSDT · BTC · BTC/USDT).');
      const interval = normalizeInterval(input.interval);
      const { rows, pages, truncated } = await fetchCandles({
        symbol, interval,
        limit: input.limit,
        startMs: toMs(input.start ?? input.startTime),
        endMs: toMs(input.end ?? input.endTime),
      });
      return {
        endpoint: '/api/v3/klines',
        data: {
          symbol, interval, count: rows.length, pages, records: rows,
          ...(truncated ? { truncated: true, note: `페이지 상한 ${MAX_PAGES}회에서 멈췄습니다. 기간을 나눠 요청해 주십시오.` } : {}),
          ...note,
        },
      };
    }

    case 'ticker': {
      if (!symbol) throw new Error('symbol 이 필요합니다.');
      const data = await request('/api/v3/ticker/price', { symbol });
      return { endpoint: '/api/v3/ticker/price', data: { ...data, price: Number(data.price), ...note } };
    }

    case 'ticker_24h': {
      const data = await request('/api/v3/ticker/24hr', symbol ? { symbol } : {});
      if (Array.isArray(data)) return { endpoint: '/api/v3/ticker/24hr', data: { count: data.length, records: data.map(toScreenRow) } };
      return { endpoint: '/api/v3/ticker/24hr', data: { ...toScreenRow(data), ...note } };
    }

    case 'book_ticker': {
      if (!symbol) throw new Error('symbol 이 필요합니다.');
      const d = await request('/api/v3/ticker/bookTicker', { symbol });
      return {
        endpoint: '/api/v3/ticker/bookTicker',
        data: {
          symbol: d.symbol,
          bidPrice: Number(d.bidPrice), bidQty: Number(d.bidQty),
          askPrice: Number(d.askPrice), askQty: Number(d.askQty),
          spreadPct: Number(d.askPrice) > 0
            ? ((Number(d.askPrice) - Number(d.bidPrice)) / Number(d.askPrice)) * 100
            : null,
          ...note,
        },
      };
    }

    case 'avg_price': {
      if (!symbol) throw new Error('symbol 이 필요합니다.');
      const d = await request('/api/v3/avgPrice', { symbol });
      return { endpoint: '/api/v3/avgPrice', data: { symbol, mins: d.mins, price: Number(d.price), ...note } };
    }

    case 'orderbook': {
      if (!symbol) throw new Error('symbol 이 필요합니다.');
      const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 5000);
      const d = await request('/api/v3/depth', { symbol, limit });
      const num = (lv) => ({ price: Number(lv[0]), qty: Number(lv[1]) });
      return {
        endpoint: '/api/v3/depth',
        data: {
          symbol, lastUpdateId: d.lastUpdateId,
          bids: d.bids.map(num), asks: d.asks.map(num),
          ...note,
        },
      };
    }

    case 'trades': {
      if (!symbol) throw new Error('symbol 이 필요합니다.');
      const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 1000);
      const d = await request('/api/v3/trades', { symbol, limit });
      return {
        endpoint: '/api/v3/trades',
        data: {
          symbol, count: d.length,
          records: d.map(t => ({
            id: t.id, price: Number(t.price), qty: Number(t.qty),
            quoteQty: Number(t.quoteQty), date: msToStamp(t.time),
            // The venue reports the MAKER side; the taker — the side that moved the price — is
            // its opposite. Naming it here keeps every caller from re-deriving it backwards.
            takerSide: t.isBuyerMaker ? 'sell' : 'buy',
          })),
          ...note,
        },
      };
    }

    case 'agg_trades': {
      if (!symbol) throw new Error('symbol 이 필요합니다.');
      const limit = Math.min(Math.max(Number(input.limit) || 500, 1), 1000);
      const d = await request('/api/v3/aggTrades', {
        symbol, limit, startTime: toMs(input.start ?? input.startTime), endTime: toMs(input.end ?? input.endTime),
      });
      return {
        endpoint: '/api/v3/aggTrades',
        data: {
          symbol, count: d.length,
          records: d.map(t => ({
            id: t.a, price: Number(t.p), qty: Number(t.q),
            date: msToStamp(t.T), takerSide: t.m ? 'sell' : 'buy',
          })),
          ...note,
        },
      };
    }

    case 'screen': {
      const top = Math.min(Math.max(Number(input.top) || 30, 1), 200);
      const minTurnover = Number(input.minTurnover) || 0;
      const all = await request('/api/v3/ticker/24hr', {});
      const inQuote = all.filter(t => t.symbol.endsWith(quote) && t.symbol.length > quote.length);
      // A turnover ranking answers "what is moving", and the heaviest pair on the venue is one
      // stablecoin against another — enormous volume, no price movement, top of every list. Upbit
      // had the same shape of problem with alert-flagged pairs. Drop them unless asked for, and
      // say how many were dropped: a screen that quietly removes rows reads as a complete list.
      const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EURI', 'XUSD']);
      const keepStable = input.includeStable === true;
      const isStablePair = t => STABLE.has(quote) && STABLE.has(t.symbol.slice(0, -quote.length));
      const dropped = keepStable ? 0 : inQuote.filter(isStablePair).length;
      const rows = (keepStable ? inQuote : inQuote.filter(t => !isStablePair(t)))
        .map(toScreenRow)
        .filter(r => r.quoteVolume >= minTurnover)
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, top);
      return {
        endpoint: '/api/v3/ticker/24hr',
        data: {
          quote, count: rows.length, sortedBy: 'quoteVolume(24h)',
          ...(dropped ? { stablePairsExcluded: dropped } : {}),
          records: rows,
        },
      };
    }

    case 'symbols': {
      const d = await request('/api/v3/exchangeInfo', { permissions: 'SPOT', showPermissionSets: 'false' });
      const q = input.quote ? quote : null;
      const rows = d.symbols
        .filter(s => s.status === 'TRADING' && (!q || s.quoteAsset === q))
        .map(s => ({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset }));
      return { endpoint: '/api/v3/exchangeInfo', data: { count: rows.length, records: rows } };
    }

    case 'server_time': {
      const d = await request('/api/v3/time');
      return { endpoint: '/api/v3/time', data: { serverTime: d.serverTime, utc: msToStamp(d.serverTime) } };
    }

    default:
      throw new Error(
        `'${action}' 은 이 모듈의 액션이 아닙니다. 쓸 수 있는 액션: get_candles, ticker, ticker_24h, ` +
        `book_ticker, avg_price, orderbook, trades, agg_trades, screen, symbols, server_time.`
      );
  }
}

export async function main(input) {
  try {
    const out = await dispatch(input || {});
    console.log(JSON.stringify({ success: true, action: input.action, ...out }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, action: input && input.action, error: err.message }));
    process.exitCode = 1;
  }
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const parsed = JSON.parse(raw);
    await main(parsed.data ?? parsed);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: `입력을 읽지 못했습니다: ${err.message}` }));
    process.exit(1);
  }
});

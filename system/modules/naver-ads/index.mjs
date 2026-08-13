/**
 * Firebat System Module: naver-ads (keyword-analytics)
 * Naver Search Ad API — keyword research (volume / clicks / competition / CPC), performance stats,
 * bid simulation, bizmoney, and campaign/adgroup/keyword/ad management.
 *
 * Official docs: https://naver.github.io/searchad-apidoc/
 * Auth: HMAC-SHA256 (X-API-KEY, X-Customer, X-Timestamp, X-Signature)
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BASE = 'https://api.searchad.naver.com';
const TIMEOUT = 45000;

// Vendor caps, documented per endpoint. They are the vendor's, not ours — we chunk around them
// instead of pushing the limit onto the caller, because a 200-keyword study is one question.
const HINT_CAP = 5;        // /keywordstool hintKeywords
const ESTIMATE_CAP = 200;  // /estimate/* items
const MANAGED_CAP = 100;   // /ncc/managedKeyword (undocumented; kept inside sane URL length)
const RELATED_DEFAULT = 100;
const RELATED_MAX = 1000;

/**
 * Seasonal theme codes for the `/keywordstool` `event` parameter, transcribed from the official
 * RelKwdStat doc. The API takes the id but publishes the table nowhere machine-readable, so a
 * caller who does not already know "장마 = 5" cannot use the parameter at all. Shipping the table
 * here is what makes `event` reachable; `seasonal-events` hands it back on request.
 * Rows: [id, nameKo, nameEn, parentId, level].
 */
const SEASONAL_EVENTS = [
  [1, '생활', 'Living', 0, 1],
  [3, '가전', 'Home Appliances', 1, 2],
  [5, '장마', 'Rainy Season', 1, 2],
  [6, '난방/방한', 'Heating', 1, 2],
  [7, '방충', 'Insect', 1, 2],
  [8, '냉방', 'Cooling', 1, 2],
  [10, '유아/아동', 'Baby & Kids', 1, 2],
  [12, '자동차', 'Vehicles', 1, 2],
  [14, '취업', 'Jobs', 1, 2],
  [16, '수공예', 'Handmade', 1, 2],
  [17, '낚시', 'Fishing', 1, 2],
  [18, '원예', 'Horticulture', 1, 2],
  [20, '영화/공연', 'Movies & Entertainment', 1, 2],
  [22, '침구', 'Bedding', 1, 2],
  [23, '생활용품', 'Household Goods', 1, 2],
  [24, '건강', 'Health', 0, 1],
  [26, '건강', 'Health', 24, 2],
  [27, '레저/스포츠', 'Leisure & Sports', 0, 1],
  [29, '프로야구', 'Baseball', 27, 2],
  [30, '등산', 'Climbing', 27, 2],
  [31, '스키/보드', 'Skiing & Snowboarding', 27, 2],
  [32, '수상스포츠', 'Aquatic Sports', 27, 2],
  [33, '스포츠', 'Sports', 27, 2],
  [34, '자전거', 'Bicycles', 27, 2],
  [35, '시기', 'Seasons', 0, 1],
  [37, '설', 'Korean New Year', 35, 2],
  [38, '추석', 'Chuseok', 35, 2],
  [39, '스승의날', "Teachers' Day", 35, 2],
  [40, '어린이날', "Children's Day", 35, 2],
  [41, '화이트데이', 'White Day', 35, 2],
  [42, '크리스마스', 'Christmas', 35, 2],
  [43, '발렌타인데이', "Valentine's Day", 35, 2],
  [44, '어버이날', "Mother's Day & Father's Day", 35, 2],
  [45, '성년의날', 'Coming of Age Day', 35, 2],
  [46, '할로윈', 'Halloween', 35, 2],
  [47, '빼빼로데이', 'Pepero Day', 35, 2],
  [49, '축제/행사', 'Festivals & Events', 35, 2],
  [50, '벚꽃', 'Cherry Blossom Season', 35, 2],
  [52, '봄', 'Spring', 35, 2],
  [53, '가을', 'Fall', 35, 2],
  [54, '겨울', 'Winter', 35, 2],
  [55, '새해/운세', 'New Year & Fortune', 35, 2],
  [56, '연말', 'Year End', 35, 2],
  [57, '여름', 'Summer', 35, 2],
  [58, '교육/학교', 'Education & School', 0, 1],
  [60, '졸업', 'Graduation', 58, 2],
  [61, '학원', 'Private Institutes', 58, 2],
  [62, '학교행사', 'School Events', 58, 2],
  [63, '대입/수능', 'Admissions & SAT Tests', 58, 2],
  [64, '교재/교구', 'Teaching Materials & Aids', 58, 2],
  [65, '입학/개학', 'Entrance & New Semester', 58, 2],
  [66, '과제', 'School Assignments', 58, 2],
  [67, '농업', 'Farming', 0, 1],
  [69, '식물', 'Plants', 67, 2],
  [70, '음식/요리', 'Food & Cooking', 0, 1],
  [72, '건강식품', 'Health Supplements', 70, 2],
  [73, '농산물/수산물', 'Agricultural & Fishery', 70, 2],
  [74, '음식점', 'Restaurants', 70, 2],
  [75, '음식', 'Food', 70, 2],
  [76, '기호식품', 'Refreshment', 70, 2],
  [77, '패션/미용', 'Fashion & Beauty', 0, 1],
  [79, '패션', 'Fashion', 77, 2],
  [80, '미용', 'Beauty', 77, 2],
  [81, '여행', 'Outdoors', 0, 1],
  [83, '여행', 'Travel', 81, 2],
  [84, '캠핑', 'Camping', 81, 2],
  [85, '피크닉', 'Picnic', 81, 2],
  [86, '반려동물', 'Pet', 1, 2],
];

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });

/** i18n error — main's catch extracts errorKey/errorParams. */
class I18nError extends Error {
  constructor(key, params) {
    super(key);
    this.errorKey = key;
    this.errorParams = params || {};
  }
}

/** i18n error response — errorKey + errorParams. resolve_sysmod_error maps module.naver-ads.{key}. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action || 'keyword-tool';

    // `seasonal-events` is a static table shipped with this module — no credentials needed, and
    // demanding them would make the one action that explains a parameter fail for a caller who is
    // still setting the keys up.
    if (action === 'seasonal-events') return handleSeasonalEvents(data);

    const accessLicense = process.env['NAVER_AD_ACCESS_LICENSE_KEY'];
    const secretKey = process.env['NAVER_AD_SECRET_KEY'];
    const customerId = process.env['NAVER_AD_CUSTOMER_ID'];
    if (!accessLicense || !secretKey || !customerId) {
      return outErr('error.api_key_missing', {});
    }

    // Naver's own naming: what the console labels "Access License" is what the signature calls the
    // API key. Keeping the console's word here avoids the mismatch users hit when copying keys.
    const ctx = { apiKey: accessLicense, secretKey, customerId };

    switch (action) {
      case 'keyword-tool': return await handleKeywordTool(ctx, data);
      case 'estimate': return await handleEstimate(ctx, data);
      case 'managed-keywords': return await handleManagedKeywords(ctx, data);
      case 'biz-categories': return await handleBizCategories(ctx, data);
      case 'stats': return await handleStats(ctx, data);
      case 'bizmoney': return await handleBizmoney(ctx, data);
      // Campaign management
      case 'list-campaigns': return await handleList(ctx, '/api/ncc/campaigns', data);
      case 'get-campaign': return await handleGet(ctx, `/api/ncc/campaigns/${data.id}`, data);
      // Adgroup management
      case 'list-adgroups': return await handleList(ctx, '/api/ncc/adgroups', data);
      case 'get-adgroup': return await handleGet(ctx, `/api/ncc/adgroups/${data.id}`, data);
      // Keyword management
      case 'list-keywords': return await handleList(ctx, '/api/ncc/keywords', data);
      case 'get-keyword': return await handleGet(ctx, `/api/ncc/keywords/${data.id}`, data);
      // Ad management
      case 'list-ads': return await handleList(ctx, '/api/ncc/ads', data);
      case 'get-ad': return await handleGet(ctx, `/api/ncc/ads/${data.id}`, data);
      // Biz channels
      case 'list-channels': return await handleList(ctx, '/api/ncc/channels', data);
      // Ad extensions
      case 'list-extensions': return await handleList(ctx, '/api/ncc/ad-extensions', data);
      // Labels
      case 'list-labels': return await handleGet(ctx, '/api/ncc/labels', data);
      // Shared budgets
      case 'list-shared-budgets': return await handleGet(ctx, '/api/ncc/shared-budgets', data);
      // Direct API call
      case 'raw': return await handleRaw(ctx, data);
      default: return outErr('error.unknown_action', { action: String(action) });
    }
  } catch (e) {
    if (e instanceof I18nError) outErr(e.errorKey, e.errorParams);
    else outErr('error.runtime', { message: e.message });
  }
});

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

function sign(timestamp, method, uri, secretKey) {
  return crypto.createHmac('sha256', secretKey).update(`${timestamp}.${method}.${uri}`).digest('base64');
}

function authHeaders(ctx, method, uri) {
  const timestamp = String(Date.now());
  return {
    'X-API-KEY': ctx.apiKey,
    'X-Customer': ctx.customerId,
    'X-Timestamp': timestamp,
    'X-Signature': sign(timestamp, method, uri, ctx.secretKey),
  };
}

async function api(ctx, method, uri, queryParams, body) {
  const headers = authHeaders(ctx, method, uri);
  if (body) headers['Content-Type'] = 'application/json';

  let url = `${BASE}${uri}`;
  if (queryParams) {
    const qs = new URLSearchParams(queryParams);
    url += `?${qs}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    // Secret masking is one gate in Rust AiManager (`core/src/utils/redactor.rs`); per-module
    // sanitizing is unnecessary — the body is forwarded and passes that gate before the user sees it.
    throw new I18nError('error.api_status', { status: String(resp.status), body: t });
  }

  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Value decoding ───────────────────────────────────────────────────────────
// Two of Naver's conventions look like data but are absence, and both read as "this keyword is
// dead" if passed through as a number:
//   monthlyPcQcCnt / monthlyMobileQcCnt -> the string "< 10" when the count is under 10
//   click / CTR / depth                 -> literal 0 when there is no data at all
// The first is decoded to null with a flag; the second cannot be told apart from a real zero by
// any field the API returns, so it stays 0 and the response says so in a note.

/** Query count. Returns {value, masked} — masked means "under 10", NOT zero. */
function qc(v) {
  if (v === null || v === undefined) return { value: null, masked: false };
  const s = String(v).trim();
  if (s.includes('<')) return { value: null, masked: true };
  const n = Number(s.replace(/,/g, ''));
  return { value: Number.isFinite(n) ? n : null, masked: false };
}

function num(v) {
  const n = Number(String(v ?? 0).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** A keyword the caller supplied: a bare string, or a row carrying one (cache-key expansion). */
function keywordOf(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    for (const f of ['keyword', 'relKeyword', 'relatedKeyword', 'name', 'query']) {
      if (typeof item[f] === 'string' && item[f].trim()) return item[f];
    }
  }
  return '';
}

/**
 * Normalizes the `keywords` input. Accepts bare strings and rows, because `cacheInputs` lets a
 * previous keyword-tool result arrive here as objects — feeding 200 analyzed keywords back into
 * a bid lookup should not require retyping them.
 * `stripSpaces` applies to /keywordstool hints only: that endpoint rejects hints containing a space.
 */
function normalizeKeywords(input, stripSpaces) {
  const list = Array.isArray(input) ? input : (input === undefined || input === null ? [] : [input]);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    let k = keywordOf(item).trim();
    if (stripSpaces) k = k.replace(/\s+/g, '');
    if (!k) continue;
    const dedupe = k.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(k);
  }
  return out;
}

// ── Keyword tool ─────────────────────────────────────────────────────────────
async function handleKeywordTool(ctx, data) {
  const hints = normalizeKeywords(data?.keywords, true);
  const biztpId = data.biztpId;
  const siteId = data.siteId;
  const event = data.event;

  // The docs say a request is "at least one parameter among business ID, ncc business channel ID,
  // keyword hints, season, event ID" — hints are one entry, not the entry. Demanding them closed
  // the whole discovery path (a category or a season alone returns its keyword universe).
  if (hints.length === 0 && biztpId === undefined && !siteId && event === undefined) {
    return outErr('error.keyword_tool_entry_required', {});
  }

  const notes = [];
  const shared = {};
  if (data.showDetail !== false) shared.showDetail = '1';
  if (siteId) shared.siteId = String(siteId);
  if (biztpId !== undefined) shared.biztpId = String(biztpId);
  if (event !== undefined) shared.event = String(event);
  if (data.month !== undefined) shared.month = String(data.month);

  // Hints are capped at 5 per call by the vendor. Chunking here keeps "analyze these 30 keywords"
  // a single question instead of six calls the caller has to compose and merge.
  const batches = hints.length > 0 ? chunk(hints, HINT_CAP) : [null];
  if (batches.length > 1) {
    notes.push(`${hints.length} hint keywords were sent in ${batches.length} calls (vendor cap is ${HINT_CAP} per call) and merged.`);
  }

  const merged = new Map();
  for (const batch of batches) {
    const params = { ...shared };
    if (batch) params.hintKeywords = batch.join(',');
    const json = await api(ctx, 'GET', '/keywordstool', params);
    for (const item of (json.keywordList || [])) {
      const row = shapeKeywordRow(item);
      if (!row.keyword) continue;
      if (!merged.has(row.keyword.toLowerCase())) merged.set(row.keyword.toLowerCase(), row);
    }
  }

  const all = [...merged.values()];
  const hintSet = new Set(hints.map(k => k.toLowerCase()));
  // Hints are matched space-insensitively: the vendor strips spaces from the hint, so the row it
  // returns for "캠핑 용품" comes back as "캠핑용품" and would otherwise land in `relatedKeywords`.
  const isHint = (r) => hintSet.has(String(r.keyword).replace(/\s+/g, '').toLowerCase());
  const exact = all.filter(isHint);
  const relatedAll = all.filter(r => !isHint(r));

  const limit = Math.min(Math.max(Number(data.limit ?? RELATED_DEFAULT) || RELATED_DEFAULT, 1), RELATED_MAX);
  const related = relatedAll.slice(0, limit);
  if (relatedAll.length > related.length) {
    notes.push(`Related keywords: ${relatedAll.length} returned, ${related.length} included (limit=${limit}, max ${RELATED_MAX}). Raise \`limit\` for the rest — the ones dropped are the lowest-ranked, not a random sample.`);
  }

  const rows = [...exact, ...related];

  if (data.withFlags) {
    const flagNote = await attachFlags(ctx, rows);
    if (flagNote) notes.push(flagNote);
  }
  if (data.withBid) {
    const bidNotes = await attachBids(ctx, rows, data);
    notes.push(...bidNotes);
  }

  notes.push(
    'Reading the numbers: search counts are the SUM over the last 30 days, while click counts and CTR are the AVERAGE over the last 4 weeks — they have different bases, so do not divide one by the other to recompute CTR.',
    'A null search count means the vendor returned "< 10" (fewer than 10 searches), which is NOT zero. `qcMasked` names which side was masked, and a total containing one is a lower bound.',
    'A 0 in click count, CTR, or plAvgDepth means "no data", not measured-zero performance — the API returns 0 for both and does not distinguish them.',
    'compIdx and plAvgDepth are computed from PC ads only; there is no mobile competition index in this API, even for keywords whose searches are mostly mobile.',
  );

  out(true, { keywords: exact, relatedKeywords: related, _note: notes.join(' ') });
}

function shapeKeywordRow(item) {
  const pc = qc(item.monthlyPcQcCnt);
  const mo = qc(item.monthlyMobileQcCnt);
  const row = {
    keyword: item.relKeyword,
    monthlyPcQcCnt: pc.value,
    monthlyMobileQcCnt: mo.value,
    monthlyTotalQcCnt: (pc.value === null && mo.value === null) ? null : (pc.value ?? 0) + (mo.value ?? 0),
    monthlyAvePcClkCnt: num(item.monthlyAvePcClkCnt),
    monthlyAveMobileClkCnt: num(item.monthlyAveMobileClkCnt),
    monthlyAvePcCtr: num(item.monthlyAvePcCtr),
    monthlyAveMobileCtr: num(item.monthlyAveMobileCtr),
    plAvgDepth: num(item.plAvgDepth),
    compIdx: item.compIdx || '',
    // Relevance to the hint keyword. Undocumented but present; used for ranking suggestions.
    relatedPoint: item.related_point ?? null,
  };
  if (pc.masked || mo.masked) {
    row.qcMasked = pc.masked && mo.masked ? 'both' : (pc.masked ? 'pc' : 'mobile');
  }
  // showDetail=1 adds per-month history. Undocumented shape, so it is passed through as-is.
  if (item.monthlyPcQcCntList) row.monthlyPcQcCntList = item.monthlyPcQcCntList;
  if (item.monthlyMobileQcCntList) row.monthlyMobileQcCntList = item.monthlyMobileQcCntList;
  return row;
}

// ── Keyword tool: restriction flags ──────────────────────────────────────────
/** Attaches ManagedKeyword flags. These explain WHY a keyword has no numbers. */
async function attachFlags(ctx, rows) {
  const words = rows.map(r => r.keyword).filter(Boolean);
  if (words.length === 0) return null;
  const byKeyword = new Map();
  try {
    for (const batch of chunk(words, MANAGED_CAP)) {
      const json = await api(ctx, 'GET', '/ncc/managedKeyword', { keywords: batch.join(',') });
      for (const m of (Array.isArray(json) ? json : (json?.managedKeywordList || []))) {
        if (m && m.keyword) byKeyword.set(String(m.keyword).toLowerCase(), m);
      }
    }
  } catch (e) {
    // A flag lookup failing must not throw away the volume data the caller actually asked for —
    // but staying silent about it would let a keyword with no flags read as "no restrictions".
    return `withFlags failed and no flags are attached: ${e.errorParams?.body || e.message}. The volume figures below are unaffected.`;
  }
  for (const r of rows) {
    const m = byKeyword.get(String(r.keyword).toLowerCase());
    if (!m) continue;
    r.isLowSearchVolume = !!m.isLowSearchVolume;
    r.isRestricted = !!m.isRestricted;
    r.isAdult = !!m.isAdult;
    r.isSellProhibit = !!m.isSellProhibit;
    r.isSeason = !!m.isSeason;
  }
  return `Flags attached for ${byKeyword.size} of ${words.length} keywords. isLowSearchVolume confirms a masked (null) search count; isRestricted / isAdult / isSellProhibit mean ads cannot run on that keyword at all, whatever its volume.`;
}

// ── Keyword tool: CPC ────────────────────────────────────────────────────────
/**
 * Attaches estimated bids. This is where CPC comes from: `/keywordstool` does not return one.
 *   exposure-minimum-bid = the least you can bid and still be shown
 *   median-bid           = the middle of what is actually being bid
 * Both take 200 keywords per call against the vendor's 5-hint keyword tool, so a wide study costs
 * few calls.
 */
async function attachBids(ctx, rows, data) {
  const notes = [];
  const words = rows.map(r => r.keyword).filter(Boolean);
  if (words.length === 0) return notes;

  const period = data.bidPeriod === 'DAY' ? 'DAY' : 'MONTH';
  const devices = data.bidDevice ? [data.bidDevice] : ['PC', 'MOBILE'];
  const kinds = [
    ['exposure-minimum-bid', 'minBid'],
    ['median-bid', 'medianBid'],
  ];

  for (const [endpoint, field] of kinds) {
    for (const device of devices) {
      const prop = `${field}${device === 'PC' ? 'Pc' : 'Mobile'}`;
      try {
        const found = new Map();
        let unknownShape = null;
        for (const batch of chunk(words, ESTIMATE_CAP)) {
          const json = await api(ctx, 'POST', `/estimate/${endpoint}/keyword`, null, {
            device, period, items: batch,
          });
          const { map, shape } = indexBids(json);
          for (const [k, v] of map) found.set(k, v);
          if (shape && found.size === 0) unknownShape = shape;
        }
        if (found.size === 0 && unknownShape) {
          // The absorber must not swallow the failure: naming the fields that DID come back is the
          // difference between "no data" and "we read the wrong field".
          notes.push(`${endpoint} (${device}) returned rows this module could not read — no keyword/bid pair was found. Actual fields present: ${unknownShape.join(', ')}.`);
          continue;
        }
        for (const r of rows) {
          const v = found.get(String(r.keyword).toLowerCase());
          if (v !== undefined) r[prop] = v;
        }
      } catch (e) {
        notes.push(`${endpoint} (${device}) failed: ${e.errorParams?.body || e.message}. The other columns are unaffected.`);
      }
    }
  }
  notes.push('minBid* is the minimum bid that still gets the ad shown; medianBid* is the middle of current bids. Both are estimates in KRW per click for the stated device, over ' + (period === 'DAY' ? 'yesterday' : 'the last 28 days') + '.');
  return notes;
}

/**
 * Indexes an `/estimate/*` response by keyword. The documented element is `Bid`
 * {keyword, nccKeywordId, bid}; the alternates below cover `EstimateBidByPosition`, which carries
 * the same two fields alongside `position`. When nothing can be indexed the actual field names are
 * returned, so the caller reports what came back rather than an empty result.
 */
function indexBids(json) {
  const arr = Array.isArray(json?.estimate) ? json.estimate : (Array.isArray(json) ? json : []);
  const map = new Map();
  let shape = null;
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const kw = row.keyword ?? row.key ?? row.relKeyword;
    const bid = row.bid ?? row.bidAmt;
    if (kw === undefined || bid === undefined) {
      if (!shape) shape = Object.keys(row);
      continue;
    }
    map.set(String(kw).toLowerCase(), Number(bid));
  }
  return { map, shape };
}

// ── Bid simulation ───────────────────────────────────────────────────────────
async function handleEstimate(ctx, data) {
  const estimateType = data.estimateType || 'exposure-minimum-bid';
  const keyType = data.keyType || 'keyword';
  const device = data.device || 'PC';
  const period = data.period === 'DAY' ? 'DAY' : 'MONTH';

  // `items` is the shape every list endpoint takes. Sending a bare `key` was rejected by all three
  // of them; the caller may still pass a single `key` and it is lifted into the list here.
  const keys = normalizeKeywords(
    data.keywords !== undefined ? data.keywords : (data.key !== undefined ? [data.key] : []),
    false,
  );

  if (estimateType === 'exposure-minimum-bid' || estimateType === 'median-bid') {
    if (keys.length === 0) return outErr('error.estimate_keys_required', { estimateType });
    const estimate = [];
    for (const batch of chunk(keys, ESTIMATE_CAP)) {
      const json = await api(ctx, 'POST', `/estimate/${estimateType}/${keyType}`, null, {
        device, period, items: batch,
      });
      if (Array.isArray(json?.estimate)) estimate.push(...json.estimate);
      else if (Array.isArray(json)) estimate.push(...json);
    }
    return out(true, { device, period, estimate, _note: estimateNote(keys.length, estimate.length, period) });
  }

  if (estimateType === 'average-position-bid') {
    // items are {key, position}; position is 1~10 on PC and 1~5 on MOBILE.
    const position = Number(data.position ?? 1);
    const maxPos = device === 'MOBILE' ? 5 : 10;
    if (!Number.isFinite(position) || position < 1 || position > maxPos) {
      return outErr('error.position_out_of_range', { device, max: String(maxPos) });
    }
    if (keys.length === 0) return outErr('error.estimate_keys_required', { estimateType });
    const estimate = [];
    for (const batch of chunk(keys, ESTIMATE_CAP)) {
      const json = await api(ctx, 'POST', `/estimate/average-position-bid/${keyType}`, null, {
        device, items: batch.map(k => ({ key: k, position })),
      });
      if (Array.isArray(json?.estimate)) estimate.push(...json.estimate);
      else if (Array.isArray(json)) estimate.push(...json);
    }
    return out(true, { device, position, estimate, _note: estimateNote(keys.length, estimate.length, null) });
  }

  if (estimateType === 'performance') {
    // One key, many bids: the response is the bid-to-outcome curve for that keyword.
    if (keys.length === 0) return outErr('error.estimate_keys_required', { estimateType });
    const bids = (Array.isArray(data.bids) ? data.bids : (data.bid !== undefined ? [data.bid] : []))
      .map(Number).filter(n => Number.isFinite(n)).slice(0, 100);
    if (bids.length === 0) return outErr('error.bids_required', {});
    const json = await api(ctx, 'POST', `/estimate/performance/${keyType}`, null, {
      device, key: keys[0], bids,
    });
    if (keys.length > 1) json._note = `Only the first key ("${keys[0]}") was simulated — this endpoint takes one key with many bids. Use estimateType "performance-bulk" for many keys.`;
    return out(true, json);
  }

  if (estimateType === 'performance-bulk') {
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return outErr('error.items_required', {});
    }
    const items = [];
    for (const batch of chunk(data.items, ESTIMATE_CAP)) {
      const json = await api(ctx, 'POST', '/estimate/performance-bulk', null, { items: batch });
      if (Array.isArray(json?.items)) items.push(...json.items);
    }
    return out(true, { items });
  }

  return outErr('error.unknown_estimate_type', { estimateType: String(estimateType) });
}

function estimateNote(asked, got, period) {
  const parts = [`Asked for ${asked} keywords, ${got} came back — the API omits keywords it has no data for rather than returning a zero row.`];
  if (period) parts.push(`period "${period}" = ${period === 'DAY' ? "yesterday's" : "the last 28 days'"} statistics.`);
  parts.push('`bid` is the estimated cost per click in KRW.');
  return parts.join(' ');
}

// ── Managed keyword flags ────────────────────────────────────────────────────
async function handleManagedKeywords(ctx, data) {
  const words = normalizeKeywords(data?.keywords, false);
  if (words.length === 0) return outErr('error.keywords_required', {});
  const rows = [];
  for (const batch of chunk(words, MANAGED_CAP)) {
    const json = await api(ctx, 'GET', '/ncc/managedKeyword', { keywords: batch.join(',') });
    const list = Array.isArray(json) ? json : (json?.managedKeywordList || []);
    rows.push(...list);
  }
  out(true, {
    rows,
    _note: 'isLowSearchVolume: the keyword tool masks this keyword\'s count as "< 10". isRestricted / isAdult / isSellProhibit: ads cannot run on it. isSeason: demand is seasonal, so a 30-day figure taken off-season understates it. Keywords absent from `rows` are simply unmanaged, which is not a restriction.',
  });
}

// ── Seasonal event codes ─────────────────────────────────────────────────────
function handleSeasonalEvents(data) {
  const q = String(data?.query || '').trim().toLowerCase();
  let rows = SEASONAL_EVENTS.map(([id, ko, en, parentId, level]) => ({ id, name: ko, nameEn: en, parentId, level }));
  if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || r.nameEn.toLowerCase().includes(q));
  out(true, {
    rows,
    _note: 'Pass `id` as the `event` parameter of keyword-tool to get that theme\'s keyword universe (optionally with `month`). Level 1 rows are top categories and level 2 rows are themes; parentId points at the level 1 row.',
  });
}

// ── Business category codes (master report) ──────────────────────────────────
const BIZ_CACHE = path.join('data', 'naver-ads', 'biz-categories.json');

/**
 * Business category ids for the keyword tool's `biztpId`. The value has been a declared parameter
 * all along, but the only place the id list exists is a Master Report job — so a caller had to
 * invent an id or leave the parameter unused. This action is what publishes that vocabulary.
 * The tree barely changes, so the first successful fetch is cached on disk.
 */
async function handleBizCategories(ctx, data) {
  if (!data.refresh && !data.jobId) {
    try {
      const cached = JSON.parse(fs.readFileSync(BIZ_CACHE, 'utf-8'));
      if (Array.isArray(cached?.rows) && cached.rows.length > 0) {
        return out(true, { ...filterBiz(cached, data), cachedAt: cached.cachedAt, _note: bizNote(true) });
      }
    } catch { /* no cache yet — build the job below */ }
  }

  let job;
  if (data.jobId) {
    job = await api(ctx, 'GET', `/master-reports/${data.jobId}`);
  } else {
    job = await api(ctx, 'POST', '/master-reports', null, { item: 'Biz' });
  }

  // The job is asynchronous. Polling is bounded so the call returns something useful either way:
  // a finished table, or the job id to ask again with.
  const deadline = Date.now() + 30000;
  while (job && job.status !== 'BUILT' && job.status !== 'ERROR' && job.status !== 'NONE' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    job = await api(ctx, 'GET', `/master-reports/${job.id}`);
  }

  if (!job || job.status !== 'BUILT' || !job.downloadUrl) {
    return out(true, {
      jobId: job?.id ?? null,
      status: job?.status ?? 'UNKNOWN',
      rows: [],
      _note: job?.status === 'ERROR'
        ? 'The master report job failed on Naver\'s side. Call again to register a new job.'
        : `The master report job is still ${job?.status ?? 'pending'}. Call biz-categories again with jobId "${job?.id}" in a moment.`,
    });
  }

  const tsv = await downloadReport(ctx, job.downloadUrl);
  const rows = parseBizTsv(tsv);
  const payload = { rows, cachedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(BIZ_CACHE), { recursive: true });
    fs.writeFileSync(BIZ_CACHE, JSON.stringify(payload), 'utf-8');
  } catch { /* cache is an optimization; a read-only workspace must not fail the call */ }

  out(true, { ...filterBiz(payload, data), cachedAt: payload.cachedAt, _note: bizNote(false) });
}

function filterBiz(payload, data) {
  const q = String(data?.query || '').trim().toLowerCase();
  let rows = payload.rows;
  if (q) rows = rows.filter(r => String(r.name).toLowerCase().includes(q));
  return { rows };
}

function bizNote(fromCache) {
  return `Pass \`id\` as the \`biztpId\` parameter of keyword-tool to get that industry's keyword universe. \`parentId\` and \`level\` describe the tree.${fromCache ? ' Served from the on-disk copy; pass refresh:true to rebuild it from Naver.' : ''}`;
}

/** Master report files are headerless TSV. Biz columns: ID, BusinessName, SuperBusinessId, Level. */
function parseBizTsv(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 4) continue;
    const id = Number(cols[0]);
    if (!Number.isFinite(id)) continue; // skips a header row if one is ever added
    rows.push({ id, name: cols[1], parentId: Number(cols[2]), level: Number(cols[3]) });
  }
  return rows;
}

async function downloadReport(ctx, downloadUrl) {
  const u = new URL(downloadUrl);
  const headers = u.host === new URL(BASE).host
    ? authHeaders(ctx, 'GET', u.pathname)
    : {};
  const resp = await fetch(downloadUrl, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new I18nError('error.api_status', { status: String(resp.status), body: t });
  }
  return await resp.text();
}

// ── Performance stats ────────────────────────────────────────────────────────
async function handleStats(ctx, data) {
  const params = {};
  if (data.ids) params.ids = Array.isArray(data.ids) ? data.ids.join(',') : data.ids;
  else if (data.id) params.id = data.id;
  else return outErr('error.id_required', {});

  if (data.fields) params.fields = JSON.stringify(data.fields);
  if (data.timeRange) params.timeRange = typeof data.timeRange === 'string' ? data.timeRange : JSON.stringify(data.timeRange);
  if (data.datePreset) params.datePreset = data.datePreset;
  if (data.timeIncrement) params.timeIncrement = data.timeIncrement;
  if (data.breakdown) params.breakdown = data.breakdown;
  if (data.statType) params.statType = data.statType;

  const json = await api(ctx, 'GET', '/api/stats', params);
  out(true, json);
}

// ── Bizmoney ─────────────────────────────────────────────────────────────────
async function handleBizmoney(ctx, data) {
  const subAction = data.subAction || 'balance';

  if (subAction === 'balance') {
    const json = await api(ctx, 'GET', '/api/billing/bizmoney');
    return out(true, json);
  }

  const PATHS = {
    'charge-history': '/api/billing/bizmoney/histories/charge',
    'exhaust-history': '/api/billing/bizmoney/histories/exhaust',
    'period-history': '/api/billing/bizmoney/histories/period',
  };

  const path = PATHS[subAction];
  if (!path) return outErr('error.unknown_subaction', { subAction: String(subAction) });

  const params = {};
  if (data.searchStartDt) params.searchStartDt = data.searchStartDt;
  if (data.searchEndDt) params.searchEndDt = data.searchEndDt;

  const json = await api(ctx, 'GET', path, params);
  out(true, json);
}

// ── Generic list ─────────────────────────────────────────────────────────────
async function handleList(ctx, uri, data) {
  const params = {};
  if (data.nccCampaignId) params.nccCampaignId = data.nccCampaignId;
  if (data.nccAdgroupId) params.nccAdgroupId = data.nccAdgroupId;
  if (data.campaignType) params.campaignType = data.campaignType;
  if (data.ownerId) params.ownerId = data.ownerId;
  if (data.ids) params.ids = Array.isArray(data.ids) ? data.ids.join(',') : data.ids;
  if (data.nccLabelId) params.nccLabelId = data.nccLabelId;
  if (data.channelTp) params.channelTp = data.channelTp;
  if (data.recordSize) params.recordSize = String(data.recordSize);
  if (data.selector) params.selector = data.selector;

  const json = await api(ctx, 'GET', uri, Object.keys(params).length > 0 ? params : null);
  out(true, json);
}

// ── Generic get ──────────────────────────────────────────────────────────────
async function handleGet(ctx, uri, data) {
  const json = await api(ctx, 'GET', uri);
  out(true, json);
}

// ── Raw API call ─────────────────────────────────────────────────────────────
async function handleRaw(ctx, data) {
  const method = (data.method || 'GET').toUpperCase();
  const uri = data.uri;
  if (!uri) return outErr('error.uri_required', {});

  // POST / PUT / PATCH need a body (Naver answers `failed to parse body` otherwise); GET / DELETE
  // are fine without one.
  const requiresBody = ['POST', 'PUT', 'PATCH'].includes(method);
  if (requiresBody && (!data.body || Object.keys(data.body).length === 0)) {
    return outErr('error.raw_body_required', { method });
  }

  const json = await api(ctx, method, uri, data.params || null, data.body || null);
  out(true, json);
}

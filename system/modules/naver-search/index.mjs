/**
 * Firebat System Module: naver-search (web-search)
 * Naver Search API (NAVER API HUB) + DataLab API
 *
 * Search: webkr, blog, news, image, cafearticle, kin, encyc, local
 * Utility: adult (adult-term check), errata (keyboard-layout typo correction)
 * DataLab: search-trend, shopping-categories, shopping-keywords,
 *          shopping-by-device/gender/age
 *
 * The search side moved to NAVER API HUB on NAVER Cloud Platform: a different host, a reversed
 * path (`/search/v1/{type}` where the developer centre had `/v1/search/{type}.json`), and
 * different auth headers with a different key. The developer-centre keys keep working until
 * 2027-06-30, but only for the endpoints that migrated.
 *
 * Docs:
 *   Search:  https://api.ncloud-docs.com/docs/ai-application-service-naverapihub
 *   DataLab: https://developers.naver.com/docs/serviceapi/datalab/
 */

import { todayYmd, addDaysYmd } from '../_runtime/tz.mjs';

const HUB_BASE = 'https://naverapihub.apigw.ntruss.com';

/**
 * Search types that did NOT migrate. Naver shut them down on 2026-07-31 with no replacement and
 * no grace period — the old keys stopped working too. Left in the type list they would look like
 * a transient failure and be retried; named here, the error can point at what still answers the
 * underlying question.
 */
const RETIRED_TYPES = {
  shop: '쇼핑',
  book: '도서',
  book_adv: '도서 상세검색',
  doc: '전문자료',
};

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
/** i18n 에러 — main 의 catch 에서 errorKey/errorParams 추출. */
class I18nError extends Error {
  constructor(key, params) {
    super(key);
    this.errorKey = key;
    this.errorParams = params || {};
  }
}

process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);

    const clientId = process.env['NAVER_APIHUB_CLIENT_ID'];
    const clientSecret = process.env['NAVER_APIHUB_CLIENT_SECRET'];
    if (!clientId || !clientSecret) return outErr('error.api_key_missing', {});

    const ctx = { clientId, clientSecret };
    const action = data?.action || 'search';

    // DataLab actions. The category-level and keyword-level splits are separate endpoints and
    // answer different questions, so they are separate actions rather than a flag.
    switch (action) {
      case 'search-trend': return await handleSearchTrend(ctx, data);
      case 'shopping-categories': return await handleShoppingCategories(ctx, data);
      case 'shopping-category-by-device': return await handleCategoryBreakdown(ctx, data, 'device');
      case 'shopping-category-by-gender': return await handleCategoryBreakdown(ctx, data, 'gender');
      case 'shopping-category-by-age': return await handleCategoryBreakdown(ctx, data, 'age');
      case 'shopping-keywords': return await handleShoppingKeywords(ctx, data);
      case 'shopping-by-device': return await handleShoppingBreakdown(ctx, data, 'device');
      case 'shopping-by-gender': return await handleShoppingBreakdown(ctx, data, 'gender');
      case 'shopping-by-age': return await handleShoppingBreakdown(ctx, data, 'age');
    }

    // 검색 액션 (기존)
    const query = data?.query;
    if (!query) return outErr('error.query_required', {});

    const type = data.type || 'webkr';

    if (RETIRED_TYPES[type]) {
      return outErr('error.search_type_retired', { type, label: RETIRED_TYPES[type] });
    }

    // Utility endpoints answer with a single scalar rather than a result list.
    if (type === 'adult' || type === 'errata') {
      return await handleUtility(ctx, type, query);
    }

    await handleSearch(ctx, type, query, data);
  } catch (e) {
    if (e instanceof I18nError) outErr(e.errorKey, e.errorParams);
    else outErr('error.runtime', { message: e.message });
  }
});

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.naver-search.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

const strip = (s) => (s || '').replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** API HUB auth. Both headers are required on every call, GET and POST alike. */
function hubHeaders(ctx, extra) {
  return {
    'X-NCP-APIGW-API-KEY-ID': ctx.clientId,
    'X-NCP-APIGW-API-KEY': ctx.clientSecret,
    ...(extra || {}),
  };
}

// Per-type paging limits and sort vocabulary. `local` is the outlier on every axis: it pages five
// at a time from a fixed start, defaults to one result, and sorts by a different pair of words.
const LIMITS = {
  local: { displayMax: 5, startMax: 1, displayDefault: 1 },
};
const DEFAULT_LIMITS = { displayMax: 100, startMax: 1000, displayDefault: 10 };

const SORTS = {
  news: ['sim', 'date'],
  blog: ['sim', 'date'],
  image: ['sim', 'date'],
  cafearticle: ['sim', 'date'],
  kin: ['sim', 'date', 'point'],
  local: ['random', 'comment'],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  검색 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSearch(ctx, type, query, data) {
  const lim = LIMITS[type] || DEFAULT_LIMITS;
  const display = Math.min(Math.max(data.display || lim.displayDefault, 1), lim.displayMax);
  const start = Math.min(Math.max(data.start || 1, 1), lim.startMax);

  const params = new URLSearchParams({ query, display: String(display), start: String(start) });

  const notes = [];
  // A sort word from the wrong type is rejected with SE04, and the vocabulary differs per type:
  // `local` sorts by random|comment while everything else sorts by sim|date (kin adds point).
  // Dropping an inapplicable value and saying so beats a 400 the caller has to decode.
  if (data.sort) {
    const allowed = SORTS[type];
    if (!allowed) notes.push(`sort was dropped: ${type} search does not take one.`);
    else if (!allowed.includes(data.sort)) notes.push(`sort "${data.sort}" was dropped: ${type} accepts ${allowed.join(' | ')}.`);
    else params.set('sort', data.sort);
  }
  if (type === 'image' && data.filter) params.set('filter', data.filter);
  if (data.display && data.display > lim.displayMax) {
    notes.push(`display was capped at ${lim.displayMax} for ${type} search.`);
  }

  const resp = await fetch(`${HUB_BASE}/search/v1/${type}?${params}`, {
    headers: hubHeaders(ctx),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return outErr('error.search_api_status', { status: String(resp.status), body: t });
  }

  const json = await resp.json();
  const items = (json.items || []).map(item => parseItem(type, item));

  if (type === 'local') {
    notes.push('mapx/mapy are WGS84 longitude/latitude and need no conversion. `telephone` is always empty — the field is kept only for backward compatibility, so its absence is not a missing phone number.');
  }

  const payload = {
    total: json.total || 0,
    start: json.start || start,
    display: json.display || items.length,
    items,
  };
  if (notes.length > 0) payload._note = notes.join(' ');
  out(true, payload);
}

function parseItem(type, item) {
  const base = {
    title: strip(item.title),
    link: item.link || '',
  };

  if (item.description !== undefined) base.description = strip(item.description);

  switch (type) {
    case 'news':
      if (item.originallink) base.originallink = item.originallink;
      if (item.pubDate) base.pubDate = item.pubDate;
      break;
    case 'blog':
      if (item.bloggername) base.bloggername = strip(item.bloggername);
      if (item.bloggerlink) base.bloggerlink = item.bloggerlink;
      if (item.postdate) base.postdate = item.postdate;
      break;
    case 'image':
      if (item.thumbnail) base.thumbnail = item.thumbnail;
      if (item.sizeheight) base.sizeheight = item.sizeheight;
      if (item.sizewidth) base.sizewidth = item.sizewidth;
      break;
    case 'shop':
      if (item.image) base.image = item.image;
      if (item.lprice) base.lprice = item.lprice;
      if (item.hprice) base.hprice = item.hprice;
      if (item.mallName) base.mallName = item.mallName;
      if (item.productId) base.productId = item.productId;
      if (item.productType) base.productType = item.productType;
      if (item.brand) base.brand = item.brand;
      if (item.maker) base.maker = item.maker;
      if (item.category1) base.category1 = item.category1;
      if (item.category2) base.category2 = item.category2;
      if (item.category3) base.category3 = item.category3;
      if (item.category4) base.category4 = item.category4;
      break;
    case 'cafearticle':
      if (item.cafename) base.cafename = strip(item.cafename);
      if (item.cafeurl) base.cafeurl = item.cafeurl;
      break;
    case 'encyc':
      if (item.thumbnail) base.thumbnail = item.thumbnail;
      break;
    case 'book':
    case 'book_adv':
      if (item.image) base.image = item.image;
      if (item.author) base.author = strip(item.author);
      if (item.discount) base.discount = item.discount;
      if (item.publisher) base.publisher = strip(item.publisher);
      if (item.pubdate) base.pubdate = item.pubdate;
      if (item.isbn) base.isbn = item.isbn;
      break;
    case 'local':
      if (item.category) base.category = item.category;
      if (item.telephone) base.telephone = item.telephone;
      if (item.address) base.address = item.address;
      if (item.roadAddress) base.roadAddress = item.roadAddress;
      if (item.mapx) base.mapx = item.mapx;
      if (item.mapy) base.mapy = item.mapy;
      break;
  }

  return base;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  유틸리티 API (adult, errata)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleUtility(ctx, type, query) {
  const params = new URLSearchParams({ query });
  const resp = await fetch(`${HUB_BASE}/search/v1/${type}?${params}`, {
    headers: hubHeaders(ctx),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return outErr('error.utility_api_status', { status: String(resp.status), body: t });
  }

  const json = await resp.json();

  if (type === 'adult') {
    out(true, { query, adult: json.adult === '1' || json.adult === 1, raw: json.adult });
  } else if (type === 'errata') {
    out(true, { query, errata: json.errata || '', corrected: !!json.errata });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 API — 공통
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function datalabApi(ctx, path, body) {
  const resp = await fetch(`${HUB_BASE}${path}`, {
    method: 'POST',
    headers: hubHeaders(ctx, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new I18nError('error.datalab_api_status', { status: String(resp.status), body: t });
  }

  return await resp.json();
}

/**
 * Age buckets, which are the same word with two different vocabularies:
 *   search trend    1..11  (1 = 0-12, 2 = 13-18, 3 = 19-24, ... 11 = 60+)
 *   shopping insight 10,20,30,40,50,60  (by decade)
 * "3" is a real value in both and means something different in each, so a caller carrying the
 * habit across gets a plausible wrong answer rather than an error. Rejecting by name is the only
 * way this surfaces.
 */
const AGES = {
  trend: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
  shopping: ['10', '20', '30', '40', '50', '60'],
};

function normalizeAges(ages, vocabulary) {
  if (!Array.isArray(ages) || ages.length === 0) return { ages: null, bad: [] };
  const allowed = AGES[vocabulary];
  const values = ages.map(String);
  const bad = values.filter(a => !allowed.includes(a));
  return { ages: values.filter(a => allowed.includes(a)), bad };
}

function agesNote(bad, vocabulary) {
  const allowed = AGES[vocabulary].join(' | ');
  const which = vocabulary === 'shopping'
    ? 'shopping insight counts by decade (10 = 10-19, 20 = 20-29, ... 60 = 60+)'
    : 'search trend uses band numbers (1 = 0-12, 2 = 13-18, 3 = 19-24, ... 11 = 60+)';
  return `ages ${bad.map(b => `"${b}"`).join(', ')} were dropped: ${which}, so the accepted values here are ${allowed}. The two APIs use the same field name with different vocabularies.`;
}

// 사용자 timezone 기준 (Firebat sandbox 가 FIREBAT_TZ env 주입). 미설정 시 UTC fallback.
// 데이터랩 API 의 startDate/endDate 가 KST 기준 일자라 toISOString (UTC) 사용 시 자정~09:00 KST 구간이 어제 날짜로 반환됩니다.
// The owner's calendar, from the shared shelf. This file had grown its own copy of the same idea
// (a local `_tz()` reading the same env), which is how four broker dialects each ended up with
// their own rate window. One clock, one place.
function today() { return todayYmd(); }
function threeMonthsAgo() { return addDaysYmd(-90); }

function formatDatalabResult(json) {
  return {
    startDate: json.startDate,
    endDate: json.endDate,
    timeUnit: json.timeUnit,
    results: (json.results || []).map(r => ({
      title: r.title,
      keywords: r.keywords,
      category: r.category,
      data: r.data || [],
    })),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 통합 검색어 트렌드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSearchTrend(ctx, data) {
  if (!data.keywordGroups || !Array.isArray(data.keywordGroups) || data.keywordGroups.length === 0) {
    return outErr('error.keyword_groups_required', {});
  }

  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    keywordGroups: data.keywordGroups.slice(0, 5).map(g => ({
      groupName: g.groupName || g.keywords?.[0] || 'group',
      keywords: (g.keywords || []).slice(0, 20),
    })),
  };

  if (data.device) body.device = data.device;
  if (data.gender) body.gender = data.gender;
  const { ages, bad } = normalizeAges(data.ages, 'trend');
  if (ages && ages.length > 0) body.ages = ages;

  const json = await datalabApi(ctx, '/search-trend/v1/search', body);
  const result = formatDatalabResult(json);
  const notes = [];
  if (bad.length > 0) notes.push(agesNote(bad, 'trend'));
  if (data.keywordGroups.length > 5) notes.push(`Only the first 5 of ${data.keywordGroups.length} keyword groups were sent — the API takes 5.`);
  notes.push('ratio is relative, not a count: the largest value in the window is 100 and everything else is scaled to it. Two separate calls are not comparable.');
  result._note = notes.join(' ');
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 쇼핑 분야별 트렌드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleShoppingCategories(ctx, data) {
  if (!data.category || !Array.isArray(data.category) || data.category.length === 0) {
    return outErr('error.category_required', {});
  }

  // Three category pairs, not five: this endpoint's cap is lower than the search trend one it
  // otherwise mirrors, and a fourth pair is a 400 rather than a truncation.
  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: data.category.slice(0, 3).map(c => ({
      name: c.name || '',
      param: Array.isArray(c.param) ? c.param.slice(0, 5) : [String(c.param)],
    })),
  };

  if (data.device) body.device = data.device;
  if (data.gender) body.gender = data.gender;
  const { ages, bad } = normalizeAges(data.ages, 'shopping');
  if (ages && ages.length > 0) body.ages = ages;

  const json = await datalabApi(ctx, '/shopping/v1/categories', body);
  const result = formatDatalabResult(json);
  const notes = [];
  if (bad.length > 0) notes.push(agesNote(bad, 'shopping'));
  if (data.category.length > 3) notes.push(`Only the first 3 of ${data.category.length} categories were sent — this endpoint takes 3, unlike search trend which takes 5.`);
  notes.push('ratio is relative to the largest value in this window, not a click count. Shopping insight data starts at 2017-08-01.');
  result._note = notes.join(' ');
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DataLab — shopping category split by device / gender / age
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/**
 * The whole category's click trend, split by one axis. Distinct from the keyword-level split
 * below: this one needs no keyword and answers "who buys in this category", where the other
 * answers "who searches this word inside this category".
 */
async function handleCategoryBreakdown(ctx, data, breakdownType) {
  const categoryCode = data.categoryCode ?? data.category;
  if (!categoryCode || Array.isArray(categoryCode)) {
    return outErr('error.category_code_required_breakdown', {});
  }

  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: String(categoryCode),
  };

  // The breakdown axis is what the response splits on, so passing a filter for that same axis
  // would collapse the split to a single group.
  if (data.device && breakdownType !== 'device') body.device = data.device;
  if (data.gender && breakdownType !== 'gender') body.gender = data.gender;
  const { ages, bad } = normalizeAges(data.ages, 'shopping');
  if (ages && ages.length > 0 && breakdownType !== 'age') body.ages = ages;

  const json = await datalabApi(ctx, `/shopping/v1/category/${breakdownType}`, body);
  const result = formatDatalabResult(json);
  const notes = [];
  if (bad.length > 0 && breakdownType !== 'age') notes.push(agesNote(bad, 'shopping'));
  notes.push(`Each data row carries a \`group\` naming the ${breakdownType} it belongs to, so rows repeat per period — one per group. ratio is relative to the largest value across the whole window.`);
  result._note = notes.join(' ');
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 쇼핑 분야 내 키워드 트렌드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleShoppingKeywords(ctx, data) {
  // 'category' 를 'categoryCode' 별칭으로 수용 (AI가 API 응답 필드명과 혼동하는 흔한 실수)
  const categoryCode = data.categoryCode ?? data.category;
  if (!categoryCode) return outErr('error.category_code_required', {});
  if (!data.keyword || !Array.isArray(data.keyword) || data.keyword.length === 0) {
    return outErr('error.keyword_array_required', {});
  }

  // `param` holds exactly one search term here — unlike search trend, where a group bundles up to
  // twenty. Sending a second one is a 400, so extras are dropped and reported.
  const extraTerms = data.keyword.filter(k => Array.isArray(k.param) && k.param.length > 1).length;
  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: String(categoryCode),
    keyword: data.keyword.slice(0, 5).map(k => ({
      name: k.name || k.param?.[0] || '',
      param: [String(Array.isArray(k.param) ? k.param[0] : k.param)],
    })),
  };

  if (data.device) body.device = data.device;
  if (data.gender) body.gender = data.gender;
  const { ages, bad } = normalizeAges(data.ages, 'shopping');
  if (ages && ages.length > 0) body.ages = ages;

  const json = await datalabApi(ctx, '/shopping/v1/category/keywords', body);
  const result = formatDatalabResult(json);
  const notes = [];
  if (bad.length > 0) notes.push(agesNote(bad, 'shopping'));
  if (extraTerms > 0) notes.push(`${extraTerms} keyword group(s) carried more than one term in \`param\`; only the first was sent. Shopping insight compares one term per group, unlike search trend which bundles up to 20.`);
  if (data.keyword.length > 5) notes.push(`Only the first 5 of ${data.keyword.length} keyword groups were sent.`);
  notes.push('ratio is relative to the largest value in this window — a keyword scoring 100 is the peak of its own series, not the most searched keyword.');
  result._note = notes.join(' ');
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 쇼핑 키워드 기기/성별/연령 분석
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleShoppingBreakdown(ctx, data, breakdownType) {
  const categoryCode = data.categoryCode ?? data.category;
  if (!categoryCode) return outErr('error.category_code_required_breakdown', {});
  if (!data.keywordText) return outErr('error.keyword_text_required', {});

  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: String(categoryCode),
    keyword: data.keywordText,
  };

  // Filtering on the same axis the response splits on would collapse the split to one group.
  if (data.device && breakdownType !== 'device') body.device = data.device;
  if (data.gender && breakdownType !== 'gender') body.gender = data.gender;
  const { ages, bad } = normalizeAges(data.ages, 'shopping');
  if (ages && ages.length > 0 && breakdownType !== 'age') body.ages = ages;

  const json = await datalabApi(ctx, `/shopping/v1/category/keyword/${breakdownType}`, body);
  const result = formatDatalabResult(json);
  const notes = [];
  if (bad.length > 0 && breakdownType !== 'age') notes.push(agesNote(bad, 'shopping'));
  notes.push(`Each data row carries a \`group\` naming the ${breakdownType} it belongs to, so rows repeat per period — one per group. ratio is relative to the largest value across the whole window.`);
  result._note = notes.join(' ');
  out(true, result);
}

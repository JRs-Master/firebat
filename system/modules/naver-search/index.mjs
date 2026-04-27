/**
 * Firebat System Module: naver-search (web-search)
 * 네이버 검색 API + 데이터랩 API
 *
 * 검색: webkr, blog, news, image, shop, cafearticle, kin, encyc, book, book_adv, doc, local
 * 유틸: adult(성인검색어 판별), errata(오타변환)
 * 데이터랩: search-trend(검색어 트렌드), shopping-categories(분야별 트렌드),
 *          shopping-keywords(키워드 트렌드), shopping-by-device/gender/age(클릭 분석)
 *
 * 공식 문서:
 *   검색: https://developers.naver.com/docs/serviceapi/search/
 *   데이터랩: https://developers.naver.com/docs/serviceapi/datalab/
 */

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);

    const clientId = process.env['NAVER_CLIENT_ID'];
    const clientSecret = process.env['NAVER_CLIENT_SECRET'];
    if (!clientId || !clientSecret) return out(false, 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET이 설정되지 않았습니다.');

    const ctx = { clientId, clientSecret };
    const action = data?.action || 'search';

    // 데이터랩 액션
    switch (action) {
      case 'search-trend': return await handleSearchTrend(ctx, data);
      case 'shopping-categories': return await handleShoppingCategories(ctx, data);
      case 'shopping-keywords': return await handleShoppingKeywords(ctx, data);
      case 'shopping-by-device': return await handleShoppingBreakdown(ctx, data, 'device');
      case 'shopping-by-gender': return await handleShoppingBreakdown(ctx, data, 'gender');
      case 'shopping-by-age': return await handleShoppingBreakdown(ctx, data, 'age');
    }

    // 검색 액션 (기존)
    const query = data?.query;
    if (!query) return out(false, 'data.query 필드가 필요합니다.');

    const type = data.type || 'webkr';

    // 유틸리티 API (adult, errata)
    if (type === 'adult' || type === 'errata') {
      return await handleUtility(ctx, type, query);
    }

    // 검색 API
    await handleSearch(ctx, type, query, data);
  } catch (e) { out(false, e.message); }
});

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

const strip = (s) => (s || '').replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// display/start 최대값 (유형별)
const LIMITS = {
  local: { displayMax: 5, startMax: 1 },
};
const DEFAULT_LIMITS = { displayMax: 100, startMax: 1000 };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  검색 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSearch(ctx, type, query, data) {
  const lim = LIMITS[type] || DEFAULT_LIMITS;
  const display = Math.min(Math.max(data.display || 10, 1), lim.displayMax);
  const start = Math.min(Math.max(data.start || 1, 1), lim.startMax);

  const endpoint = type === 'book_adv' ? 'book_adv' : type;
  const params = new URLSearchParams({ query, display: String(display), start: String(start) });

  if (data.sort) params.set('sort', data.sort);

  if (type === 'image' && data.filter) params.set('filter', data.filter);

  if (type === 'shop') {
    if (data.filter) params.set('filter', data.filter);
    if (data.exclude) params.set('exclude', data.exclude);
  }

  if (type === 'book_adv') {
    if (data.d_titl) params.set('d_titl', data.d_titl);
    if (data.d_auth) params.set('d_auth', data.d_auth);
    if (data.d_cont) params.set('d_cont', data.d_cont);
    if (data.d_isbn) params.set('d_isbn', data.d_isbn);
    if (data.d_publ) params.set('d_publ', data.d_publ);
    if (data.d_dafr) params.set('d_dafr', data.d_dafr);
    if (data.d_dato) params.set('d_dato', data.d_dato);
  }

  const resp = await fetch(`https://openapi.naver.com/v1/search/${endpoint}?${params}`, {
    headers: { 'X-Naver-Client-Id': ctx.clientId, 'X-Naver-Client-Secret': ctx.clientSecret },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return out(false, `네이버 검색 API ${resp.status}: ${t}`.trim());
  }

  const json = await resp.json();
  const items = (json.items || []).map(item => parseItem(type, item));

  out(true, {
    total: json.total || 0,
    start: json.start || start,
    display: json.display || items.length,
    items,
  });
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
  const resp = await fetch(`https://openapi.naver.com/v1/search/${type}?${params}`, {
    headers: { 'X-Naver-Client-Id': ctx.clientId, 'X-Naver-Client-Secret': ctx.clientSecret },
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return out(false, `네이버 API ${resp.status}: ${t}`.trim());
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
  const resp = await fetch(`https://openapi.naver.com/v1/datalab${path}`, {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': ctx.clientId,
      'X-Naver-Client-Secret': ctx.clientSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`네이버 데이터랩 API ${resp.status}: ${t}`.trim());
  }

  return await resp.json();
}

// 사용자 timezone 기준 (Firebat sandbox 가 FIREBAT_TZ env 주입). 미설정 시 UTC fallback.
// 데이터랩 API 의 startDate/endDate 가 KST 기준 일자라 toISOString (UTC) 사용 시 자정~09:00 KST 구간 어제 날짜 박힘.
function _tz() { return process.env.FIREBAT_TZ || process.env.TZ || 'UTC'; }
function _ymd(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: _tz(), year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d);
}
function today() { return _ymd(new Date()); }
function threeMonthsAgo() { const d = new Date(); d.setMonth(d.getMonth() - 3); return _ymd(d); }

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
    return out(false, 'keywordGroups 배열이 필요합니다. [{groupName, keywords}] 형식.');
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
  if (data.ages && Array.isArray(data.ages)) body.ages = data.ages.map(String);

  const json = await datalabApi(ctx, '/search', body);
  out(true, formatDatalabResult(json));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 쇼핑 분야별 트렌드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleShoppingCategories(ctx, data) {
  if (!data.category || !Array.isArray(data.category) || data.category.length === 0) {
    return out(false, 'category 배열이 필요합니다. [{name, param:["카테고리코드"]}] 형식.');
  }

  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: data.category.slice(0, 5).map(c => ({
      name: c.name || '',
      param: Array.isArray(c.param) ? c.param.slice(0, 5) : [String(c.param)],
    })),
  };

  if (data.device) body.device = data.device;
  if (data.gender) body.gender = data.gender;
  if (data.ages && Array.isArray(data.ages)) body.ages = data.ages.map(String);

  const json = await datalabApi(ctx, '/shopping/categories', body);
  out(true, formatDatalabResult(json));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 쇼핑 분야 내 키워드 트렌드
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleShoppingKeywords(ctx, data) {
  // 'category' 를 'categoryCode' 별칭으로 수용 (AI가 API 응답 필드명과 혼동하는 흔한 실수)
  const categoryCode = data.categoryCode ?? data.category;
  if (!categoryCode) return out(false, 'categoryCode 필드가 필요합니다 (필드명은 "categoryCode", 예: "50000000"). 주요 카테고리: 50000000=패션의류, 50000003=디지털가전, 50000006=식품.');
  if (!data.keyword || !Array.isArray(data.keyword) || data.keyword.length === 0) {
    return out(false, 'keyword 배열이 필요합니다. [{name, param:["키워드"]}] 형식.');
  }

  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: categoryCode,
    keyword: data.keyword.slice(0, 5).map(k => ({
      name: k.name || k.param?.[0] || '',
      param: Array.isArray(k.param) ? k.param.slice(0, 5) : [String(k.param)],
    })),
  };

  if (data.device) body.device = data.device;
  if (data.gender) body.gender = data.gender;
  if (data.ages && Array.isArray(data.ages)) body.ages = data.ages.map(String);

  const json = await datalabApi(ctx, '/shopping/category/keywords', body);
  out(true, formatDatalabResult(json));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  데이터랩 — 쇼핑 키워드 기기/성별/연령 분석
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleShoppingBreakdown(ctx, data, breakdownType) {
  const categoryCode = data.categoryCode ?? data.category;
  if (!categoryCode) return out(false, 'categoryCode 필드가 필요합니다 (필드명은 "categoryCode"). 주요 코드: 50000000=패션의류, 50000003=디지털가전, 50000006=식품.');
  if (!data.keywordText) return out(false, 'keywordText(문자열)가 필요합니다.');

  const body = {
    startDate: data.startDate || threeMonthsAgo(),
    endDate: data.endDate || today(),
    timeUnit: data.timeUnit || 'week',
    category: categoryCode,
    keyword: data.keywordText,
  };

  if (data.device && breakdownType !== 'device') body.device = data.device;
  if (data.gender && breakdownType !== 'gender') body.gender = data.gender;
  if (data.ages && breakdownType !== 'age') body.ages = data.ages.map(String);

  const json = await datalabApi(ctx, `/shopping/category/keyword/${breakdownType}`, body);
  out(true, formatDatalabResult(json));
}

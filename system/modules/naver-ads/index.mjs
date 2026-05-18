/**
 * Firebat System Module: naver-ads (keyword-analytics)
 * 네이버 검색광고 API — 키워드도구 + 통계 + 입찰 시뮬레이션 + 비즈머니 + 캠페인/광고그룹/키워드/소재 관리
 *
 * 공식 문서: https://naver.github.io/searchad-apidoc/
 * 인증: HMAC-SHA256 (X-API-KEY, X-Customer, X-Timestamp, X-Signature)
 */

import crypto from 'crypto';

const BASE = 'https://api.searchad.naver.com';
const TIMEOUT = 20000;

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

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.naver-ads.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action || 'keyword-tool';

    const accessLicense = process.env['NAVER_AD_ACCESS_LICENSE_KEY'];
    const secretKey = process.env['NAVER_AD_SECRET_KEY'];
    const customerId = process.env['NAVER_AD_CUSTOMER_ID'];
    if (!accessLicense || !secretKey || !customerId) {
      return outErr('error.api_key_missing', {});
    }

    // 네이버 검색광고 API 시그니처 명명 — `apiKey` 는 사실 `Access License`. 옛 이름 그대로
    // 사용 시 사용자 혼란 (네이버 콘솔 안 "Access License" 라벨 vs Firebat "API KEY" 불일치).
    const ctx = { apiKey: accessLicense, secretKey, customerId };

    switch (action) {
      case 'keyword-tool': return await handleKeywordTool(ctx, data);
      case 'stats': return await handleStats(ctx, data);
      case 'estimate': return await handleEstimate(ctx, data);
      case 'bizmoney': return await handleBizmoney(ctx, data);
      case 'managed-keywords': return await handleManagedKeywords(ctx, data);
      // 캠페인 관리
      case 'list-campaigns': return await handleList(ctx, '/api/ncc/campaigns', data);
      case 'get-campaign': return await handleGet(ctx, `/api/ncc/campaigns/${data.id}`, data);
      // 광고그룹 관리
      case 'list-adgroups': return await handleList(ctx, '/api/ncc/adgroups', data);
      case 'get-adgroup': return await handleGet(ctx, `/api/ncc/adgroups/${data.id}`, data);
      // 키워드 관리
      case 'list-keywords': return await handleList(ctx, '/api/ncc/keywords', data);
      case 'get-keyword': return await handleGet(ctx, `/api/ncc/keywords/${data.id}`, data);
      // 소재 관리
      case 'list-ads': return await handleList(ctx, '/api/ncc/ads', data);
      case 'get-ad': return await handleGet(ctx, `/api/ncc/ads/${data.id}`, data);
      // 비즈채널
      case 'list-channels': return await handleList(ctx, '/api/ncc/channels', data);
      // 확장소재
      case 'list-extensions': return await handleList(ctx, '/api/ncc/ad-extensions', data);
      // 라벨
      case 'list-labels': return await handleGet(ctx, '/api/ncc/labels', data);
      // 공유예산
      case 'list-shared-budgets': return await handleGet(ctx, '/api/ncc/shared-budgets', data);
      // 범용 API 직접 호출
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

async function api(ctx, method, uri, queryParams, body) {
  const timestamp = String(Date.now());
  const signature = sign(timestamp, method, uri, ctx.secretKey);
  const headers = {
    'X-API-KEY': ctx.apiKey,
    'X-Customer': ctx.customerId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };
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
    // 민감 정보 마스킹은 Rust AiManager 안 단일 게이트 (`core/src/utils/redactor.rs`) 가 처리.
    // sysmod 별 개별 sanitize 불필요 — 응답 본문 그대로 forward 후 사용자 노출 직전 통과.
    throw new I18nError('error.api_status', { status: String(resp.status), body: t });
  }

  const text = await resp.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── 키워드 도구 ──────────────────────────────────────────────────────────────
async function handleKeywordTool(ctx, data) {
  const keywords = data?.keywords;
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return outErr('error.keywords_required', {});
  }

  // 네이버 광고 API 제약: hintKeywords 각 키워드는 공백 불가, 최대 5개
  // AI가 "삼성전자 주가" 같이 공백 포함 키워드 전달 시 400 에러 → 공백 제거 후 전달
  const sanitized = keywords
    .map(k => String(k ?? '').replace(/\s+/g, ''))
    .filter(k => k.length > 0)
    .slice(0, 5);
  if (sanitized.length === 0) {
    return outErr('error.keywords_empty', {});
  }
  const params = { hintKeywords: sanitized.join(',') };
  if (data.showDetail !== false) params.showDetail = '1';
  if (data.siteId) params.siteId = data.siteId;
  if (data.biztpId) params.biztpId = data.biztpId;
  if (data.event) params.event = String(data.event);
  if (data.month) params.month = String(data.month);
  // includeHintKeywords — '1' 박으면 hintKeywords 자체 결과도 포함 (default 미포함).
  // AI 가 입력 키워드 자체의 검색량 / CTR 박는 영역 = 명시 '1' 박는 영역.
  if (data.includeHintKeywords !== undefined) {
    params.includeHintKeywords = data.includeHintKeywords ? '1' : '0';
  }

  const json = await api(ctx, 'GET', '/keywordstool', params);

  const toNum = (v) => (typeof v === 'string' ? (v.includes('<') ? 0 : Number(v)) : (v ?? 0));
  const allResults = (json.keywordList || []).map(item => {
    const entry = {
      keyword: item.relKeyword,
      monthlyPcQcCnt: toNum(item.monthlyPcQcCnt),
      monthlyMobileQcCnt: toNum(item.monthlyMobileQcCnt),
      monthlyAvePcClkCnt: item.monthlyAvePcClkCnt ?? 0,
      monthlyAveMobileClkCnt: item.monthlyAveMobileClkCnt ?? 0,
      monthlyAvePcCtr: item.monthlyAvePcCtr ?? 0,
      monthlyAveMobileCtr: item.monthlyAveMobileCtr ?? 0,
      plAvgDepth: item.plAvgDepth ?? 0,
      compIdx: item.compIdx || '',
      // 관련도 점수 — 입력 hintKeyword 와의 의미 유사도. AI 가 추천 정렬 / 필터 박을 때 활용.
      relatedPoint: item.related_point ?? null,
    };
    if (item.monthlyPcQcCntList) entry.monthlyPcQcCntList = item.monthlyPcQcCntList;
    if (item.monthlyMobileQcCntList) entry.monthlyMobileQcCntList = item.monthlyMobileQcCntList;
    return entry;
  });

  const lowerKws = keywords.map(k => k.toLowerCase());
  const exact = allResults.filter(r => lowerKws.includes(r.keyword?.toLowerCase()));
  const related = allResults.filter(r => !lowerKws.includes(r.keyword?.toLowerCase()));

  out(true, { keywords: exact, relatedKeywords: related.slice(0, 20) });
}

// ── 통계 조회 ────────────────────────────────────────────────────────────────
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

// ── 입찰 시뮬레이션 ──────────────────────────────────────────────────────────
async function handleEstimate(ctx, data) {
  const estimateType = data.estimateType || 'performance';
  const keyType = data.keyType || 'keyword'; // id 또는 keyword

  const PATHS = {
    'performance': `/estimate/performance/${keyType}`,
    'performance-bulk': '/estimate/performance-bulk',
    'average-position-bid': `/estimate/average-position-bid/${keyType}`,
    'median-bid': `/estimate/median-bid/${keyType}`,
    'exposure-minimum-bid': `/estimate/exposure-minimum-bid/${keyType}`,
  };

  const path = PATHS[estimateType];
  if (!path) return outErr('error.unknown_estimate_type', { estimateType: String(estimateType) });

  // 입력 검증 — 네이버 측 BadRequest 차단 + AI 한테 명시 안내. estimateType 별 필수 필드 다름:
  //   - performance-bulk: items 배열 (≥1) 필수
  //   - 그 외 (performance / average-position-bid / median-bid / exposure-minimum-bid): key 필수
  //   - performance: bid 추가 필수
  if (estimateType === 'performance-bulk') {
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return outErr('error.items_required', {});
    }
  } else {
    if (!data.key) {
      return outErr('error.key_required', { estimateType, keyType });
    }
    if (estimateType === 'performance' && (data.bid === undefined || data.bid === null)) {
      return outErr('error.bid_required', {});
    }
  }

  const body = {};
  if (data.device) body.device = data.device;
  if (data.keywordplus !== undefined) body.keywordplus = data.keywordplus;
  if (data.key) body.key = data.key;
  if (data.bid !== undefined && data.bid !== null) body.bid = data.bid;
  if (data.items) body.items = data.items;
  // period — performance-bulk 의 필수 field. AI 가 명시 안 박으면 default '30' (30일).
  // 네이버 API 가 'period is empty' 400 박는 영역 차단.
  if (estimateType === 'performance-bulk') {
    body.period = data.period ?? '30';
  } else if (data.period !== undefined) {
    body.period = data.period;
  }

  const json = await api(ctx, 'POST', path, null, body);
  out(true, json);
}

// ── 비즈머니 ─────────────────────────────────────────────────────────────────
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

// ── 관리 키워드 조회 ─────────────────────────────────────────────────────────
async function handleManagedKeywords(ctx, data) {
  const keywords = data?.keywords;
  if (!keywords) return outErr('error.keywords_required', {});
  const params = { keywords: Array.isArray(keywords) ? keywords.join(',') : keywords };
  const json = await api(ctx, 'GET', '/api/ncc/managedKeyword', params);
  out(true, json);
}

// ── 범용 목록 조회 ───────────────────────────────────────────────────────────
async function handleList(ctx, uri, data) {
  const params = {};
  // 공통 필터 파라미터
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

// ── 범용 단건 조회 ───────────────────────────────────────────────────────────
async function handleGet(ctx, uri, data) {
  const json = await api(ctx, 'GET', uri);
  out(true, json);
}

// ── 범용 Raw API 호출 ───────────────────────────────────────────────────────
async function handleRaw(ctx, data) {
  const method = (data.method || 'GET').toUpperCase();
  const uri = data.uri;
  if (!uri) return outErr('error.uri_required', {});

  // POST / PUT / PATCH 안 = body 필수 (네이버 측 `failed to parse body` 차단). GET / DELETE 안 = body 0 OK.
  const requiresBody = ['POST', 'PUT', 'PATCH'].includes(method);
  if (requiresBody && (!data.body || Object.keys(data.body).length === 0)) {
    return outErr('error.raw_body_required', { method });
  }

  const json = await api(ctx, method, uri, data.params || null, data.body || null);
  out(true, json);
}

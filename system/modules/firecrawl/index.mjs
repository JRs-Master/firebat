/**
 * Firebat System Module: firecrawl (web-scrape)
 * Firecrawl API v1 — scrape / crawl / map / extract
 *
 * 공식 문서: https://docs.firecrawl.dev
 */

const API = 'https://api.firecrawl.dev/v1';
const TIMEOUT = 60000;

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const apiKey = process.env['FIRECRAWL_API_KEY'];
    if (!apiKey) return out(false, 'FIRECRAWL_API_KEY가 설정되지 않았습니다.');

    const action = data?.action || 'scrape';

    if (action === 'scrape') await handleScrape(apiKey, data);
    else if (action === 'crawl') await handleCrawl(apiKey, data);
    else if (action === 'map') await handleMap(apiKey, data);
    else if (action === 'extract') await handleExtract(apiKey, data);
    else out(false, `알 수 없는 action: ${action}. scrape/crawl/map/extract 중 하나를 사용하세요.`);
  } catch (e) { out(false, e.message); }
});

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

function authHeaders(apiKey) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  1. scrape — 단일 URL 스크래핑
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleScrape(apiKey, data) {
  const url = data?.url;
  if (!url) return out(false, 'data.url 필드가 필요합니다.');

  const body = { url };

  // 포맷
  if (data.formats) body.formats = data.formats;
  else body.formats = ['markdown'];

  // 콘텐츠 옵션
  if (data.onlyMainContent !== undefined) body.onlyMainContent = data.onlyMainContent;
  if (data.includeTags) body.includeTags = data.includeTags;
  if (data.excludeTags) body.excludeTags = data.excludeTags;
  if (data.removeBase64Images !== undefined) body.removeBase64Images = data.removeBase64Images;

  // 요청 옵션
  if (data.headers) body.headers = data.headers;
  if (data.waitFor !== undefined) body.waitFor = data.waitFor;
  if (data.timeout !== undefined) body.timeout = data.timeout;
  if (data.mobile !== undefined) body.mobile = data.mobile;
  if (data.skipTlsVerification !== undefined) body.skipTlsVerification = data.skipTlsVerification;

  // 캐시
  if (data.maxAge !== undefined) body.maxAge = data.maxAge;

  // 위치/언어
  if (data.location) body.location = data.location;

  // 브라우저 액션
  if (data.actions) body.actions = data.actions;

  // LLM JSON 추출
  if (data.jsonOptions) body.jsonOptions = data.jsonOptions;

  const resp = await fetch(`${API}/scrape`, {
    method: 'POST', headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return out(false, `Firecrawl ${resp.status}: ${t}`.trim());
  }

  const json = await resp.json();
  if (!json.success) return out(false, json.error || '스크래핑 실패');

  const d = json.data || {};
  const maxLen = parseInt(process.env['MODULE_MAXTEXTLENGTH'] || '30000', 10);

  let text = d.markdown || '';
  // keyword 후처리
  if (data.keyword && text) {
    const idx = text.indexOf(data.keyword);
    if (idx !== -1) {
      const start = Math.max(0, idx - 500);
      const end = Math.min(text.length, idx + 3000);
      text = text.slice(start, end);
    }
  }

  const result = {
    url: d.metadata?.url || url,
    title: d.metadata?.title || '',
    text: text.slice(0, maxLen),
  };

  if (d.html) result.html = d.html.slice(0, maxLen);
  if (d.rawHtml) result.rawHtml = d.rawHtml.slice(0, maxLen);
  if (d.links) result.links = d.links;
  if (d.screenshot) result.screenshot = d.screenshot;
  if (d.json) result.json = d.json;
  if (d.metadata?.description) result.description = d.metadata.description;

  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  2. crawl — 사이트 전체 크롤링
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleCrawl(apiKey, data) {
  const url = data?.url;
  if (!url) return out(false, 'data.url 필드가 필요합니다.');

  const body = { url };
  if (data.limit !== undefined) body.limit = data.limit;
  if (data.maxDiscoveryDepth !== undefined) body.maxDiscoveryDepth = data.maxDiscoveryDepth;
  if (data.includePaths) body.includePaths = data.includePaths;
  if (data.excludePaths) body.excludePaths = data.excludePaths;
  if (data.crawlEntireDomain !== undefined) body.crawlEntireDomain = data.crawlEntireDomain;
  if (data.allowSubdomains !== undefined) body.allowSubdomains = data.allowSubdomains;
  if (data.allowExternalLinks !== undefined) body.allowExternalLinks = data.allowExternalLinks;
  if (data.sitemap) body.sitemap = data.sitemap;
  if (data.ignoreQueryParameters !== undefined) body.ignoreQueryParameters = data.ignoreQueryParameters;
  if (data.delay !== undefined) body.delay = data.delay;
  if (data.maxConcurrency !== undefined) body.maxConcurrency = data.maxConcurrency;
  if (data.scrapeOptions) body.scrapeOptions = data.scrapeOptions;

  // 크롤 시작
  const startResp = await fetch(`${API}/crawl`, {
    method: 'POST', headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!startResp.ok) {
    const t = await startResp.text().catch(() => '');
    return out(false, `Firecrawl crawl start ${startResp.status}: ${t}`.trim());
  }

  const startJson = await startResp.json();
  if (!startJson.success && !startJson.id) return out(false, startJson.error || '크롤 시작 실패');
  const crawlId = startJson.id;

  // 폴링 (최대 5분)
  const maxWait = data.maxWaitMs || 300000;
  const pollInterval = data.pollInterval || 5000;
  const deadline = Date.now() + maxWait;
  let result = null;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    const statusResp = await fetch(`${API}/crawl/${crawlId}`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (!statusResp.ok) continue;
    const statusJson = await statusResp.json();

    if (statusJson.status === 'completed') {
      result = statusJson;
      break;
    } else if (statusJson.status === 'failed' || statusJson.status === 'cancelled') {
      return out(false, `크롤 ${statusJson.status}: ${statusJson.error || ''}`);
    }
  }

  if (!result) return out(false, `크롤 시간 초과 (${maxWait / 1000}초). crawlId: ${crawlId}`);

  const maxLen = parseInt(process.env['MODULE_MAXTEXTLENGTH'] || '30000', 10);
  const pages = (result.data || []).map(p => ({
    url: p.metadata?.url || '',
    title: p.metadata?.title || '',
    text: (p.markdown || '').slice(0, maxLen),
  }));

  out(true, { crawlId, total: result.total || pages.length, pages });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  3. map — URL 맵 (스크래핑 없이 URL 목록만 수집)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMap(apiKey, data) {
  const url = data?.url;
  if (!url) return out(false, 'data.url 필드가 필요합니다.');

  const body = { url };
  if (data.limit !== undefined) body.limit = data.limit;
  if (data.search) body.search = data.search;
  if (data.sitemap) body.sitemap = data.sitemap;
  if (data.location) body.location = data.location;

  const resp = await fetch(`${API}/map`, {
    method: 'POST', headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return out(false, `Firecrawl map ${resp.status}: ${t}`.trim());
  }

  const json = await resp.json();
  if (!json.success) return out(false, json.error || 'URL 맵 조회 실패');

  out(true, { links: json.links || [] });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  4. extract — LLM 기반 구조화 데이터 추출
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleExtract(apiKey, data) {
  const urls = data?.urls;
  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return out(false, 'data.urls 배열이 필요합니다. (와일드카드 지원: "example.com/*")');
  }

  const body = { urls };
  if (data.prompt) body.prompt = data.prompt;
  if (data.schema) body.schema = data.schema;
  if (data.systemPrompt) body.systemPrompt = data.systemPrompt;
  if (data.allowExternalLinks !== undefined) body.allowExternalLinks = data.allowExternalLinks;
  if (data.enableWebSearch !== undefined) body.enableWebSearch = data.enableWebSearch;
  if (data.showSources !== undefined) body.showSources = data.showSources;

  // 추출 시작
  const startResp = await fetch(`${API}/extract`, {
    method: 'POST', headers: authHeaders(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!startResp.ok) {
    const t = await startResp.text().catch(() => '');
    return out(false, `Firecrawl extract ${startResp.status}: ${t}`.trim());
  }

  const startJson = await startResp.json();
  if (!startJson.success && !startJson.id) return out(false, startJson.error || '추출 시작 실패');

  // 동기 응답 (즉시 완료된 경우)
  if (startJson.status === 'completed' && startJson.data) {
    return out(true, startJson.data);
  }

  const extractId = startJson.id;
  if (!extractId) return out(true, startJson.data || startJson);

  // 비동기 폴링
  const maxWait = data.maxWaitMs || 120000;
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const statusResp = await fetch(`${API}/extract/${extractId}`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (!statusResp.ok) continue;
    const statusJson = await statusResp.json();

    if (statusJson.status === 'completed') {
      return out(true, statusJson.data || statusJson);
    } else if (statusJson.status === 'failed') {
      return out(false, `추출 실패: ${statusJson.error || ''}`);
    }
  }

  out(false, `추출 시간 초과. extractId: ${extractId}`);
}

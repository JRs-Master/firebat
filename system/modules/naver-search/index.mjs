/**
 * Firebat System Module: naver-search (web-search)
 * 네이버 검색 API — 웹문서/뉴스/블로그/이미지/쇼핑/카페/지식iN
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": { "query": "string", "type?": "webkr", "display?": 10, "start?": 1, "sort?": "sim" }
 *         }
 * [OUTPUT] stdout JSON: {
 *           "success": true,
 *           "data": { "total": N, "start": N, "display": N, "items": [...] }
 *         }
 *         또는 { "success": false, "error": "..." }
 */

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const query = data?.query;
    if (!query) {
      console.log(JSON.stringify({ success: false, error: 'data.query 필드가 필요합니다.' }));
      return;
    }

    const clientId = process.env['NAVER_CLIENT_ID'];
    const clientSecret = process.env['NAVER_CLIENT_SECRET'];
    if (!clientId || !clientSecret) {
      console.log(JSON.stringify({ success: false, error: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET이 설정되지 않았습니다. 설정 > 시스템 모듈 > naver-search에서 API 키를 등록해주세요.' }));
      return;
    }

    const type = data.type || 'webkr';
    const display = Math.min(Math.max(data.display || 10, 1), 100);
    const start = Math.min(Math.max(data.start || 1, 1), 1000);
    const sort = data.sort || 'sim';

    const params = new URLSearchParams({
      query,
      display: String(display),
      start: String(start),
      sort,
    });

    const resp = await fetch(`https://openapi.naver.com/v1/search/${type}?${params}`, {
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log(JSON.stringify({ success: false, error: `네이버 검색 API ${resp.status}: ${resp.statusText} ${errText}`.trim() }));
      return;
    }

    const json = await resp.json();

    // HTML 태그 제거 헬퍼
    const strip = (s) => (s || '').replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

    const items = (json.items || []).map(item => ({
      title: strip(item.title),
      link: item.link || item.originallink || '',
      description: strip(item.description),
    }));

    console.log(JSON.stringify({
      success: true,
      data: {
        total: json.total || 0,
        start: json.start || start,
        display: json.display || items.length,
        items,
      },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

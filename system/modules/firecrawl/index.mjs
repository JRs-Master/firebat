/**
 * Firebat System Module: firecrawl (web-scrape)
 * Firecrawl API 기반 웹 스크래퍼
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": { "url": "string", "keyword?": "string" }
 *         }
 * [OUTPUT] stdout JSON: {
 *           "success": true,
 *           "data": { "url": "...", "title": "...", "text": "..." }
 *         }
 *         또는 { "success": false, "error": "..." }
 */

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const url = data?.url;
    const keyword = data?.keyword;
    if (!url) {
      console.log(JSON.stringify({ success: false, error: 'data.url 필드가 필요합니다.' }));
      return;
    }

    const apiKey = process.env['FIRECRAWL_API_KEY'];
    if (!apiKey) {
      console.log(JSON.stringify({ success: false, error: 'FIRECRAWL_API_KEY가 설정되지 않았습니다. 설정 > 시스템 모듈 > firecrawl에서 API 키를 등록해주세요.' }));
      return;
    }

    const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        waitFor: 3000,
        timeout: 30000,
      }),
      signal: AbortSignal.timeout(35000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log(JSON.stringify({ success: false, error: `Firecrawl API ${resp.status}: ${resp.statusText} ${errText}`.trim() }));
      return;
    }

    const json = await resp.json();
    if (!json.success) {
      console.log(JSON.stringify({ success: false, error: json.error || 'Firecrawl 스크래핑 실패' }));
      return;
    }

    const md = json.data?.markdown || '';
    const title = json.data?.metadata?.title || '';
    const maxLen = parseInt(process.env['MODULE_MAXTEXTLENGTH'] || '30000', 10);

    let result = md;
    if (keyword) {
      const idx = md.indexOf(keyword);
      if (idx !== -1) {
        const start = Math.max(0, idx - 500);
        const end = Math.min(md.length, idx + 3000);
        result = md.slice(start, end);
      }
    }

    console.log(JSON.stringify({
      success: true,
      data: { url, title, text: result.slice(0, maxLen) },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

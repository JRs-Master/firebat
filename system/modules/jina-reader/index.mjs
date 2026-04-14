/**
 * Firebat System Module: jina-reader (web-scrape)
 * Jina Reader API 기반 웹 스크래퍼
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
    const keyword = data?.keyword; // 키워드 주변 텍스트만 추출
    if (!url) {
      console.log(JSON.stringify({ success: false, error: 'data.url 필드가 필요합니다.' }));
      return;
    }

    const headers = {
      'Accept': 'text/markdown',
      'X-Wait-For-Selector': 'body',
      'X-Timeout': '30',
      'X-No-Cache': 'true',
    };
    const apiKey = process.env['JINA_API_KEY'];
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(25000) });

    if (!resp.ok) {
      console.log(JSON.stringify({ success: false, error: `Jina API ${resp.status}: ${resp.statusText}` }));
      return;
    }

    const text = await resp.text();

    // 제목 추출: Jina 마크다운 첫 줄이 "Title: ..." 또는 "# ..." 형태
    let title = '';
    const lines = text.split('\n');
    if (lines[0]?.startsWith('Title:')) title = lines[0].slice(6).trim();
    else if (lines[0]?.startsWith('# ')) title = lines[0].slice(2).trim();

    const maxLen = parseInt(process.env['MODULE_MAXTEXTLENGTH'] || '30000', 10);

    let result = text;
    // keyword가 있으면 해당 키워드 주변 텍스트만 추출 (앞뒤 3000자)
    if (keyword) {
      const idx = text.indexOf(keyword);
      if (idx !== -1) {
        const start = Math.max(0, idx - 500);
        const end = Math.min(text.length, idx + 3000);
        result = text.slice(start, end);
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

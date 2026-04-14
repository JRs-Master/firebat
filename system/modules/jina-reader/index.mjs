/**
 * Firebat System Module: jina-reader
 * Jina Reader API 기반 웹 스크래퍼
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": { "url": "string" }
 *         }
 * [OUTPUT] stdout JSON: {
 *           "success": true,
 *           "data": { "url": "...", "title": "...", "text": "..." }
 *         }
 *         또는 { "success": false, "error": "..." }
 *
 * Jina Reader 무료 티어: API 키 없이 사용 가능 (rate limit 있음).
 * API 키가 있으면 rate limit 완화.
 */

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const url = data?.url;
    if (!url) {
      console.log(JSON.stringify({ success: false, error: 'data.url 필드가 필요합니다.' }));
      return;
    }

    const headers = {
      'Accept': 'text/html',
      'X-Return-Format': 'html',
      'X-Wait-For-Selector': 'body',
      'X-Timeout': '30',
    };
    const apiKey = process.env['JINA_API_KEY'];
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(25000) });

    if (!resp.ok) {
      console.log(JSON.stringify({ success: false, error: `Jina API ${resp.status}: ${resp.statusText}` }));
      return;
    }

    const text = await resp.text();

    // HTML에서 <title> 추출
    let title = '';
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();

    console.log(JSON.stringify({
      success: true,
      data: { url, title, text: text.slice(0, 15000) },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

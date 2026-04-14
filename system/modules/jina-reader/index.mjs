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

    // HTML이 너무 길면 <body> 내용만 추출 + 스크립트/스타일 제거
    let body = text;
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) body = bodyMatch[1];
    // script, style, noscript 태그 제거
    body = body.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
    // 연속 공백/줄바꿈 정리
    body = body.replace(/\s{2,}/g, ' ').trim();

    console.log(JSON.stringify({
      success: true,
      data: { url, title, text: body.slice(0, 80000) },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

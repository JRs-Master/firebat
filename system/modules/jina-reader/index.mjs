/**
 * Firebat System Module: jina-reader (web-scrape)
 * Jina Reader API 기반 웹 스크래퍼
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": { "url": "string", "selector?": "string" }
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
    const selector = data?.selector; // class명, id, 태그 등으로 HTML 부분 추출
    if (!url) {
      console.log(JSON.stringify({ success: false, error: 'data.url 필드가 필요합니다.' }));
      return;
    }

    const headers = {
      'Accept': 'text/html',
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
    body = body.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');

    // selector가 있으면 해당 부분만 추출 (class, id, 태그명 매칭)
    if (selector) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // class="selector" 또는 id="selector" 또는 <selector 매칭
      const patterns = [
        new RegExp(`<[^>]*(?:class|id)="[^"]*${escaped}[^"]*"[^>]*>[\\s\\S]*?(?=<\\/[^>]+>\\s*<[^>]*(?:class|id)="|$)`, 'gi'),
        new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi'),
      ];
      let found = '';
      for (const pat of patterns) {
        const matches = body.match(pat);
        if (matches) { found = matches.join('\n'); break; }
      }
      if (found) body = found;
    }

    // selector가 없으면 HTML 태그 제거 → 순수 텍스트 (용량 대폭 감소)
    if (!selector) {
      body = body.replace(/<[^>]+>/g, ' ');
    }

    body = body.replace(/\s{2,}/g, ' ').trim();

    console.log(JSON.stringify({
      success: true,
      data: { url, title, text: body.slice(0, 50000) },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

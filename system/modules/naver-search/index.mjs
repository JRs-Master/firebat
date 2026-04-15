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
    // 이미지 검색 필터 (all/large/medium/small)
    if (type === 'image' && data.filter) params.set('filter', data.filter);

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

    const items = (json.items || []).map(item => {
      const base = {
        title: strip(item.title),
        link: item.link || '',
        description: strip(item.description || ''),
      };
      // 유형별 추가 필드
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
      }
      return base;
    });

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

import { getCore } from '../../lib/singleton';
import { getBaseUrl } from '../../lib/base-url';
import { specBodyToHtml, wrapCdata } from '../../lib/spec-to-rss-html';

/** GET /feed.xml — RSS 2.0 피드.
 *
 *  포함:
 *  - 각 글의 description (head.description) 과 category (head.keywords)
 *  - content:encoded namespace (full HTML 본문 — 추후 확장 여지)
 *  - channel image (사이트 로고 또는 favicon)
 *  - 최신 순 정렬 (updatedAt desc)
 *  - public + published 만 (visibility 필터)
 *
 *  N+1: 각 페이지 getPage 로 head.description / keywords 받음. 페이지 ~100 미만 가정.
 *  RSS reader 가 시간당 1 회 정도 fetch 라 부담 없음. */
export async function GET(req: Request) {
  const core = getCore();
  const seo = core.getCmsSettings();

  if (!seo.rssEnabled) {
    return new Response('RSS feed is disabled', { status: 404 });
  }

  const baseUrl = seo.siteUrl || getBaseUrl(req);

  const result = await core.listPages();
  const allPages = result.success && result.data ? result.data : [];
  // 공개 + 발행 페이지만 + 최신 순
  const visiblePages = allPages
    .filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  const escXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 각 페이지 spec 받아 description + keywords 추출
  const itemsXml: string[] = [];
  for (const page of visiblePages) {
    const url = `${baseUrl}/${page.slug.split('/').map(encodeURIComponent).join('/')}`;
    const pubDate = page.updatedAt ? new Date(page.updatedAt.includes('T') ? page.updatedAt : page.updatedAt.replace(' ', 'T') + 'Z').toUTCString() : new Date().toUTCString();
    const pageRes = await core.getPage(page.slug);
    const spec = (pageRes.success && pageRes.data) || ({} as any);
    const head = (spec.head || {}) as Record<string, any>;
    const description: string = head.description || '';
    const keywords: string[] = Array.isArray(head.keywords) ? head.keywords : [];
    const bodyHtml = specBodyToHtml(spec.body);
    const categoriesXml = keywords
      .filter((k) => typeof k === 'string' && k.trim())
      .map((k) => `      <category>${escXml(k)}</category>`)
      .join('\n');
    itemsXml.push(`    <item>
      <title>${escXml(page.title || page.slug)}</title>
      <link>${escXml(url)}</link>
      <guid isPermaLink="true">${escXml(url)}</guid>
      <pubDate>${pubDate}</pubDate>
${description ? `      <description>${escXml(description)}</description>\n` : ''}${categoriesXml ? `${categoriesXml}\n` : ''}${bodyHtml ? `      <content:encoded>${wrapCdata(bodyHtml)}</content:encoded>\n` : ''}    </item>`);
  }

  // channel image (로고 또는 favicon)
  const logoUrl = seo.jsonLdLogoUrl || seo.faviconUrl || '';
  const imageXml = logoUrl
    ? `    <image>
      <url>${escXml(logoUrl.startsWith('http') ? logoUrl : `${baseUrl}${logoUrl.startsWith('/') ? '' : '/'}${logoUrl}`)}</url>
      <title>${escXml(seo.siteTitle)}</title>
      <link>${escXml(baseUrl)}</link>
    </image>\n`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:atom="http://www.w3.org/2005/Atom"
     xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escXml(seo.siteTitle)}</title>
    <link>${escXml(baseUrl)}</link>
    <description>${escXml(seo.siteDescription)}</description>
    <language>${escXml(seo.siteLang || 'ko')}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>Firebat CMS</generator>
    <atom:link href="${escXml(baseUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
${imageXml}${itemsXml.join('\n')}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

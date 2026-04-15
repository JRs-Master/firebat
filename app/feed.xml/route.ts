import { getCore } from '../../lib/singleton';
import { BASE_URL } from '../../infra/config';

/** GET /feed.xml — RSS 2.0 피드 (SEO 모듈 설정 기반) */
export async function GET() {
  const core = getCore();
  const seo = core.getSeoSettings();

  if (!seo.rssEnabled) {
    return new Response('RSS feed is disabled', { status: 404 });
  }

  const result = await core.listPages();
  const allPages = result.success && result.data ? result.data : [];
  // 공개 페이지만 포함 (password, private 제외)
  const pages = allPages.filter(p => (p.visibility ?? 'public') === 'public');
  const staticPages = await core.listStaticPages();

  const escXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // DB 동적 페이지
  const items: string[] = pages.map(page => {
    const url = `${BASE_URL}/${encodeURIComponent(page.slug)}`;
    const pubDate = page.updatedAt ? new Date(page.updatedAt).toUTCString() : new Date().toUTCString();
    return `    <item>
      <title>${escXml(page.title || page.slug)}</title>
      <link>${escXml(url)}</link>
      <guid>${escXml(url)}</guid>
      <pubDate>${pubDate}</pubDate>
    </item>`;
  });

  // 정적 페이지 (DB 중복 제외)
  for (const slug of staticPages) {
    if (pages.some(p => p.slug === slug)) continue;
    const url = `${BASE_URL}/${encodeURIComponent(slug)}`;
    items.push(`    <item>
      <title>${escXml(slug)}</title>
      <link>${escXml(url)}</link>
      <guid>${escXml(url)}</guid>
      <pubDate>${new Date().toUTCString()}</pubDate>
    </item>`);
  }

  const itemsXml = items.join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escXml(seo.siteTitle)}</title>
    <link>${escXml(BASE_URL)}</link>
    <description>${escXml(seo.siteDescription)}</description>
    <language>ko</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escXml(BASE_URL)}/feed.xml" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

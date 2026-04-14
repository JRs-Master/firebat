import { getCore } from '../../lib/singleton';
import { BASE_URL } from '../../infra/config';

export const dynamic = 'force-dynamic';

/** GET /sitemap.xml — Sitemap Index */
export async function GET() {
  const core = getCore();
  const seo = core.getSeoSettings();

  if (!seo.sitemapEnabled) {
    return new Response('Sitemap is disabled', { status: 404 });
  }

  const sitemaps = [
    `${BASE_URL}/sitemap-posts.xml`,
  ];

  // 정적 페이지가 있을 때만 포함
  const staticPages = await core.listStaticPages();
  if (staticPages.length > 0) {
    sitemaps.push(`${BASE_URL}/sitemap-pages.xml`);
  }

  const entries = sitemaps.map(url =>
    `  <sitemap>\n    <loc>${url}</loc>\n    <lastmod>${new Date().toISOString()}</lastmod>\n  </sitemap>`
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</sitemapindex>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

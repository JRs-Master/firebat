import { getCore } from '../../lib/singleton';
import { getBaseUrl } from '../../lib/base-url';

export const dynamic = 'force-dynamic';

/** GET /sitemap-pages.xml — 정적 페이지 사이트맵 */
export async function GET(req: Request) {
  const core = getCore();
  const seo = core.getCmsSettings();

  if (!seo.sitemapEnabled) {
    return new Response('Sitemap is disabled', { status: 404 });
  }

  const baseUrl = seo.siteUrl || getBaseUrl(req);
  const result = await core.listPages();
  const dbPages = result.success && result.data ? result.data : [];
  const staticPages = await core.listStaticPages();

  const entries = staticPages
    .filter(slug => !dbPages.some(p => p.slug === slug))
    .map(slug => {
      const loc = `${baseUrl}/${encodeURIComponent(slug)}`;
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${new Date().toISOString()}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

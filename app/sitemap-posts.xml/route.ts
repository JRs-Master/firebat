import { getCore } from '../../lib/singleton';
import { BASE_URL } from '../../infra/config';

export const dynamic = 'force-dynamic';

/** GET /sitemap-posts.xml — DB 동적 포스트 사이트맵 */
export async function GET() {
  const core = getCore();
  const seo = core.getSeoSettings();

  if (!seo.sitemapEnabled) {
    return new Response('Sitemap is disabled', { status: 404 });
  }

  const result = await core.listPages();
  const pages = result.success && result.data ? result.data : [];

  const entries = [
    // 홈페이지
    `  <url>\n    <loc>${BASE_URL}</loc>\n    <lastmod>${new Date().toISOString()}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    // DB 페이지
    ...pages.map(page => {
      const loc = `${BASE_URL}/${encodeURIComponent(page.slug)}`;
      const lastmod = page.updatedAt ? new Date(page.updatedAt).toISOString() : new Date().toISOString();
      return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
    }),
  ].join('\n');

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

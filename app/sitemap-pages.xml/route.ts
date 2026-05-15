import { getCmsSettings } from '../../lib/api-gen/module';
import { listPages, listStatic } from '../../lib/api-gen/page';
import { getBaseUrl } from '../../lib/base-url';

export const dynamic = 'force-dynamic';

/** GET /sitemap-pages.xml — 정적 페이지 사이트맵 */
export async function GET(req: Request) {
  const seoRes = await getCmsSettings();
  if (!seoRes.ok) {
    return new Response('Sitemap is disabled', { status: 404 });
  }
  const seo = seoRes.data as { sitemapEnabled?: boolean; siteUrl?: string };

  if (!seo.sitemapEnabled) {
    return new Response('Sitemap is disabled', { status: 404 });
  }

  const baseUrl = seo.siteUrl || getBaseUrl(req);
  const result = await listPages();
  const dbPages = result.ok ? (result.data.items ?? []) : [];
  const staticRes = await listStatic();
  const staticPages = staticRes.ok ? staticRes.data : [];

  const entries = staticPages
    .filter(slug => !dbPages.some(p => p.slug === slug))
    .map(slug => {
      // slug 가 'stock-blog/2026-04-28-close' 식 슬래시 포함 — 각 segment 만 encode 하고 슬래시는 보존.
      const loc = `${baseUrl}/${slug.split('/').map(encodeURIComponent).join('/')}`;
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

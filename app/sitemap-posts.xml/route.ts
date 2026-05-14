import { getCmsSettings } from '../../lib/api-gen/module';
import { listPages } from '../../lib/api-gen/page';
import { getBaseUrl } from '../../lib/base-url';

export const dynamic = 'force-dynamic';

/** GET /sitemap-posts.xml — DB 동적 포스트 사이트맵 */
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
  const allPages = result.ok ? (result.data.items ?? []) : [];
  // 공개 페이지만 포함 (password, private 제외)
  const pages = allPages.filter(p => (p.visibility ?? 'public') === 'public');

  const entries = [
    // 홈페이지
    `  <url>\n    <loc>${baseUrl}</loc>\n    <lastmod>${new Date().toISOString()}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    // DB 페이지
    ...pages.map(page => {
      // 각 segment 만 encode + 슬래시 보존 (stock-blog/2026-04-28-close 등 정상 표시)
      const loc = `${baseUrl}/${page.slug.split('/').map(encodeURIComponent).join('/')}`;
      const updatedMs = typeof page.updatedAt === 'bigint' ? Number(page.updatedAt) : Number(page.updatedAt ?? 0);
      const lastmod = updatedMs ? new Date(updatedMs).toISOString() : new Date().toISOString();
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

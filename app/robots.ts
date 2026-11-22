import type { MetadataRoute } from 'next';
import { getCmsSettings } from '../lib/api-gen/module';
import { resolveSiteUrl } from '../lib/site-url';

// Rust Core gRPC 호출하므로 prerender 우회 — sitemap/feed 와 같은 패턴.
export const dynamic = 'force-dynamic';

/** 동적 robots.txt — SEO 모듈 설정에서 내용 로드.
 *  Next.js metadata route 는 req 객체 없지만 headers() API 로 요청 host 접근 가능. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const seoRes = await getCmsSettings();
  const seo = (seoRes.ok ? seoRes.data : {}) as {
    robotsTxt?: string; siteUrl?: string; sitemapEnabled?: boolean;
  };
  const raw = (seo.robotsTxt ?? '').trim();

  // 설정된 robots.txt를 파싱하여 Metadata API 형식으로 변환
  const rules: MetadataRoute.Robots['rules'] = [];
  let currentAgent = '*';
  const allow: string[] = [];
  const disallow: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...rest] = trimmed.split(':');
    const value = rest.join(':').trim();

    if (key.toLowerCase() === 'user-agent') {
      // 이전 에이전트 규칙 저장
      if (allow.length > 0 || disallow.length > 0) {
        rules.push({
          userAgent: currentAgent,
          ...(allow.length > 0 ? { allow: allow.slice() } : {}),
          ...(disallow.length > 0 ? { disallow: disallow.slice() } : {}),
        });
        allow.length = 0;
        disallow.length = 0;
      }
      currentAgent = value || '*';
    } else if (key.toLowerCase() === 'allow') {
      allow.push(value);
    } else if (key.toLowerCase() === 'disallow') {
      disallow.push(value);
    }
  }

  // 마지막 에이전트 규칙 저장
  if (allow.length > 0 || disallow.length > 0 || rules.length === 0) {
    rules.push({
      userAgent: currentAgent,
      ...(allow.length > 0 ? { allow } : {}),
      ...(disallow.length > 0 ? { disallow } : {}),
    });
  }

  const baseUrl = await resolveSiteUrl(seo.siteUrl);

  return {
    rules,
    ...(seo.sitemapEnabled ? { sitemap: `${baseUrl}/sitemap.xml` } : {}),
  };
}

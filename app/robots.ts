import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { getCore } from '../lib/singleton';
import { BASE_URL } from '../lib/base-url';

/** 동적 robots.txt — SEO 모듈 설정에서 내용 로드.
 *  Next.js metadata route 는 req 객체 없지만 headers() API 로 요청 host 접근 가능. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const core = getCore();
  const seo = core.getCmsSettings();
  const raw = seo.robotsTxt.trim();

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

  // baseUrl 우선순위:
  //  1. SEO 설정 siteUrl (관리자 입력)
  //  2. NEXT_PUBLIC_BASE_URL env
  //  3. 요청 host (nginx Host / X-Forwarded-Host 자동 전달)
  //  4. BASE_URL (env 폴백, 최종적으로 localhost)
  let baseUrl = seo.siteUrl || process.env.NEXT_PUBLIC_BASE_URL || '';
  if (!baseUrl) {
    try {
      const h = await headers();
      const host = h.get('x-forwarded-host') || h.get('host');
      if (host) {
        const proto = h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
        baseUrl = `${proto}://${host}`;
      }
    } catch { /* headers 접근 실패 */ }
  }
  if (!baseUrl) baseUrl = BASE_URL;
  baseUrl = baseUrl.replace(/\/$/, '');

  return {
    rules,
    ...(seo.sitemapEnabled ? { sitemap: `${baseUrl}/sitemap.xml` } : {}),
  };
}

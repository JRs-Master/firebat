import type { MetadataRoute } from 'next';
import { getCore } from '../lib/singleton';
import { BASE_URL } from '../infra/config';

/** 동적 robots.txt — SEO 모듈 설정에서 내용 로드 */
export default function robots(): MetadataRoute.Robots {
  const core = getCore();
  const seo = core.getSeoSettings();
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

  return {
    rules,
    ...(seo.sitemapEnabled ? { sitemap: `${BASE_URL}/sitemap.xml` } : {}),
  };
}

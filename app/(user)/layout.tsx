import { getCore } from '../../lib/singleton';
import { SeoScripts } from './seo-scripts';
import { BASE_URL } from '../../infra/config';

/** User 페이지 레이아웃 — SEO head/body 스크립트 + JSON-LD 주입 */
export default function UserLayout({ children }: { children: React.ReactNode }) {
  const seo = getCore().getCmsSettings();
  const siteUrl = seo.siteUrl || BASE_URL;

  // JSON-LD 구조화 데이터 (WebSite + Organization)
  const jsonLd = seo.jsonLdEnabled ? {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${siteUrl}/#website`,
        url: siteUrl,
        name: seo.siteTitle,
        description: seo.siteDescription,
        publisher: { '@id': `${siteUrl}/#organization` },
      },
      {
        '@type': 'Organization',
        '@id': `${siteUrl}/#organization`,
        name: seo.jsonLdOrganization || seo.siteTitle,
        url: siteUrl,
        ...(seo.jsonLdLogoUrl ? {
          logo: {
            '@type': 'ImageObject',
            url: seo.jsonLdLogoUrl,
          },
        } : {}),
      },
    ],
  } : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <SeoScripts headScripts={seo.headScripts} bodyScripts={seo.bodyScripts} />
      {children}
    </>
  );
}

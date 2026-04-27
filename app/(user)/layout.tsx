import { getCore } from '../../lib/singleton';
import { SeoScripts } from './seo-scripts';
import { CmsHeader } from './cms-header';
import { CmsFooter } from './cms-footer';
import { BASE_URL } from '../../infra/config';
import { tokensToCss } from '../../lib/design-tokens';

/** User 페이지 레이아웃 — SEO head/body 스크립트 + JSON-LD + Design Tokens + Header/Footer 주입 */
export default function UserLayout({ children }: { children: React.ReactNode }) {
  const seo = getCore().getCmsSettings();
  const siteUrl = seo.siteUrl || BASE_URL;
  // 사용자 설정 design tokens → :root CSS var 로 inject. globals.css 의 default 를 override.
  const themeCss = `:root { ${tokensToCss(seo.theme)} }`;

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
      {/* Design Tokens — 사용자 설정 토큰을 :root 에 inject. globals.css default override. */}
      <style dangerouslySetInnerHTML={{ __html: themeCss }} />
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <SeoScripts headScripts={seo.headScripts} bodyScripts={seo.bodyScripts} />
      {seo.layout.header.show && <CmsHeader header={seo.layout.header} />}
      {children}
      {seo.layout.footer.show && <CmsFooter footer={seo.layout.footer} />}
    </>
  );
}

import { getCore } from '../../lib/singleton';
import { SeoScripts } from './seo-scripts';
import { CmsHeader } from './cms-header';
import { CmsFooter } from './cms-footer';
import { CmsAdSlot } from './cms-ad-slot';
import { CmsReadingProgress } from './cms-reading-progress';
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
      {/* AdSense script — Publisher ID 박혀있을 때만 head 에 자동 inject (Auto Ads + 수동 슬롯 양쪽 활성화) */}
      {seo.adsense.publisherId && (
        <script
          async
          src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${seo.adsense.publisherId}`}
          crossOrigin="anonymous"
        />
      )}
      {/* Auto Ads — Google 자동 광고 위치·형식 결정 */}
      {seo.adsense.publisherId && seo.adsense.autoAds && (
        <script
          dangerouslySetInnerHTML={{
            __html: `(adsbygoogle = window.adsbygoogle || []).push({ google_ad_client: "${seo.adsense.publisherId}", enable_page_level_ads: true });`,
          }}
        />
      )}
      {seo.layout.showReadingProgress && <CmsReadingProgress />}
      {seo.layout.header.show && <CmsHeader header={seo.layout.header} />}
      {seo.adsense.publisherId && seo.adsense.slotHeaderBottom && (
        <CmsAdSlot publisherId={seo.adsense.publisherId} slotId={seo.adsense.slotHeaderBottom} />
      )}
      {seo.adsense.publisherId && seo.adsense.slotPostTop && (
        <CmsAdSlot publisherId={seo.adsense.publisherId} slotId={seo.adsense.slotPostTop} />
      )}
      {children}
      {seo.adsense.publisherId && seo.adsense.slotPostBottom && (
        <CmsAdSlot publisherId={seo.adsense.publisherId} slotId={seo.adsense.slotPostBottom} />
      )}
      {seo.adsense.publisherId && seo.adsense.slotFooterTop && (
        <CmsAdSlot publisherId={seo.adsense.publisherId} slotId={seo.adsense.slotFooterTop} />
      )}
      {seo.layout.footer.show && <CmsFooter footer={seo.layout.footer} />}
    </>
  );
}

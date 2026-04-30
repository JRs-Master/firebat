import { getCore } from '../../lib/singleton';
import { SeoScripts } from './seo-scripts';
import { CmsHeader } from './cms-header';
import { CmsFooter } from './cms-footer';
import { CmsAdSlot } from './cms-ad-slot';
import { CmsReadingProgress } from './cms-reading-progress';
import { CmsSidebar } from './cms-sidebar';
import { BASE_URL } from '../../infra/config';
import { tokensToCss } from '../../lib/design-tokens';

/** User 페이지 레이아웃 — SEO head/body 스크립트 + JSON-LD + Design Tokens + Header/Footer 주입 */
export default async function UserLayout({ children }: { children: React.ReactNode }) {
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

  // 카카오맵 JS 키 — sysmod_kakao-map 의 secret 박힌 곳에서 받음.
  // render_map 컴포넌트가 window.__KAKAO_MAP_JS_KEY 로 접근. 미설정 시 Leaflet+OSM 폴백 (해외 전용).
  const kakaoMapJsKey = getCore().getKakaoMapJsKey() || '';

  return (
    <>
      {/* Design Tokens — 사용자 설정 토큰을 :root 에 inject. globals.css default override. */}
      <style dangerouslySetInnerHTML={{ __html: themeCss }} />
      {kakaoMapJsKey && (
        <script
          dangerouslySetInnerHTML={{ __html: `window.__KAKAO_MAP_JS_KEY=${JSON.stringify(kakaoMapJsKey)};` }}
        />
      )}
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      )}
      <SeoScripts headScripts={seo.headScripts} bodyScripts={seo.bodyScripts} />
      {/* AdSense script — Publisher ID 박혀있으면 자동 inject. Auto Ads 활성화는
       *  AdSense 콘솔 (adsense.google.com → 자동 광고) 에서 결정 — Google bot 이
       *  사이트 분석 후 광고 자동 게재. 별도 enable_page_level_ads push 코드 불필요
       *  (2023+ Google 권장 방식). */}
      {seo.adsense.publisherId && (
        <script
          async
          src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${seo.adsense.publisherId}`}
          crossOrigin="anonymous"
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
      {/* Layout Mode 4종 — full / right-sidebar / left-sidebar / boxed.
       *  full / boxed: children 만 (sidebar 없음). boxed 는 wrapper class 만 추가.
       *  right/left-sidebar: grid 컬럼에 children + CmsSidebar. 모바일은 stacked. */}
      {(seo.layout.mode === 'right-sidebar' || seo.layout.mode === 'left-sidebar') ? (
        <div className={`firebat-cms-layout-${seo.layout.mode}`}>
          {seo.layout.mode === 'left-sidebar' && (await CmsSidebar({ sidebar: seo.layout.sidebar }))}
          <div>{children}</div>
          {seo.layout.mode === 'right-sidebar' && (await CmsSidebar({ sidebar: seo.layout.sidebar }))}
        </div>
      ) : seo.layout.mode === 'boxed' ? (
        <div className="firebat-cms-layout-boxed">{children}</div>
      ) : (
        children
      )}
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

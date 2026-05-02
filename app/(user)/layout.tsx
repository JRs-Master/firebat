import { getCore } from '../../lib/singleton';
import { SeoScripts } from './seo-scripts';
import { CmsHeader } from './cms-header';
import { CmsFooter } from './cms-footer';
import { CmsAdSlot } from './cms-ad-slot';
import { CmsReadingProgress } from './cms-reading-progress';
import { CmsSidebar } from './cms-sidebar';
import { BASE_URL } from '../../infra/config';
import { tokensToCss } from '../../lib/design-tokens';
import { headers } from 'next/headers';
import type { LayoutMode } from '../../lib/cms-layout';

/** Page-level layout override 해석 — proxy.ts 가 박은 x-firebat-pathname 으로 spec 조회.
 *  spec.head.layoutMode 박혀있으면 그 값 반환. 없거나 잘못된 값이면 undefined.
 *  /search /tag/{x} 같은 explicit route 는 spec 없으므로 undefined → 글로벌 mode 사용. */
async function resolvePageLayoutOverride(): Promise<LayoutMode | undefined> {
  try {
    const h = await headers();
    const pathname = h.get('x-firebat-pathname');
    if (!pathname || pathname === '/' || pathname.startsWith('/api')) return undefined;
    // slug 추출 — leading / 제거. URL 인코딩 디코드.
    const slug = decodeURIComponent(pathname.replace(/^\/+/, '').replace(/\/+$/, ''));
    if (!slug) return undefined;
    const res = await getCore().getPage(slug);
    if (!res.success || !res.data) return undefined;
    const m = res.data.head?.layoutMode;
    if (m && ['full', 'right-sidebar', 'left-sidebar', 'both-sidebar', 'boxed'].includes(m)) {
      return m as LayoutMode;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** User 페이지 레이아웃 — SEO head/body 스크립트 + JSON-LD + Design Tokens + Header/Footer 주입 */
export default async function UserLayout({ children }: { children: React.ReactNode }) {
  const seo = getCore().getCmsSettings();
  const siteUrl = seo.siteUrl || BASE_URL;
  // Page-level layout override — spec.head.layoutMode 박혀있으면 글로벌 무시.
  const pageLayoutOverride = await resolvePageLayoutOverride();
  const layoutMode: LayoutMode = pageLayoutOverride ?? seo.layout.mode;
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

  // 카카오맵 JS 키 inject 는 root layout (app/layout.tsx) 으로 이동 — user/admin 양쪽 컨텍스트 통합.

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
      {/* Layout Mode 5종 — full / right-sidebar / left-sidebar / both-sidebar / boxed.
       *  layoutMode = page override (spec.head.layoutMode) ?? 글로벌 cms 설정.
       *  full / boxed: children 만 (sidebar 없음). boxed 는 wrapper class 만 추가.
       *  right/left-sidebar: grid 2컬럼. both-sidebar: grid 3컬럼 (좌 + 본문 + 우, 같은 SidebarConfig).
       *  모바일 (<1024px) 은 자동 stacked. */}
      {(layoutMode === 'right-sidebar' || layoutMode === 'left-sidebar' || layoutMode === 'both-sidebar') ? (
        <div className={`firebat-cms-layout-${layoutMode}`}>
          {(layoutMode === 'left-sidebar' || layoutMode === 'both-sidebar') && (await CmsSidebar({ sidebar: seo.layout.sidebar }))}
          <div>{children}</div>
          {(layoutMode === 'right-sidebar' || layoutMode === 'both-sidebar') && (await CmsSidebar({ sidebar: seo.layout.sidebar }))}
        </div>
      ) : layoutMode === 'boxed' ? (
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

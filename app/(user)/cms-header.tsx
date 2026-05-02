/**
 * CMS Header — Phase B widget 빌더 + sticky / transparent-on-top.
 *
 * Layout: 좌 / 중 / 우 3 col flex. 각 col 의 widget 배열을 CmsWidget 으로 horizontal 렌더.
 * widgets 미박힘 시 composeLayout 가 legacy (siteName/logoUrl/navLinks) 에서 자동 derive.
 *
 * Sticky: position: sticky + top: 0 + z-index: 30 (모달 z-index 보다 낮게).
 * Transparent on top: scrollY=0 일 때 배경 투명. scroll → 배경색 + border + 그림자 transition.
 *  client-side scroll listener (HeaderScrollWatcher) 가 'is-scrolled' class 토글.
 */
import type { HeaderConfig } from '../../lib/cms-layout';
import { HeaderScrollWatcher } from './cms-header-scroll-watcher';
import { MobileDrawer } from './cms-mobile-drawer';
import { CmsWidget } from './cms-widget-renderer';

export function CmsHeader({ header }: { header: HeaderConfig }) {
  // sticky CSS — server-side 결정. transparent-on-top 은 client 가 scroll 추적 후 toggle.
  const stickyStyle = header.sticky
    ? { position: 'sticky' as const, top: 0, zIndex: 30 }
    : {};
  // transparent on top: 초기 배경 투명 + transition. scroll 시 client 가 'is-scrolled' class 추가.
  const transparentInitial = header.transparentOnTop
    ? {
        background: 'transparent',
        borderBottom: '1px solid transparent',
        transition: 'background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease',
      }
    : {
        background: 'var(--cms-bg)',
        borderBottom: '1px solid var(--cms-border)',
      };

  const widgets = header.widgets ?? { left: [], center: [], right: [] };

  return (
    <header
      data-cms-header
      data-transparent-on-top={header.transparentOnTop ? '1' : undefined}
      className={header.transparentOnTop ? 'cms-header-transparent' : ''}
      style={{
        ...transparentInitial,
        color: 'var(--cms-text)',
        ...stickyStyle,
      }}
    >
      <div className="firebat-cms-content" style={{ paddingTop: '14px', paddingBottom: '14px' }}>
        <div className="flex items-center gap-3 flex-wrap">
          {/* 좌 col */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {widgets.left.map((slot, i) => (
              <CmsWidget key={`l-${i}`} slot={slot} area="header" />
            ))}
          </div>
          {/* 중 col — 없으면 spacer 로 우측 push */}
          {widgets.center.length > 0 ? (
            <div className="flex items-center gap-3 flex-1 justify-center">
              {widgets.center.map((slot, i) => (
                <CmsWidget key={`c-${i}`} slot={slot} area="header" />
              ))}
            </div>
          ) : (
            <div className="flex-1" />
          )}
          {/* 우 col */}
          <div className="flex items-center gap-3 sm:gap-5 flex-shrink-0 flex-wrap justify-end">
            {widgets.right.map((slot, i) => (
              <CmsWidget key={`r-${i}`} slot={slot} area="header" />
            ))}
            {/* 모바일 햄버거 drawer — header.mobileDrawer ON 시 자동 inject (widget 시스템과 별도) */}
            {header.mobileDrawer && <MobileDrawer navLinks={header.navLinks} />}
          </div>
        </div>
      </div>
      {header.transparentOnTop && <HeaderScrollWatcher />}
    </header>
  );
}

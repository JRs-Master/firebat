/**
 * CMS Header — Phase 4 + sticky / transparent-on-top.
 *
 * 토큰 적용: 배경 var(--cms-bg), 텍스트 var(--cms-text), 테두리 var(--cms-border).
 * 모바일 반응형 — 네비 링크 가로 wrap.
 *
 * Sticky: position: sticky + top: 0 + z-index: 30 (모달 z-index 보다 낮게).
 * Transparent on top: scrollY=0 일 때 배경 투명. scroll → 배경색 + border + 그림자 transition.
 *  client-side scroll listener (HeaderScrollWatcher) 가 'is-scrolled' class 토글.
 */
import type { HeaderConfig } from '../../lib/cms-layout';
import { HeaderScrollWatcher } from './cms-header-scroll-watcher';
import { MobileDrawer } from './cms-mobile-drawer';

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
        <div className="flex items-center justify-between flex-wrap gap-3">
          <a
            href="/"
            className="flex items-center gap-2 no-underline"
            style={{ color: 'var(--cms-text)' }}
          >
            {header.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={header.logoUrl} alt={header.siteName} className="h-7 w-auto" />
            )}
            <span
              className="text-base sm:text-lg font-bold tracking-tight"
              style={{ fontFamily: 'var(--cms-font-heading)' }}
            >
              {header.siteName}
            </span>
          </a>
          {/* Desktop nav — sm 이상. mobileDrawer ON 이면 모바일에선 hidden + drawer 사용. */}
          <nav className={`items-center gap-3 sm:gap-5 ${header.mobileDrawer ? 'hidden sm:flex' : 'flex flex-wrap'}`}>
            {header.navLinks.map((link, i) => (
              <a
                key={i}
                href={link.href}
                className="text-[13px] sm:text-sm font-medium hover:opacity-70 transition-opacity no-underline"
                style={{ color: 'var(--cms-text)' }}
              >
                {link.label}
              </a>
            ))}
            <a
              href="/search"
              aria-label="검색"
              title="검색"
              className="flex items-center justify-center hover:opacity-70 transition-opacity no-underline p-1 -m-1"
              style={{ color: 'var(--cms-text)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </a>
          </nav>

          {/* Mobile drawer — mobileDrawer ON 시 모바일에서만 햄버거 + slide drawer. */}
          {header.mobileDrawer && <MobileDrawer navLinks={header.navLinks} />}
        </div>
      </div>
      {/* Client-side scroll watcher — transparentOnTop 활성 시 scroll → is-scrolled class. */}
      {header.transparentOnTop && <HeaderScrollWatcher />}
    </header>
  );
}

/**
 * CMS Header — Phase 4. 사용자 페이지 상단 헤더.
 *
 * 토큰 적용: 배경 var(--cms-bg), 텍스트 var(--cms-text), 테두리 var(--cms-border).
 * 모바일 반응형 — 네비 링크 가로 wrap.
 */
import type { HeaderConfig } from '../../lib/cms-layout';

export function CmsHeader({ header }: { header: HeaderConfig }) {
  return (
    <header
      style={{
        background: 'var(--cms-bg)',
        borderBottom: '1px solid var(--cms-border)',
        color: 'var(--cms-text)',
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
          {header.navLinks.length > 0 && (
            <nav className="flex items-center gap-3 sm:gap-5 flex-wrap">
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
            </nav>
          )}
        </div>
      </div>
    </header>
  );
}

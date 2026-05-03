'use client';

/**
 * Mobile Drawer — 모바일(sm 미만)에서 nav 링크 + 검색을 슬라이드 drawer 로 표시.
 *
 * 햄버거 버튼 클릭 → 우측에서 slide-in. backdrop 클릭 / ESC / 링크 클릭 시 닫힘.
 * body overflow:hidden — drawer 열린 동안 본문 스크롤 잠금.
 * 데스크톱은 horizontal nav (이 컴포넌트는 sm 이상에서 hidden).
 *
 * design tokens (var(--cms-bg)/text/border) 일관 적용.
 */
import { useState, useEffect, type ReactNode } from 'react';
import type { NavLink } from '../../lib/cms-layout';
import { SearchTrigger } from './cms-search-modal';

/**
 * `sidebarSlot` 은 server-side 에서 미리 렌더된 widgets JSX (ReactNode).
 * cms-mobile-drawer 는 'use client' 라 server-only 의존성 (getCore 등) 이 있는
 * `cms-widget-renderer` 를 직접 import 하면 client bundle 에 fs/path 가 끌려와 build fail.
 * 따라서 cms-header (server) 가 위에서 미리 렌더해 ReactNode 로 prop 전달.
 */
export function MobileDrawer({ navLinks, sidebarSlot }: { navLinks: NavLink[]; sidebarSlot?: ReactNode }) {
  const [open, setOpen] = useState(false);

  // ESC 닫기 + body scroll lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      {/* 햄버거 버튼 — sm 미만에서만 표시 (sm 이상은 horizontal nav). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="메뉴 열기"
        title="메뉴"
        className="flex sm:hidden items-center justify-center p-1 -m-1 hover:opacity-70 transition-opacity bg-transparent border-0 cursor-pointer"
        style={{ color: 'var(--cms-text)' }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Backdrop — 반투명 검정, 클릭 시 닫힘 */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden="true"
          className="fixed inset-0 sm:hidden"
          style={{ background: 'rgba(0, 0, 0, 0.45)', zIndex: 40 }}
        />
      )}

      {/* Drawer — 우측에서 slide-in. width 280px (모바일 화면의 ~75%) */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="모바일 메뉴"
        className="fixed top-0 right-0 h-full sm:hidden flex flex-col"
        style={{
          width: '280px',
          maxWidth: '85vw',
          background: 'var(--cms-bg)',
          color: 'var(--cms-text)',
          borderLeft: '1px solid var(--cms-border)',
          boxShadow: '-4px 0 24px rgba(0, 0, 0, 0.12)',
          zIndex: 50,
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.25s ease',
          willChange: 'transform',
        }}
      >
        {/* 헤더 — 닫기 버튼 */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--cms-border)' }}
        >
          <span className="text-sm font-bold" style={{ fontFamily: 'var(--cms-font-heading)' }}>
            메뉴
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="메뉴 닫기"
            className="flex items-center justify-center p-1 -m-1 hover:opacity-70 transition-opacity bg-transparent border-0 cursor-pointer"
            style={{ color: 'var(--cms-text)' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 검색 — drawer 상단. 클릭 시 drawer close + 검색 모달 popup */}
        <div className="p-4">
          <SearchTrigger
            ariaLabel="검색 열기"
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-sm border rounded outline-none cursor-pointer text-left bg-transparent"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--cms-text-muted)' }}>
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span style={{ color: 'var(--cms-text-muted)' }}>검색어...</span>
          </SearchTrigger>
        </div>

        {/* 본문 — Nav 링크 + (옵션) sidebar widgets. 세로 스크롤. */}
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {/* Nav 링크 — drawer 진입 시 가장 먼저 보이는 핵심 navigation */}
          {navLinks.length === 0 ? (
            <p className="text-xs px-2 py-4" style={{ color: 'var(--cms-text-muted)' }}>
              네비게이션 링크가 없습니다.
            </p>
          ) : (
            <nav>
              <ul className="list-none p-0 m-0 flex flex-col">
                {navLinks.map((link, i) => (
                  <li key={i}>
                    <a
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className="block px-3 py-2.5 text-sm font-medium no-underline rounded hover:opacity-80 transition-opacity"
                      style={{ color: 'var(--cms-text)' }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          {/* Sidebar widgets — header.mobileDrawerIncludeSidebar=ON 일 때 cms-header 가
              server-side 에서 미리 렌더해 sidebarSlot 으로 전달 (검색 / 카테고리 / 최근글 / 태그 등). */}
          {sidebarSlot && (
            <div
              className="mt-4 pt-4 border-t flex flex-col gap-4"
              style={{ borderColor: 'var(--cms-border)' }}
            >
              {sidebarSlot}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

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
import { useState, useEffect } from 'react';
import type { NavLink } from '../../lib/cms-layout';

export function MobileDrawer({ navLinks }: { navLinks: NavLink[] }) {
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

        {/* 검색 form — drawer 상단 */}
        <form method="get" action="/search" className="p-4 flex items-stretch gap-1.5" onSubmit={() => setOpen(false)}>
          <input
            type="search"
            name="q"
            placeholder="검색어..."
            className="flex-1 px-2.5 py-1.5 text-sm border rounded outline-none min-w-0"
            style={{
              background: 'var(--cms-bg-card)',
              borderColor: 'var(--cms-border)',
              color: 'var(--cms-text)',
            }}
          />
          <button
            type="submit"
            className="px-2.5 py-1.5 text-sm font-bold rounded transition-opacity hover:opacity-90 shrink-0 border-0 cursor-pointer"
            style={{ background: 'var(--cms-primary)', color: '#fff' }}
            aria-label="검색"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </form>

        {/* Nav 링크 — 세로 list */}
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {navLinks.length === 0 ? (
            <p className="text-xs px-2 py-4" style={{ color: 'var(--cms-text-muted)' }}>
              네비게이션 링크가 없습니다.
            </p>
          ) : (
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
          )}
        </nav>
      </aside>
    </>
  );
}

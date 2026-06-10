'use client';

// 재사용 "..." 오버플로 메뉴 — 앵커 팝오버 (controlled). 표준 UX:
//  - document.body 로 portal → 사이드바/패널의 overflow-y-auto 스크롤 컨테이너를 탈출(잘림·fold 아래 숨김 해소).
//  - anchorRef(트리거) getBoundingClientRect 기준 position:fixed 앵커. 아래 공간 부족하면 위로 flip + 뷰포트 안 clamp.
//  - 바깥 클릭 / Esc / 스크롤·리사이즈 → onClose (스크롤은 capture 로 모든 컨테이너 감지).
// 기존 패널의 openMenu 상태/핸들러는 그대로 두고, absolute-in-scroll 드롭다운만 이걸로 감싸 위치 문제만 해결.
// 사용:
//   const triggerRef = useRef<HTMLButtonElement|null>(null);
//   <button ref={open===id ? triggerRef : undefined} onClick={()=>setOpen(toggle)}>…</button>
//   {open===id && <AnchoredMenu anchorRef={triggerRef} onClose={()=>setOpen(null)}>…items…</AnchoredMenu>}
import { useRef, useLayoutEffect, useEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function AnchoredMenu({
  anchorRef,
  onClose,
  children,
  align = 'end',
  minWidth = 176,
  className = '',
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** 'end' = 트리거 오른쪽 끝 정렬(기본) / 'start' = 왼쪽. */
  align?: 'start' | 'end';
  minWidth?: number;
  className?: string;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 위치 — 트리거 rect 기준. 아래 넘치면 위로 flip, 좌우 뷰포트 안 clamp. 메뉴 실측 후 보정(2-pass).
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) { setPos(null); return; }
    const r = a.getBoundingClientRect();
    const gap = 4;
    const mh = menuRef.current?.offsetHeight ?? 0;
    const mw = Math.max(menuRef.current?.offsetWidth ?? minWidth, minWidth);
    let top = r.bottom + gap;
    if (mh && top + mh > window.innerHeight - 8) {
      const up = r.top - gap - mh;
      top = up >= 8 ? up : Math.max(8, window.innerHeight - mh - 8);
    }
    let left = align === 'end' ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    setPos({ top, left });
  }, [anchorRef, align, minWidth]);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true); // capture — 내부 스크롤 컨테이너까지
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [anchorRef, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        minWidth,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 70,
      }}
      className={`bg-white border border-slate-200 rounded-xl shadow-lg py-1 overflow-hidden ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}

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
// 메뉴 항목이 상세 서브메뉴를 열어야 하면 → 이 파일의 `CascadeMenuItem`(표준, 아래 참조).
import {
  useRef, useLayoutEffect, useEffect, useState, useCallback, useContext, createContext,
  type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';

// Nested menu registry — a cascade submenu is a React child of its parent menu but portals to
// <body>, so the parent's DOM contains() check would read a click inside the child as "outside"
// and tear the whole tree down on mousedown (the click would never reach the item). Each menu
// hands its children a register() through context; a child registers its own element, and the
// parent counts registered nodes as inside. One shared outside-click rule, any depth.
type RegisterNestedMenu = (el: HTMLElement) => () => void;
const NestedMenuContext = createContext<RegisterNestedMenu | null>(null);

export function AnchoredMenu({
  anchorRef,
  onClose,
  children,
  align = 'end',
  placement = 'bottom',
  minWidth = 176,
  className = '',
  onMouseEnter,
  onMouseLeave,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** 'end' = 트리거 오른쪽 끝 정렬(기본) / 'start' = 왼쪽. placement='right' 에선 무시됩니다. */
  align?: 'start' | 'end';
  /** 'bottom' = 트리거 아래(기본) / 'right' = 트리거 오른쪽 옆 = Windows 식 캐스케이드 서브메뉴. */
  placement?: 'bottom' | 'right';
  minWidth?: number;
  className?: string;
  /** 호버 유예(grace) 배선용 — 캐스케이드 서브메뉴가 닫힘 타이머를 취소·예약하는 자리. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 중첩 메뉴 — 내 자식(서브메뉴)들을 "안"으로 세고, 나 자신은 부모에게 등록한다.
  const nested = useRef<Set<HTMLElement>>(new Set());
  const register = useCallback<RegisterNestedMenu>((el) => {
    nested.current.add(el);
    return () => { nested.current.delete(el); };
  }, []);
  const registerWithParent = useContext(NestedMenuContext);
  useEffect(() => {
    const el = menuRef.current;
    if (!registerWithParent || !el) return;
    return registerWithParent(el);
  }, [registerWithParent]);

  // 위치 — 트리거 rect 기준. 아래 넘치면 위로 flip, 좌우 뷰포트 안 clamp. 메뉴 실측 후 보정(2-pass).
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) { setPos(null); return; }
    const r = a.getBoundingClientRect();
    const gap = 4;
    const mh = menuRef.current?.offsetHeight ?? 0;
    const mw = Math.max(menuRef.current?.offsetWidth ?? minWidth, minWidth);
    if (placement === 'right') {
      // 캐스케이드 — 항목 오른쪽에 붙이고 위쪽 정렬. 오른쪽이 좁으면 왼쪽으로 flip, 아래는 clamp.
      let top = r.top;
      if (mh && top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
      let left = r.right + gap;
      if (left + mw > window.innerWidth - 8) {
        const leftSide = r.left - gap - mw;
        left = leftSide >= 8 ? leftSide : Math.max(8, window.innerWidth - mw - 8);
      }
      setPos({ top, left });
      return;
    }
    let top = r.bottom + gap;
    if (mh && top + mh > window.innerHeight - 8) {
      const up = r.top - gap - mh;
      top = up >= 8 ? up : Math.max(8, window.innerHeight - mh - 8);
    }
    let left = align === 'end' ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    setPos({ top, left });
  }, [anchorRef, align, placement, minWidth]);

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      for (const child of nested.current) if (child.contains(t)) return;
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
      data-anchored-menu=""
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
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
      <NestedMenuContext.Provider value={register}>{children}</NestedMenuContext.Provider>
    </div>,
    document.body,
  );
}

/** 메뉴 항목 공통 꼴 — 캐스케이드 항목이 형제 항목들과 같은 시각 언어를 쓰도록 한 곳에서. */
export const MENU_ITEM_CLASS =
  'w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40';

/**
 * CascadeMenuItem — 상세 서브메뉴를 여는 메뉴 항목의 **표준**.
 *
 * 새 메뉴 항목이 "항목 하나 → 상세 목록"을 필요로 하면 직접 배선하지 말고 이걸 쓸 것.
 * (행 액션 가시성이 `rowActionsClass` 한 곳으로 모이는 것과 같은 취급.)
 * ⚠️ 사이드바 트리의 chevron 펼침(스케줄·자동매매 행)과는 다른 인터랙션이다 — 저건 제자리 확장,
 * 이건 항목 옆에 뜨는 상세 메뉴. 서로 참조·통합하지 말 것.
 *
 * 동작 (Windows 캐스케이드):
 *  - 항목 hover → 오른쪽에 서브메뉴. 클릭도 같은 결과(키보드·a11y fallback).
 *  - 항목/서브메뉴에서 마우스가 나가면 닫기를 **예약**(GRACE_MS)하고 둘 중 하나에 다시 들어오면
 *    취소 — 항목에서 서브메뉴로 가는 대각선 경로가 살아난다.
 *  - 같은 메뉴의 **다른 항목**에 들어가면 즉시 닫힘(부모 메뉴 element 의 mouseover 위임).
 *  - 부모 메뉴가 닫히면(Esc·바깥 클릭·항목 실행) 이 항목째 언마운트되므로 서브메뉴도 함께 사라진다.
 *
 * hover 가 없는 기기(`useRowActions().hoverNone`)에서는 hover 가 아예 발화하지 않으므로
 * **호출부가 자기 터치 경로를 렌더한다**(예: 같은 메뉴를 목록으로 뒤집는 flip). 이 컴포넌트는
 * hover 기기 전용이다.
 */
export function CascadeMenuItem({
  label,
  icon,
  disabled = false,
  minWidth = 128,
  className = '',
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** 서브메뉴 패널 최소 폭. */
  minWidth?: number;
  /** 항목 버튼 추가 클래스. */
  className?: string;
  /** 서브메뉴 내용 = 형제 메뉴 항목들과 같은 꼴의 버튼들. */
  children: ReactNode;
}) {
  const GRACE_MS = 150;
  const itemRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    timer.current = setTimeout(() => { timer.current = null; setOpen(false); }, GRACE_MS);
  }, [cancelClose]);
  const openNow = useCallback(() => { cancelClose(); setOpen(true); }, [cancelClose]);
  const closeNow = useCallback(() => { cancelClose(); setOpen(false); }, [cancelClose]);

  // 타이머는 언마운트에서 반드시 회수(부모 메뉴가 통째로 사라지는 게 정상 경로다).
  useEffect(() => cancelClose, [cancelClose]);

  // 다른 항목으로 옮기면 즉시 닫힘 — 부모 메뉴 element 에 위임한다. 서브메뉴는 body 로 portal 돼
  // DOM 상 부모 메뉴의 자손이 아니므로, 서브메뉴 안 이동은 여기로 버블하지 않는다.
  useEffect(() => {
    if (!open) return;
    const root = itemRef.current?.closest('[data-anchored-menu]');
    if (!root) return;
    const onOver = (e: Event) => {
      const t = e.target as Node;
      if (itemRef.current?.contains(t)) return;
      closeNow();
    };
    root.addEventListener('mouseover', onOver);
    return () => root.removeEventListener('mouseover', onOver);
  }, [open, closeNow]);

  return (
    <>
      <button
        ref={itemRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onClick={(e) => { e.stopPropagation(); openNow(); }}
        className={`${MENU_ITEM_CLASS} justify-between ${open ? 'bg-slate-50' : ''} ${className}`}
      >
        <span className="flex items-center gap-2">{icon}{label}</span>
        <ChevronRight size={10} className="text-slate-400" />
      </button>
      {open && !disabled && (
        <AnchoredMenu
          anchorRef={itemRef}
          placement="right"
          minWidth={minWidth}
          onClose={closeNow}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {children}
        </AnchoredMenu>
      )}
    </>
  );
}

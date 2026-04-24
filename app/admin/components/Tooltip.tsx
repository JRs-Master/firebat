'use client';

/**
 * Tooltip — 네이티브 `title` 속성 대체용 재사용 컴포넌트.
 *
 * 왜 만들었나:
 *  - 브라우저 기본 title 은 커서가 멈춰있어야만 뜨고, 조금만 움직여도 리셋.
 *  - 터치 기기(모바일) 에서 아예 미지원.
 *  - 브라우저마다 지연·동작 달라 "나왔다 안나왔다" 느낌.
 *
 * 디자인:
 *  - StockChart 내부 툴팁 스타일 계승 (bg-slate-900/95, rounded-lg, text-[11px]).
 *  - 300ms 호버 지연 — 커서 스쳐 지나갈 때 스팸 방지.
 *  - document.body 에 Portal 렌더 — 사이드바 overflow-hidden 등 부모 clipping 회피.
 *  - fixed 포지셔닝 + trigger 의 boundingRect 기준 자동 배치 + 화면 경계 near 시 flip.
 *
 * 사용:
 *   <Tooltip label="Workspace"><button>...</button></Tooltip>
 *   <Tooltip label="..." side="top|bottom|left|right" delay={500}>...</Tooltip>
 */
import React, { useState, useRef, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  label: React.ReactNode;
  /** 기본 방향 — 경계 침범 시 반대로 flip */
  side?: Side;
  /** 호버 지연(ms) — 기본 300 */
  delay?: number;
  /** 터치 기기에선 비활성 (기본 true) */
  disabledOnTouch?: boolean;
  children: React.ReactElement;
}

export function Tooltip({ label, side = 'bottom', delay = 300, disabledOnTouch = true, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number; transform: string } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isTouch = typeof window !== 'undefined' && 'ontouchstart' in window;

  const compute = useCallback(() => {
    const el = triggerRef.current;
    const tip = tipRef.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = 0, y = 0, transform = '';
    let actual: Side = side;

    // flip 로직 — 경계 밖이면 반대쪽으로
    if (side === 'bottom' && r.bottom + th + gap > vh) actual = 'top';
    if (side === 'top' && r.top - th - gap < 0) actual = 'bottom';
    if (side === 'right' && r.right + tw + gap > vw) actual = 'left';
    if (side === 'left' && r.left - tw - gap < 0) actual = 'right';

    if (actual === 'bottom') { x = r.left + r.width / 2; y = r.bottom + gap; transform = 'translateX(-50%)'; }
    else if (actual === 'top') { x = r.left + r.width / 2; y = r.top - gap; transform = 'translate(-50%, -100%)'; }
    else if (actual === 'right') { x = r.right + gap; y = r.top + r.height / 2; transform = 'translateY(-50%)'; }
    else if (actual === 'left') { x = r.left - gap; y = r.top + r.height / 2; transform = 'translate(-100%, -50%)'; }

    // 좌우 경계 보정 (bottom/top 일 때만 — 중앙 정렬 중 화면 밖 넘침 방지)
    if (actual === 'bottom' || actual === 'top') {
      const halfW = tw / 2;
      if (x - halfW < 4) { x = 4; transform = transform.replace('translateX(-50%)', 'translateX(0)'); }
      else if (x + halfW > vw - 4) { x = vw - 4; transform = transform.replace('translateX(-50%)', 'translateX(-100%)'); }
    }

    setCoords({ x, y, transform });
  }, [side]);

  const show = () => {
    if (isTouch && disabledOnTouch) return;
    timerRef.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setOpen(false);
    setCoords(null);
  };

  // 열린 후 DOM mount 되면 좌표 계산
  useLayoutEffect(() => {
    if (open) compute();
  }, [open, compute]);

  // children 에 event handler + ref 주입
  const child = React.Children.only(children);
  const trigger = React.cloneElement(child as React.ReactElement<any>, {
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
      const origRef = (child as any).ref;
      if (typeof origRef === 'function') origRef(el);
      else if (origRef && typeof origRef === 'object') (origRef as any).current = el;
    },
    onMouseEnter: (e: React.MouseEvent) => { show(); (child.props as any).onMouseEnter?.(e); },
    onMouseLeave: (e: React.MouseEvent) => { hide(); (child.props as any).onMouseLeave?.(e); },
    onFocus: (e: React.FocusEvent) => { show(); (child.props as any).onFocus?.(e); },
    onBlur: (e: React.FocusEvent) => { hide(); (child.props as any).onBlur?.(e); },
  });

  // Portal 은 클라이언트 마운트 후에만
  const portal = typeof document !== 'undefined' && open ? createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="fixed z-[100] pointer-events-none bg-slate-900/95 text-white rounded-lg px-2 py-1 text-[11px] shadow-lg whitespace-nowrap font-medium"
      style={{
        left: coords?.x ?? 0,
        top: coords?.y ?? 0,
        transform: coords?.transform,
        visibility: coords ? 'visible' : 'hidden',
      }}
    >
      {label}
    </div>,
    document.body,
  ) : null;

  return <>{trigger}{portal}</>;
}

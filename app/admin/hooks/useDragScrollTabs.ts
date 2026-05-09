/**
 * useDragScrollTabs — 수평 탭 바의 드래그 스크롤 + 좌/우 화살표 (호버 시 노출).
 *
 * SettingsModal 의 탭 바 패턴 추출. Sidebar / 다른 탭 영역에서도 같은 UX 일관 적용.
 *
 * 사용:
 *   const { tabBarRef, scrollState, scrollTabs } = useDragScrollTabs();
 *   <div className="relative group">
 *     {scrollState.canLeft && <button onClick={() => scrollTabs('left')}>◀</button>}
 *     {scrollState.canRight && <button onClick={() => scrollTabs('right')}>▶</button>}
 *     <div ref={tabBarRef} className="flex overflow-x-auto scrollbar-none cursor-grab">...</div>
 *   </div>
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export function useDragScrollTabs() {
  const tabBarRef = useRef<HTMLDivElement>(null);
  const draggedRef = useRef(false);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });

  const updateScrollState = useCallback(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    setScrollState({
      canLeft: bar.scrollLeft > 2,
      canRight: bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 2,
    });
  }, []);

  // 마우스 드래그 스크롤 — 임계값 넘어야 드래그로 간주 (클릭 충돌 방지)
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    let isDown = false;
    let startX = 0;
    let startScroll = 0;
    const DRAG_THRESHOLD = 5;
    const onDown = (e: MouseEvent) => {
      isDown = true;
      startX = e.pageX;
      startScroll = bar.scrollLeft;
      draggedRef.current = false;
    };
    const onMove = (e: MouseEvent) => {
      if (!isDown) return;
      const dx = e.pageX - startX;
      if (!draggedRef.current && Math.abs(dx) < DRAG_THRESHOLD) return;
      draggedRef.current = true;
      bar.style.cursor = 'grabbing';
      e.preventDefault();
      bar.scrollLeft = startScroll - dx;
    };
    const onUp = () => {
      isDown = false;
      bar.style.cursor = '';
      setTimeout(() => { draggedRef.current = false; }, 0);
    };
    const onClickCapture = (e: MouseEvent) => {
      if (draggedRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    bar.addEventListener('mousedown', onDown);
    bar.addEventListener('click', onClickCapture, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      bar.removeEventListener('mousedown', onDown);
      bar.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 스크롤 상태 추적 — scroll / resize 시 화살표 가시성 갱신
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    updateScrollState();
    bar.addEventListener('scroll', updateScrollState);
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(bar);
    return () => {
      bar.removeEventListener('scroll', updateScrollState);
      ro.disconnect();
    };
  }, [updateScrollState]);

  const scrollTabs = useCallback((dir: 'left' | 'right', amount = 120) => {
    const bar = tabBarRef.current;
    if (!bar) return;
    bar.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  }, []);

  return { tabBarRef, scrollState, scrollTabs };
}

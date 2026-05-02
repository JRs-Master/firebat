'use client';

/**
 * HeaderScrollWatcher — transparent-on-top 헤더 활성 시 scroll 추적.
 *
 * scrollY > 8px 이면 부모 <header data-cms-header> 에 is-scrolled class 추가 →
 * CSS 규칙이 배경색·border 채움. 0px 복귀 시 class 제거 → 다시 투명.
 *
 * passive listener + rAF throttle — 60fps 충돌 없음.
 * 컴포넌트 자체는 렌더 0 (DOM 미생성, 사이드 이펙트만).
 */
import { useEffect } from 'react';

const SCROLL_THRESHOLD = 8;

export function HeaderScrollWatcher() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>('[data-cms-header][data-transparent-on-top="1"]');
    if (!header) return;

    let ticking = false;
    let lastScrolled = false;

    const update = () => {
      ticking = false;
      const isScrolled = window.scrollY > SCROLL_THRESHOLD;
      if (isScrolled !== lastScrolled) {
        lastScrolled = isScrolled;
        if (isScrolled) {
          header.classList.add('is-scrolled');
        } else {
          header.classList.remove('is-scrolled');
        }
      }
    };

    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    };

    // 초기 상태 — 페이지 진입 시 이미 스크롤 위치가 있을 수 있음 (anchor 진입).
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return null;
}

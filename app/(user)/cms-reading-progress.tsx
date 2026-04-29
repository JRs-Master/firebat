'use client';
/**
 * Reading Progress — 페이지 상단 가로 progress bar.
 *
 * Phase 4 Step 7. 사용자 스크롤 진행도 표시 (재미·UX 요소). design tokens 적용 (accent 색).
 * CMS settings 의 layoutShowReadingProgress 토글로 ON/OFF.
 *
 * client component — window 의 scroll/resize 이벤트 listen.
 */
import { useEffect, useState } from 'react';

export function CmsReadingProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // 모바일 jank fix — scroll event 매 호출마다 docHeight 읽지 X (forced reflow).
    // resize 시점에만 cache 갱신. scroll 중엔 raf throttle 로 frame 당 1회 setState.
    let rafId: number | null = null;
    let docHeight = 0;
    const recalc = () => {
      docHeight = document.documentElement.scrollHeight - window.innerHeight;
    };
    const update = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (docHeight <= 0) { setProgress(0); return; }
        const pct = Math.min(100, Math.max(0, (window.scrollY / docHeight) * 100));
        setProgress(pct);
      });
    };
    const onResize = () => { recalc(); update(); };
    recalc();
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        height: '3px',
        width: `${progress}%`,
        background: 'var(--cms-accent)',
        zIndex: 9999,
        // transition 제거 — raf 마다 부드럽게 갱신되므로 transition 이 오히려 lag 생성
      }}
      aria-hidden="true"
    />
  );
}

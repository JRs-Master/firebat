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
    const update = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) { setProgress(0); return; }
      const pct = Math.min(100, Math.max(0, (scrollTop / docHeight) * 100));
      setProgress(pct);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
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
        transition: 'width 0.1s ease-out',
      }}
      aria-hidden="true"
    />
  );
}

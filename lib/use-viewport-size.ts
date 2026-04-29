'use client';

import { useState, useEffect } from 'react';

/**
 * Viewport 가로·세로 측정 hook — iOS Safari toolbar quirk 우회 단일 source.
 *
 * **왜 필요한가**:
 * iOS Safari 가 사용자 스크롤 시 주소창/하단 toolbar 자동 숨김 → viewport 늘어남.
 * `vh` / `svh` / `dvh` CSS 단위는 브라우저 버전별로 toolbar 변동 처리가 달라 박스
 * 흔들림 quirk 발생. 표/모달/이미지 박스 등에 vh 박으면 스크롤 중 박스 길이가
 * 갑자기 늘어나 사용자 체감 불안정.
 *
 * **해결**: JS 로 첫 렌더 시 innerWidth/innerHeight 측정 + 픽셀 단위 박음.
 * iOS toolbar 자동 변동은 `resize` 이벤트 발화 X (layout 안 트리거) → 픽셀 박스
 * 안 흔들림. resize / orientationchange (회전 등 진짜 변동) 만 재측정.
 *
 * **반환**:
 * - 첫 렌더 시 `null` (SSR 안전 — fallback CSS 박아 깜빡임 회피)
 * - hydration 후 실제 px 값
 * - resize / orientationchange 시 자동 갱신
 *
 * **사용**:
 * ```tsx
 * const { vw, vh } = useViewportSize();
 * const maxH = vh ? `${Math.floor(vh * 0.7)}px` : '70vh'; // SSR fallback
 * <div style={{ maxHeight: maxH }} />
 * ```
 */
export function useViewportSize(): { vw: number | null; vh: number | null } {
  const [size, setSize] = useState<{ vw: number | null; vh: number | null }>({ vw: null, vh: null });

  useEffect(() => {
    const measure = () => setSize({ vw: window.innerWidth, vh: window.innerHeight });
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  return size;
}

/**
 * Convenience: viewport height 의 N% 를 픽셀로 반환.
 *
 * **단일 ratio**: 모바일·데스크톱 동일 비율
 * ```tsx
 * useViewportMaxHeight(0.7) // 모든 화면 70%
 * ```
 *
 * **분기 ratio**: 모바일·데스크톱 다른 비율 (광고·터치 영역 확보용)
 * ```tsx
 * useViewportMaxHeight({ mobile: 0.4, desktop: 0.7 })
 * // < 768px: 40%, 768px+: 70%
 * ```
 *
 * @returns 픽셀 값 또는 null (SSR 첫 렌더 — fallback CSS 박아 깜빡임 회피)
 */
export function useViewportMaxHeight(
  ratio: number | { mobile: number; desktop: number; breakpoint?: number },
): number | null {
  const { vw, vh } = useViewportSize();
  if (vh == null) return null;
  if (typeof ratio === 'number') return Math.floor(vh * ratio);
  const bp = ratio.breakpoint ?? 768;
  const isMobile = vw != null && vw < bp;
  return Math.floor(vh * (isMobile ? ratio.mobile : ratio.desktop));
}

/**
 * Convenience: viewport width 의 N% 를 픽셀로 반환.
 */
export function useViewportMaxWidth(ratio: number): number | null {
  const { vw } = useViewportSize();
  return vw != null ? Math.floor(vw * ratio) : null;
}

'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * 사이드바 패널 공통 행-액션 인터랙션 훅.
 *
 * 패널마다 제각각이던 터치 처리를 한 메커니즘으로 통일한다. `rowActionsClass(isActive)` 와 함께 사용:
 * - **PC(hover 가능)**: 행 본문 클릭 = 기본 동작(상세 열기·펼치기 등) 즉시 실행. 액션 버튼은 hover 로 노출.
 * - **모바일(hover 불가)**: 행을 처음 탭 = 활성화(액션 버튼 노출, 기본 동작 억제). 활성 상태에서 같은
 *   행 본문 재탭 = 기본 동작 실행. 다른 행 탭 = 활성 전환.
 *
 * 이렇게 해서 모바일의 두 버그를 동시에 차단한다 — (1) 버튼 항상 노출로 인한 예측 터치 삭제,
 * (2) 첫 탭에 곧장 상세로 진입. 첫 탭은 항상 "버튼 노출" 까지만.
 *
 * `(hover: none)` 미디어쿼리로 터치 기기를 판정해 `rowActionsClass` 의 `sm:` 브레이크포인트와 결을 맞춘다.
 */
export function useRowActions() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoverNone, setHoverNone] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(hover: none)');
    setHoverNone(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setHoverNone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const isActive = useCallback((id: string) => activeId === id, [activeId]);

  /**
   * 행 본문 클릭 핸들러. `primary` = 기본 동작(상세 열기·펼치기 등, 선택적).
   * PC 는 즉시 `primary`. 모바일은 첫 탭에 활성화(버튼 노출)만, 활성 상태 재탭에 `primary` 실행.
   */
  const handleRowClick = useCallback(
    (id: string, primary?: () => void) => {
      if (!hoverNone) {
        primary?.();
        return;
      }
      if (activeId === id) {
        primary?.();
      } else {
        setActiveId(id);
      }
    },
    [hoverNone, activeId],
  );

  /**
   * 트리·탐색 행용 — `primary`(폴더 토글 등)는 PC·모바일 모두 즉시 실행하고, 모바일에서는 그 행을
   * 활성화해 액션 버튼도 같이 노출한다. (목록 행의 두 단계와 달리 탐색은 한 번 탭에 진행돼야 자연스러움)
   */
  const handleNavClick = useCallback(
    (id: string, primary?: () => void) => {
      primary?.();
      if (hoverNone) setActiveId(id);
    },
    [hoverNone],
  );

  const clear = useCallback(() => setActiveId(null), []);

  return { activeId, isActive, handleRowClick, handleNavClick, setActiveId, clear, hoverNone };
}

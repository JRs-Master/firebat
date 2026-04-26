/**
 * 행 액션 영역 className — 모바일·PC 통합. CSS only (isMobile JS state 불필요).
 *
 * - Mobile (< sm): isSelected 시만 보임. 미선택 시 opacity-0 + pointer-events-none.
 * - PC (>= sm): hover (group-hover) 또는 isSelected 시 보임.
 *
 * 사용처: Sidebar (프로젝트·페이지·모듈·채팅), CronPanel (잡 카드) 등 모든 행 hover 액션.
 * 부모 컨테이너에 `group` 클래스 필요 (Tailwind group-hover 동작용).
 *
 * 단일 source — 새 행 컴포넌트 추가 시 이 헬퍼만 호출. CSS 패턴 중복 X.
 */
export const rowActionsClass = (isSelected: boolean): string =>
  `flex items-center gap-0.5 transition-all shrink-0 ${
    isSelected
      ? 'opacity-100'
      : 'opacity-0 pointer-events-none sm:pointer-events-auto sm:group-hover:opacity-100'
  }`;

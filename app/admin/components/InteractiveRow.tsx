'use client';

import { createContext, useContext, type ReactNode, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { rowActionsClass } from '../utils/row-actions';
import { useRowActions } from '../hooks/useRowActions';

// 리스트 단위 활성 행 + 터치 기기 판정 공유 컨텍스트 — 한 번에 한 행만 액션 노출.
type RowCtx = ReturnType<typeof useRowActions>;
const Ctx = createContext<RowCtx | null>(null);

/**
 * 행 리스트를 감싸 안의 InteractiveRow 들이 활성 상태(어느 행의 버튼이 열렸는지)를 공유하게 한다.
 * DOM 추가 없음(프로바이더만). 사용처: 사이드바 패널·트리, 어드민 설정 행 목록 등.
 */
export function RowActions({ children }: { children: ReactNode }) {
  const rows = useRowActions();
  return <Ctx.Provider value={rows}>{children}</Ctx.Provider>;
}

type RowKind = 'expand' | 'enter' | 'switch' | 'none';

/**
 * 사이드바·설정 공통 행 — PC/모바일 인터랙션을 한 곳에 캡슐화(패널별 산발 배선 제거).
 *
 * - **PC(hover 가능)**: 본문 클릭 = 주동작 즉시, 호버 시 액션 버튼 노출, chevron 클릭 = 주동작.
 * - **모바일(hover:none)**: 본문 탭 = 액션 버튼 노출만(주동작 억제), **chevron 탭 = 주동작**.
 *   chevron 이 명시 트리거라 "본문 어디 눌러도 펼침/진입" 버그가 사라진다.
 *
 * kind:
 * - `expand` 아래로 펼침(▼/▶) — 펼침 본문은 부모가 `{expanded && ...}` 로 이 행 뒤에 렌더.
 * - `enter`  상세로 진입(▶) — 모달/하위 화면 열기.
 * - `switch` 메인 전환(대화 목록 등, chevron 없음) — 모바일은 첫 탭=버튼, 재탭=전환.
 * - `none`   주동작 없음 — 버튼만 있는 행.
 *
 * 프로바이더(<RowActions>) 밖에서 쓰면 PC 동작으로 안전 폴백(모바일 버튼 노출 단계만 생략).
 */
export function InteractiveRow({
  id, kind = 'none', expanded, onActivate, actions, children,
  className = '', rowClassName = '',
}: {
  id: string;
  kind?: RowKind;
  expanded?: boolean;
  onActivate?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  rowClassName?: string;
}) {
  const ctx = useContext(Ctx);
  const active = ctx ? ctx.isActive(id) : false;
  const hoverNone = ctx ? ctx.hoverNone : false;
  const setActiveId = ctx ? ctx.setActiveId : () => {};

  const activate = () => {
    if (!hoverNone) {
      onActivate?.(); // PC = 즉시 주동작
      return;
    }
    if (kind === 'switch') {
      // chevron 없는 전환 행 — 첫 탭 버튼 노출, 재탭 주동작.
      if (active) onActivate?.();
      else setActiveId(id);
    } else {
      // expand/enter/none — 본문 탭은 버튼 토글만. 주동작은 chevron 으로.
      setActiveId(active ? null : id);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
  const onChevron = (e: MouseEvent) => {
    e.stopPropagation();
    onActivate?.();
  };

  const showChevron = kind === 'expand' || kind === 'enter';
  const ChevronIcon = kind === 'expand' && expanded ? ChevronDown : ChevronRight;

  return (
    <div className={`group flex items-center gap-1.5 ${rowClassName}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={onKey}
        className={`flex-1 min-w-0 text-left cursor-pointer ${className}`}
      >
        {children}
      </div>
      {actions && <span className={rowActionsClass(active)}>{actions}</span>}
      {showChevron && (
        <button
          type="button"
          onClick={onChevron}
          aria-label={kind === 'expand' ? (expanded ? '접기' : '펼치기') : '열기'}
          className="p-1 text-slate-300 hover:text-slate-600 transition-colors shrink-0"
        >
          <ChevronIcon size={14} />
        </button>
      )}
    </div>
  );
}

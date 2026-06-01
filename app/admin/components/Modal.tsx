'use client';

import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/**
 * 모바일 뷰포트 정확 모달 셸 — 갤러리 이미지 상세(MediaDetailModal)에서 검증된 패턴을 공유 컴포넌트로.
 *
 * 핵심: `createPortal(document.body)` 로 사이드바(슬라이드 드로어가 transform 을 써서 `position:fixed` 의
 * containing block 이 됨)를 벗어나 화면 전체에 렌더한다 → 모바일에서 모달이 사이드바 폭·높이에 갇혀
 * 잘리던 문제를 차단. outer 에 `height:100dvh` (iOS 주소창 변동에도 정확). 모바일은 풀스크린(`flex-1`),
 * PC(`sm:`)는 중앙 카드(`h-[85vh]`).
 *
 * children 은 헤더/푸터를 `shrink-0`, 본문을 `flex-1 min-h-0 overflow-y-auto` 로 구성하면 된다.
 * 노치/홈인디케이터 회피 패딩은 {@link MODAL_PAD_TOP} / {@link MODAL_PAD_BOTTOM} 사용.
 */
export function Modal({
  onClose,
  children,
  widthClass = 'sm:max-w-3xl',
}: {
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-stretch justify-center sm:items-center sm:p-4 bg-slate-900/60 backdrop-blur-sm"
      style={{ height: '100dvh' }}
      onClick={onClose}
    >
      <div
        className={`bg-white w-full ${widthClass} sm:rounded-2xl rounded-t-none shadow-2xl border border-slate-200 overflow-hidden flex flex-col flex-1 sm:flex-none min-h-0 sm:h-[85vh] sm:max-h-[85vh]`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** 헤더 상단 — 노치/상태바 침범 방지 (모바일 풀스크린 시). */
export const MODAL_PAD_TOP: CSSProperties = { paddingTop: 'max(env(safe-area-inset-top), 12px)' };
/** 본문·푸터 하단 — 홈인디케이터/브라우저 툴바 침범 방지. */
export const MODAL_PAD_BOTTOM: CSSProperties = { paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' };

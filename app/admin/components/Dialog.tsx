'use client';

/**
 * Dialog — 브라우저 confirm()/alert() 대체용 Promise 기반 모달.
 *
 * 디자인 일관성:
 *  - SettingsModal 의 backdrop·rounded·border 패턴 계승 (bg-slate-900/40 backdrop-blur-sm).
 *  - Tooltip 처럼 portal 로 body 에 렌더 — 부모 stacking context 무관.
 *  - danger 모드: 빨강 헤더 + 빨강 OK 버튼 (삭제·폐기 액션).
 *  - 키보드: Esc = 취소, Enter = 확인 (focus 자동 OK 버튼).
 *  - backdrop 클릭 = 취소.
 *
 * 사용법:
 *   if (!await confirmDialog({ message: '잡 해제할까요?', danger: true })) return;
 *   await alertDialog({ message: '저장 실패', danger: true });
 *
 * Provider 불필요 — createRoot 로 동적 mount/unmount. callsite 변경 최소.
 */
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, Info } from 'lucide-react';

interface DialogOptions {
  /** 본문 메시지 (필수). \n 또는 줄바꿈 자동 처리 */
  message: string;
  /** 헤더 제목 (선택) */
  title?: string;
  /** 빨강 톤 — 삭제·폐기 액션 */
  danger?: boolean;
  /** 확인 버튼 라벨 (기본 '확인') */
  okLabel?: string;
  /** 취소 버튼 라벨 — confirm 모드에서만. alertDialog 는 표시 X */
  cancelLabel?: string;
}

type DialogMode = 'confirm' | 'alert';

function mountDialog(mode: DialogMode, opts: DialogOptions): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (result: boolean) => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(<DialogUI mode={mode} opts={opts} onClose={close} />);
  });
}

/** Promise<boolean> — 확인 클릭 시 true, 취소·Esc·backdrop 시 false */
export function confirmDialog(opts: DialogOptions): Promise<boolean> {
  return mountDialog('confirm', opts);
}

/** Promise<void> — 사용자가 '확인' 누를 때까지 대기 */
export function alertDialog(opts: DialogOptions): Promise<void> {
  return mountDialog('alert', opts).then(() => undefined);
}

function DialogUI({
  mode,
  opts,
  onClose,
}: {
  mode: DialogMode;
  opts: DialogOptions;
  onClose: (result: boolean) => void;
}) {
  const okBtnRef = useRef<HTMLButtonElement>(null);

  // 키보드 — Esc = 취소, Enter = 확인. Enter 가 input focus 시엔 무시.
  useEffect(() => {
    okBtnRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(false);
      } else if (e.key === 'Enter' && !(e.target as HTMLElement)?.matches?.('input,textarea')) {
        e.preventDefault();
        onClose(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const danger = !!opts.danger;
  const showCancel = mode === 'confirm';
  const title = opts.title ?? (danger ? (mode === 'confirm' ? '확인' : '알림') : (mode === 'confirm' ? '확인' : '알림'));
  const Icon = danger ? AlertTriangle : Info;
  const headerCls = danger
    ? 'bg-red-50 text-red-700 border-red-100'
    : 'bg-slate-50 text-slate-700 border-slate-100';
  const okCls = danger
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-blue-600 hover:bg-blue-700';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={() => onClose(false)}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-sm w-full overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* 헤더 */}
        <div className={`px-4 py-3 border-b flex items-center gap-2 ${headerCls}`}>
          <Icon size={16} />
          <h3 className="text-sm font-bold">{title}</h3>
        </div>

        {/* 본문 */}
        <div className="px-4 py-4 text-[13px] text-slate-700 whitespace-pre-line leading-relaxed">
          {opts.message}
        </div>

        {/* 버튼 */}
        <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex justify-end gap-2">
          {showCancel && (
            <button
              onClick={() => onClose(false)}
              className="px-3 py-1.5 text-[13px] font-medium text-slate-600 hover:bg-slate-200 bg-white rounded-lg transition-colors border border-slate-300"
            >
              {opts.cancelLabel ?? '취소'}
            </button>
          )}
          <button
            ref={okBtnRef}
            onClick={() => onClose(true)}
            className={`px-3 py-1.5 text-[13px] font-bold text-white rounded-lg transition-colors shadow-sm ${okCls}`}
          >
            {opts.okLabel ?? '확인'}
          </button>
        </div>
      </div>
    </div>
  );
}

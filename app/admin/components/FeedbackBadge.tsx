'use client';

import { Check, AlertCircle, Loader2 } from 'lucide-react';

/**
 * Transient 상태 피드백 배지 — 저장·복사·공유 등 한 번 동작 후 결과 알림.
 *
 * 사용법 (inline, 부모 옆):
 *   const [state, setState] = useState<'ok' | 'err' | 'loading' | null>(null);
 *   const save = async () => {
 *     setState('loading');
 *     try { await fetch(...); setState('ok'); }
 *     catch { setState('err'); }
 *     setTimeout(() => setState(null), 1500);
 *   };
 *   <button onClick={save}>저장</button>
 *   <FeedbackBadge state={state} />
 *
 * 사용법 (absolute, 버튼 아래 floating — 복사·공유 같은 작은 아이콘 버튼):
 *   <div className="relative inline-flex">
 *     <button>...</button>
 *     <FeedbackBadge state={state} absolute okLabel="복사됨" />
 *   </div>
 *
 * states:
 *   - 'ok'      → 초록 ✓ (기본 라벨: "저장됨")
 *   - 'err'     → 빨강 ⚠ (기본 라벨: "실패")
 *   - 'loading' → 슬레이트 spinner (기본 라벨: "처리 중")
 *   - null      → 숨김
 */
export function FeedbackBadge({
  state,
  okLabel = '저장됨',
  errLabel = '실패',
  loadingLabel = '처리 중',
  absolute = false,
  className = '',
}: {
  state: 'ok' | 'err' | 'loading' | null | undefined;
  okLabel?: string;
  errLabel?: string;
  loadingLabel?: string;
  /** true 면 absolute 위치 (부모 = relative). 작은 아이콘 버튼 옆 floating 용 */
  absolute?: boolean;
  className?: string;
}) {
  if (!state) return null;

  const styles =
    state === 'ok'
      ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
      : state === 'err'
        ? 'text-red-600 bg-red-50 border-red-200'
        : 'text-slate-500 bg-slate-50 border-slate-200';

  const label = state === 'ok' ? okLabel : state === 'err' ? errLabel : loadingLabel;
  const icon =
    state === 'ok'
      ? <Check size={12} />
      : state === 'err'
        ? <AlertCircle size={12} />
        : <Loader2 size={12} className="animate-spin" />;

  const base = 'inline-flex items-center gap-1 text-[11px] font-medium rounded px-1.5 py-0.5 border whitespace-nowrap';
  const positioning = absolute
    ? 'absolute top-full right-0 mt-1 shadow-sm z-10'
    : '';
  const animation = 'animate-in fade-in slide-in-from-left-1 duration-150';

  return (
    <span className={`${base} ${styles} ${positioning} ${animation} ${className}`}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

/** 레거시 alias — 기존 SavedBadge import 호환 */
export const SavedBadge = FeedbackBadge;

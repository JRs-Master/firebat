'use client';

import { Check, AlertCircle } from 'lucide-react';

/**
 * 저장 결과 inline 표시 — 저장 버튼 옆에 잠깐 등장 후 사라짐 (parent 가 timer 로 제어).
 *
 * 사용법:
 *   const [saved, setSaved] = useState<'ok' | 'err' | null>(null);
 *   const save = async () => {
 *     try { await fetch(...); setSaved('ok'); }
 *     catch { setSaved('err'); }
 *     finally { setTimeout(() => setSaved(null), 1500); }
 *   };
 *   <button onClick={save}>저장</button>
 *   <SavedBadge state={saved} />
 *
 * - 'ok' (초록 ✓ "저장됨")
 * - 'err' (빨강 ⚠ "실패")
 * - null (숨김)
 */
export function SavedBadge({
  state,
  okLabel = '저장됨',
  errLabel = '실패',
  className = '',
}: {
  state: 'ok' | 'err' | null | undefined;
  okLabel?: string;
  errLabel?: string;
  className?: string;
}) {
  if (!state) return null;
  const isOk = state === 'ok';
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-bold animate-in fade-in slide-in-from-left-1 duration-150 ${
        isOk ? 'text-emerald-600' : 'text-red-600'
      } ${className}`}
    >
      {isOk ? <Check size={12} /> : <AlertCircle size={12} />}
      <span>{isOk ? okLabel : errLabel}</span>
    </span>
  );
}

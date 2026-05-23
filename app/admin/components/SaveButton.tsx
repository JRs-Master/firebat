'use client';

/**
 * 통일된 저장 버튼 — 4 상태 (idle / saving / saved / error) 의 단일 버튼.
 *
 * Hub 패턴 (버튼 라벨 자체가 상태 따라 바뀜) 을 모든 저장 site 에 일반화.
 * 옛 "버튼 + 인라인 FeedbackBadge" 조합을 저장 용도 한해 폐기.
 *
 * 사용 예:
 *   const [state, setState] = useState<SaveButtonState>('idle');
 *   const save = async () => {
 *     setState('saving');
 *     try { await api(...); setState('saved'); }
 *     catch { setState('error'); }
 *     setTimeout(() => setState('idle'), 2000);
 *   };
 *   <SaveButton state={state} onClick={save} />
 *
 * 너비 고정 (min-w) 으로 라벨 글자 수 바뀌어도 layout shift 0.
 */

import { Save, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslations } from '../../../lib/i18n';

export type SaveButtonState = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveButtonProps {
  state?: SaveButtonState;
  onClick?: () => void | Promise<void>;
  /** 'idle' 상태 라벨 override — "등록"/"추가" 같은 alternate */
  label?: string;
  /** disabled 강제 (state==='saving' 은 자동 disabled) */
  disabled?: boolean;
  /** size 변종 — 'sm' (text-[11px]) / 'md' (text-[13px]). 기본 'sm' */
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
  /** 버튼 type — 폼 안 submit 용은 'submit'. 기본 'button' */
  type?: 'button' | 'submit';
  /** form attribute — 외부 form 과 연결 시 */
  form?: string;
}

export function SaveButton({
  state = 'idle',
  onClick,
  label,
  disabled,
  size = 'sm',
  className = '',
  title,
  type = 'button',
  form,
}: SaveButtonProps) {
  const t = useTranslations();
  const isSaving = state === 'saving';
  const isDisabled = disabled || isSaving;

  const labelText =
    state === 'saving' ? t('common.saving') :
    state === 'saved' ? t('common.saved') :
    state === 'error' ? t('common.save_failed') :
    (label ?? t('common.save'));

  const Icon =
    state === 'saving' ? Loader2 :
    state === 'saved' ? CheckCircle2 :
    state === 'error' ? AlertCircle :
    Save;

  const colorCls =
    state === 'saved' ? 'bg-emerald-600 hover:bg-emerald-700' :
    state === 'error' ? 'bg-red-600 hover:bg-red-700' :
    'bg-blue-600 hover:bg-blue-700';

  const sizeCls = size === 'md'
    ? 'px-3 py-1.5 text-[13px] min-w-[100px] [&_svg]:size-[13px]'
    : 'px-2 py-1 text-[11px] min-w-[78px] [&_svg]:size-[11px]';

  const handleClick = () => {
    if (isDisabled) return;
    if (onClick) void onClick();
  };

  return (
    <button
      type={type}
      form={form}
      onClick={handleClick}
      disabled={isDisabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1 font-bold text-white rounded transition-colors disabled:bg-slate-300 disabled:cursor-not-allowed ${colorCls} ${sizeCls} ${className}`}
    >
      <Icon className={isSaving ? 'animate-spin' : ''} />
      <span>{labelText}</span>
    </button>
  );
}

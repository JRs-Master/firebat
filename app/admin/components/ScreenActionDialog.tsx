'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { apiPost } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';

/**
 * The confirmation in front of a screen action (module config `uiOnly`).
 *
 * These actions are not reachable by a model on any surface, so this dialog is where the
 * authorisation happens — which means it has to carry what an approval card cannot: which
 * strategy, which symbol, how many, and whether a real order leaves the building. A dialog that
 * only says "are you sure?" moves the click without moving the understanding.
 */

export type ScreenActionField = {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  /** Known values offered as a datalist — a suggestion, not a closed set. */
  options?: string[];
};

export type ScreenActionSpec = {
  /** Module the action belongs to (e.g. "autotrade"). */
  module: string;
  action: string;
  title: string;
  /** The facts this decision rests on, one per line. */
  facts: string[];
  /** What actually happens, in one sentence. Shown in the danger colour. */
  consequence: string;
  /** True when real money moves — the dialog says so and the button turns red. */
  real?: boolean;
  /** Arguments already known from the row that was clicked. */
  args: Record<string, unknown>;
  /** Extra input the action needs (a reason, a target strategy). */
  fields?: ScreenActionField[];
  confirmLabel: string;
};

export function ScreenActionDialog({
  spec,
  onClose,
  onDone,
}: {
  spec: ScreenActionSpec;
  onClose: () => void;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const missing = (spec.fields ?? [])
    .filter(f => f.required && !(values[f.name] ?? '').trim())
    .map(f => f.label);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const args: Record<string, unknown> = { ...spec.args };
      for (const f of spec.fields ?? []) {
        const v = (values[f.name] ?? '').trim();
        if (v) args[f.name] = v;
      }
      const res = await apiPost<{ success: boolean; data?: any; error?: string }>(
        '/api/module/ui-action',
        { module: spec.module, action: spec.action, args },
        { category: 'system-module' },
      );
      if (!res.success) {
        setError(res.error || '실행하지 못했습니다.');
        return;
      }
      const placed = res.data?.placed;
      setResult(
        typeof placed === 'number' && placed > 0
          ? `주문 ${placed}건을 냈습니다. 체결은 정산이 확정합니다.`
          : '반영했습니다.',
      );
      onDone();
    } catch (e) {
      logger.debug('system-module', '화면 액션 실패', { error: e });
      setError(e instanceof Error ? e.message : '실행하지 못했습니다.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            size={16}
            className={`mt-0.5 flex-shrink-0 ${spec.real ? 'text-rose-600' : 'text-amber-500'}`}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-slate-800">{spec.title}</div>
            <ul className="mt-1.5 space-y-0.5 text-[12px] text-slate-600">
              {spec.facts.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
            <p className={`mt-2 text-[12px] font-bold ${spec.real ? 'text-rose-600' : 'text-amber-600'}`}>
              {spec.consequence}
              {spec.real ? ' 실제 주문이 거래소로 나갑니다.' : ''}
            </p>
          </div>
        </div>

        {(spec.fields ?? []).length > 0 && (
          <div className="mt-3 space-y-2">
            {spec.fields!.map(f => (
              <label key={f.name} className="block">
                <span className="text-[11px] font-bold text-slate-500">
                  {f.label}
                  {f.required ? ' *' : ''}
                </span>
                <input
                  value={values[f.name] ?? ''}
                  onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
                  placeholder={f.placeholder}
                  list={f.options?.length ? `sa-${f.name}` : undefined}
                  className="mt-0.5 w-full rounded-md border border-slate-300 px-2 py-1.5 text-[12px] focus:border-blue-500 focus:outline-none"
                />
                {!!f.options?.length && (
                  <datalist id={`sa-${f.name}`}>
                    {f.options.map(o => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                )}
              </label>
            ))}
          </div>
        )}

        {error && (
          <p className="mt-2 rounded-md bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">{error}</p>
        )}
        {result && (
          <p className="mt-2 rounded-md bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-700">
            {result}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-1.5">
          <button
            onClick={onClose}
            className="rounded-md px-2.5 py-1.5 text-[12px] font-bold text-slate-500 hover:bg-slate-100"
          >
            {result ? '닫기' : '취소'}
          </button>
          {!result && (
            <button
              onClick={run}
              disabled={running || missing.length > 0}
              title={missing.length ? `${missing.join(', ')} 을 입력해 주십시오.` : undefined}
              className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50 ${
                spec.real ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {running && <Loader2 size={11} className="animate-spin" />}
              {spec.confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

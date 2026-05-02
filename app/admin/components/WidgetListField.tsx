'use client';

/**
 * WidgetListField — 어드민 widget builder UI.
 *
 * Phase A.2: 사이드바·헤더·푸터 widget 배열 편집. 각 widget item add/remove/reorder/
 * props/visibility 인라인 편집. 영역 (area) 별 catalog 가드.
 *
 * 사용:
 *   <WidgetListField area="sidebar" value={widgets} onChange={setWidgets} />
 */
import { useState } from 'react';
import {
  type WidgetSlot,
  type WidgetType,
  type WidgetArea,
  type WidgetMeta,
  WIDGET_CATALOG,
  widgetsForArea,
  resolveSlotProps,
} from '../../../lib/widget-catalog';

export function WidgetListField({
  label,
  description,
  area,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  area: WidgetArea;
  value: WidgetSlot[] | undefined;
  onChange: (next: WidgetSlot[]) => void;
}) {
  const widgets = Array.isArray(value) ? value : [];
  const available = widgetsForArea(area);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const update = (next: WidgetSlot[]) => {
    onChange(next);
  };

  const add = (type: WidgetType) => {
    const meta = WIDGET_CATALOG[type];
    const newSlot: WidgetSlot = { type };
    if (meta.defaultProps) newSlot.props = { ...meta.defaultProps };
    update([...widgets, newSlot]);
    setExpandedIdx(widgets.length); // 새로 추가된 것 자동 펼침
    setAddPickerOpen(false);
  };

  const removeAt = (i: number) => {
    update(widgets.filter((_, idx) => idx !== i));
    if (expandedIdx === i) setExpandedIdx(null);
  };

  const moveUp = (i: number) => {
    if (i <= 0) return;
    const next = [...widgets];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    update(next);
  };

  const moveDown = (i: number) => {
    if (i >= widgets.length - 1) return;
    const next = [...widgets];
    [next[i + 1], next[i]] = [next[i], next[i + 1]];
    update(next);
  };

  const updateSlot = (i: number, patch: Partial<WidgetSlot>) => {
    const next = [...widgets];
    next[i] = { ...next[i], ...patch };
    update(next);
  };

  const updateProp = (i: number, key: string, val: unknown) => {
    const next = [...widgets];
    next[i] = {
      ...next[i],
      props: { ...(next[i].props ?? {}), [key]: val },
    };
    update(next);
  };

  return (
    <>
      <label className="text-xs sm:text-sm font-bold text-slate-700">{label}</label>
      {description && (
        <p className="text-[10px] sm:text-xs text-slate-400 font-medium mb-2">{description}</p>
      )}

      {widgets.length === 0 ? (
        <div className="text-center py-6 border border-dashed border-slate-300 rounded-lg text-xs text-slate-400">
          등록된 위젯 없음. 아래 버튼으로 추가
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {widgets.map((slot, i) => {
            const meta = WIDGET_CATALOG[slot.type];
            const isExpanded = expandedIdx === i;
            return (
              <div
                key={i}
                className="border border-slate-200 rounded-lg bg-white overflow-hidden"
              >
                {/* Header — 항상 표시 */}
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => setExpandedIdx(isExpanded ? null : i)}
                    className="flex-1 flex items-center gap-2 text-left hover:opacity-70 cursor-pointer bg-transparent border-0 p-0"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span className="text-xs font-bold text-slate-700">{meta?.label ?? slot.type}</span>
                    {slot.visibility && slot.visibility !== 'all' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                        {slot.visibility === 'desktop' ? 'PC만' : '모바일만'}
                      </span>
                    )}
                  </button>
                  {/* 순서 */}
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    disabled={i === 0}
                    title="위로"
                    aria-label="위로"
                    className="p-1 hover:bg-slate-100 rounded disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDown(i)}
                    disabled={i === widgets.length - 1}
                    title="아래로"
                    aria-label="아래로"
                    className="p-1 hover:bg-slate-100 rounded disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-0 cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                  {/* 삭제 */}
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    title="삭제"
                    aria-label="삭제"
                    className="p-1 hover:bg-red-50 rounded text-red-600 bg-transparent border-0 cursor-pointer"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>

                {/* 펼친 영역 — props + visibility 편집 */}
                {isExpanded && (
                  <div className="border-t border-slate-200 px-3 py-2.5 bg-slate-50 flex flex-col gap-2">
                    {meta?.description && (
                      <p className="text-[11px] text-slate-500">{meta.description}</p>
                    )}
                    {/* Visibility */}
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-slate-600 shrink-0">표시 대상:</span>
                      <select
                        value={slot.visibility ?? 'all'}
                        onChange={(e) => updateSlot(i, { visibility: e.target.value as WidgetSlot['visibility'] })}
                        className="text-[11px] px-2 py-1 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="all">PC + 모바일</option>
                        <option value="desktop">PC 만 (sm 이상)</option>
                        <option value="mobile">모바일 만 (sm 미만)</option>
                      </select>
                    </div>
                    {/* Props 편집 */}
                    {meta?.propsSchema && meta.propsSchema.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {meta.propsSchema.map((p) => {
                          const val = (slot.props ?? {})[p.key];
                          const def = (meta.defaultProps ?? {})[p.key];
                          const eff = val ?? def;
                          if (p.type === 'toggle') {
                            return (
                              <label key={p.key} className="flex items-center justify-between cursor-pointer">
                                <span className="text-[11px] font-bold text-slate-600">{p.label}</span>
                                <button
                                  type="button"
                                  onClick={() => updateProp(i, p.key, !eff)}
                                  className={`relative w-9 h-5 rounded-full transition-colors ${eff ? 'bg-blue-500' : 'bg-slate-300'}`}
                                  aria-pressed={!!eff}
                                >
                                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${eff ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                              </label>
                            );
                          }
                          return (
                            <div key={p.key} className="flex flex-col gap-1">
                              <label className="text-[11px] font-bold text-slate-600">{p.label}</label>
                              {p.type === 'textarea' ? (
                                <textarea
                                  value={typeof eff === 'string' ? eff : ''}
                                  onChange={(e) => updateProp(i, p.key, e.target.value)}
                                  placeholder={p.placeholder}
                                  rows={3}
                                  className="text-[11px] px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                />
                              ) : (
                                <input
                                  type={p.type === 'number' ? 'number' : 'text'}
                                  value={eff == null ? '' : String(eff)}
                                  onChange={(e) => updateProp(i, p.key, p.type === 'number' ? Number(e.target.value) : e.target.value)}
                                  placeholder={p.placeholder}
                                  className="text-[11px] px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                              )}
                              {p.description && (
                                <p className="text-[10px] text-slate-400">{p.description}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-400 italic">편집 가능한 속성 없음</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* + 위젯 추가 */}
      <div className="relative mt-2">
        <button
          type="button"
          onClick={() => setAddPickerOpen(!addPickerOpen)}
          className="w-full px-3 py-2 text-xs font-bold border-2 border-dashed border-slate-300 hover:border-blue-500 hover:text-blue-600 rounded-lg text-slate-600 transition-colors bg-white cursor-pointer"
        >
          + 위젯 추가
        </button>
        {addPickerOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setAddPickerOpen(false)}
              aria-hidden="true"
            />
            <div className="absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-y-auto bg-white border border-slate-300 rounded-lg shadow-lg">
              {available.map((w: WidgetMeta) => (
                <button
                  key={w.type}
                  type="button"
                  onClick={() => add(w.type)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b last:border-b-0 border-slate-100 cursor-pointer bg-white"
                >
                  <div className="text-xs font-bold text-slate-700">{w.label}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{w.description}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

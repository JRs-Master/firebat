'use client';

/**
 * CalendarPanel — sysmod_calendar 어드민 UI.
 *
 * 사이드바 일정 탭. 월(month) 단위 달력 그리드 + 선택 날짜 events 리스트.
 * 상단: ◀ 2026년 5월 ▶ (year/month dropdown 클릭 변경) + 오늘로 + 추가.
 * 그리드: 일~토 7×6, 오늘 강조, events 있는 날 점 표시 + 개수.
 * 셀 클릭 → 하단에 그 날짜 events list. 데이터 fetch 는 1년치 한 번.
 *
 * 데이터: data/calendar/events.jsonl (sysmod_calendar 모듈). cron 잡 linkedJobId 양방향.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Plus, Trash2, X, MapPin, Link as LinkIcon, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';

interface CalEvent {
  id: string;
  title: string;
  startAt: string;
  endAt?: string;
  location?: string;
  description?: string;
  tags?: string[];
  linkedJobId?: string;
}

async function callCalendar(action: string, data: Record<string, unknown>): Promise<any> {
  const res = await fetch('/api/module/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ module: 'calendar', data: { action, ...data } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'sysmod_calendar 실패');
  return json.data;
}

const MONTH_NAMES = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];
const WEEKDAY_HEADERS = ['일', '월', '화', '수', '목', '금', '토'];

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function CalendarPanel() {
  const today = useMemo(() => new Date(), []);
  const [cursorYear, setCursorYear] = useState(today.getFullYear());
  const [cursorMonth, setCursorMonth] = useState(today.getMonth()); // 0-indexed
  const [selectedDate, setSelectedDate] = useState<string>(ymd(today)); // 'YYYY-MM-DD'
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // events fetch — 1년치 (cursor 기준 ±6개월). cursor 변경 시 재호출.
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      // sysmod_calendar.list-upcoming 은 days=N 만 지원.
      // 한 번에 1년치 + 과거 30일 fetch. 실 조회량 적어 부담 없음.
      const result = await callCalendar('list-upcoming', { days: 400, includePast: 30, limit: 1000 });
      setEvents((result?.items ?? []) as CalEvent[]);
    } catch (err: any) {
      console.error('[CalendarPanel] fetch fail', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // bucket: 'YYYY-MM-DD' → events[]
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      const d = new Date(e.startAt);
      if (isNaN(d.getTime())) continue;
      const key = ymd(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    // 같은 날 안 시간순 정렬
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
    }
    return map;
  }, [events]);

  // 그리드 셀 — 6주 × 7일 = 42 cells
  const gridCells = useMemo(() => {
    const firstOfMonth = new Date(cursorYear, cursorMonth, 1);
    const startOffset = firstOfMonth.getDay(); // 0=일
    const start = new Date(cursorYear, cursorMonth, 1 - startOffset);
    const cells: { date: Date; inMonth: boolean; key: string }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      cells.push({
        date: d,
        inMonth: d.getMonth() === cursorMonth,
        key: ymd(d),
      });
    }
    return cells;
  }, [cursorYear, cursorMonth]);

  const todayKey = ymd(today);
  const selectedEvents = eventsByDate.get(selectedDate) ?? [];

  const goPrevMonth = () => {
    if (cursorMonth === 0) {
      setCursorYear(cursorYear - 1);
      setCursorMonth(11);
    } else setCursorMonth(cursorMonth - 1);
  };
  const goNextMonth = () => {
    if (cursorMonth === 11) {
      setCursorYear(cursorYear + 1);
      setCursorMonth(0);
    } else setCursorMonth(cursorMonth + 1);
  };
  const goToday = () => {
    setCursorYear(today.getFullYear());
    setCursorMonth(today.getMonth());
    setSelectedDate(todayKey);
  };

  // year/month picker 외부 클릭 닫기
  useEffect(() => {
    if (!showYearPicker && !showMonthPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowYearPicker(false);
        setShowMonthPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showYearPicker, showMonthPicker]);

  const handleDelete = async (e: CalEvent) => {
    const ok = await confirmDialog({
      title: '일정 삭제',
      message: `"${e.title}" 일정을 삭제합니다.${e.linkedJobId ? '\n(연동된 cron 잡 ' + e.linkedJobId + ' 은 별도)' : ''}`,
      okLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    try {
      await callCalendar('delete', { id: e.id });
      setEvents(prev => prev.filter(x => x.id !== e.id));
    } catch (err: any) {
      alert(`삭제 실패: ${err.message}`);
    }
  };

  // year picker — 현재 년 ±10
  const yearOptions = useMemo(() => {
    const arr: number[] = [];
    for (let y = today.getFullYear() - 5; y <= today.getFullYear() + 10; y++) arr.push(y);
    return arr;
  }, [today]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 상단 네비 — 월 이동 / year·month picker / 오늘 / 추가 */}
      <div className="px-2 py-2 border-b border-slate-200/80 flex items-center gap-1 relative" ref={pickerRef}>
        <Tooltip label="이전 달">
          <button onClick={goPrevMonth} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-md">
            <ChevronLeft size={13} />
          </button>
        </Tooltip>
        <div className="flex-1 flex items-center justify-center gap-0.5 text-[12px] font-bold text-slate-700 tabular-nums">
          <button
            onClick={() => { setShowYearPicker(v => !v); setShowMonthPicker(false); }}
            className="px-1.5 py-0.5 hover:bg-slate-100 rounded inline-flex items-center gap-0.5"
          >
            {cursorYear}년 <ChevronDown size={10} className="text-slate-400" />
          </button>
          <button
            onClick={() => { setShowMonthPicker(v => !v); setShowYearPicker(false); }}
            className="px-1.5 py-0.5 hover:bg-slate-100 rounded inline-flex items-center gap-0.5"
          >
            {MONTH_NAMES[cursorMonth]} <ChevronDown size={10} className="text-slate-400" />
          </button>
        </div>
        <Tooltip label="다음 달">
          <button onClick={goNextMonth} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-md">
            <ChevronRight size={13} />
          </button>
        </Tooltip>
        <Tooltip label="오늘">
          <button
            onClick={goToday}
            className="px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100 rounded-md border border-slate-200"
          >
            오늘
          </button>
        </Tooltip>
        <Tooltip label="일정 추가">
          <button
            onClick={() => { setEditing(null); setShowCreate(true); }}
            className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-md"
          >
            <Plus size={13} />
          </button>
        </Tooltip>

        {/* year dropdown */}
        {showYearPicker && (
          <div className="absolute top-full left-12 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
            {yearOptions.map(y => (
              <button
                key={y}
                onClick={() => { setCursorYear(y); setShowYearPicker(false); }}
                className={`block w-full text-left px-3 py-1 text-[11px] tabular-nums hover:bg-slate-100 ${y === cursorYear ? 'bg-blue-50 text-blue-600 font-bold' : 'text-slate-700'}`}
              >
                {y}년
              </button>
            ))}
          </div>
        )}
        {/* month dropdown */}
        {showMonthPicker && (
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg grid grid-cols-3 p-1 w-44">
            {MONTH_NAMES.map((name, i) => (
              <button
                key={i}
                onClick={() => { setCursorMonth(i); setShowMonthPicker(false); }}
                className={`px-2 py-1.5 text-[11px] rounded hover:bg-slate-100 ${i === cursorMonth ? 'bg-blue-50 text-blue-600 font-bold' : 'text-slate-700'}`}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 px-1 py-1 border-b border-slate-100 bg-slate-50/60">
        {WEEKDAY_HEADERS.map((w, i) => (
          <div
            key={w}
            className={`text-center text-[10px] font-bold ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-slate-500'}`}
          >
            {w}
          </div>
        ))}
      </div>

      {/* month grid */}
      <div className="grid grid-cols-7 gap-px bg-slate-100 border-b border-slate-100">
        {gridCells.map(cell => {
          const dayEvents = eventsByDate.get(cell.key) ?? [];
          const isToday = cell.key === todayKey;
          const isSelected = cell.key === selectedDate;
          const dow = cell.date.getDay();
          return (
            <button
              key={cell.key}
              onClick={() => setSelectedDate(cell.key)}
              className={`
                relative aspect-square flex flex-col items-center justify-start py-1 px-0.5 text-[10px]
                transition-colors min-h-[40px]
                ${isSelected ? 'bg-blue-500 text-white font-bold' : isToday ? 'bg-amber-50 text-amber-700' : 'bg-white hover:bg-slate-50'}
                ${!cell.inMonth && !isSelected ? 'text-slate-300' : ''}
                ${cell.inMonth && !isSelected && !isToday && dow === 0 ? 'text-red-500' : ''}
                ${cell.inMonth && !isSelected && !isToday && dow === 6 ? 'text-blue-500' : ''}
                ${cell.inMonth && !isSelected && !isToday && dow > 0 && dow < 6 ? 'text-slate-700' : ''}
              `}
            >
              <span className="tabular-nums">{cell.date.getDate()}</span>
              {dayEvents.length > 0 && (
                <span className="flex items-center gap-0.5 mt-0.5">
                  {dayEvents.length <= 3 ? (
                    dayEvents.slice(0, 3).map((_, i) => (
                      <span
                        key={i}
                        className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-blue-500'}`}
                      />
                    ))
                  ) : (
                    <span className={`text-[8px] font-bold tabular-nums ${isSelected ? 'text-white' : 'text-blue-500'}`}>
                      {dayEvents.length}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 선택 날짜 events list */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="px-2 py-1.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <span className="text-[11px] font-bold text-slate-700 tabular-nums">
            {selectedDate.replace(/-/g, '. ')} ({selectedEvents.length})
          </span>
          {loading && <span className="text-[10px] text-slate-400">로드 중...</span>}
        </div>
        {selectedEvents.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400 italic">
            {loading ? '' : '이 날짜에 일정 없음'}
          </p>
        ) : (
          <ul className="list-none p-0 m-0">
            {selectedEvents.map(e => (
              <li key={e.id} className="border-b border-slate-100 px-2 py-1.5 hover:bg-slate-50">
                <div className="flex items-start gap-1.5">
                  <span className="mt-0.5 shrink-0 text-[10px] font-bold text-blue-600 tabular-nums">{formatTime(e.startAt)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-slate-700 truncate">{e.title}</div>
                    {e.endAt && (
                      <div className="text-[10px] text-slate-500 tabular-nums">~ {formatTime(e.endAt)}</div>
                    )}
                    {e.location && (
                      <div className="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1">
                        <MapPin size={9} /> {e.location}
                      </div>
                    )}
                    {e.description && (
                      <div className="text-[10px] text-slate-600 mt-0.5 line-clamp-2 whitespace-pre-wrap break-words">{e.description}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-1 mt-0.5">
                      {(e.tags ?? []).slice(0, 4).map((t, i) => (
                        <span key={i} className="text-[9px] px-1 rounded bg-slate-100 text-slate-500">#{t}</span>
                      ))}
                      {e.linkedJobId && (
                        <Tooltip label={`Cron 잡: ${e.linkedJobId}`}>
                          <span className="text-[9px] px-1 rounded bg-purple-50 text-purple-600 inline-flex items-center gap-0.5">
                            <LinkIcon size={8} /> cron
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <Tooltip label="편집">
                    <button
                      onClick={() => { setEditing(e); setShowCreate(true); }}
                      className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  </Tooltip>
                  <Tooltip label="삭제">
                    <button
                      onClick={() => handleDelete(e)}
                      className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 size={10} />
                    </button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showCreate && (
        <CalendarModal
          existing={editing}
          defaultDate={selectedDate}
          onClose={() => { setShowCreate(false); setEditing(null); }}
          onSaved={() => {
            setShowCreate(false);
            setEditing(null);
            fetchEvents();
          }}
        />
      )}
    </div>
  );
}

function toLocalInputValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

function defaultStartAt(dateKey: string): string {
  // 'YYYY-MM-DD' + T09:00 (오전 9시 디폴트)
  return `${dateKey}T09:00`;
}

function CalendarModal({ existing, defaultDate, onClose, onSaved }: { existing: CalEvent | null; defaultDate?: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [startAt, setStartAt] = useState(
    existing ? toLocalInputValue(existing.startAt) : (defaultDate ? defaultStartAt(defaultDate) : '')
  );
  const [endAt, setEndAt] = useState(toLocalInputValue(existing?.endAt));
  const [location, setLocation] = useState(existing?.location ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [tagsRaw, setTagsRaw] = useState((existing?.tags ?? []).join(', '));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!title.trim()) { setError('제목 필수'); return; }
    if (!startAt) { setError('시작 시각 필수'); return; }
    setError('');
    setSubmitting(true);
    try {
      const startIso = fromLocalInputValue(startAt);
      const endIso = endAt ? fromLocalInputValue(endAt) : undefined;
      const tags = tagsRaw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
      const action = existing ? 'update' : 'add';
      const data: Record<string, unknown> = {
        title: title.trim(),
        startAt: startIso,
        ...(endIso ? { endAt: endIso } : {}),
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(description.trim() ? { description } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      };
      if (existing) data.id = existing.id;
      await callCalendar(action, data);
      onSaved();
    } catch (err: any) {
      setError(err.message || '저장 실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-800">{existing ? '일정 편집' : '일정 추가'}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded"><X size={14} /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">제목</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="일정 제목" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">시작</label>
              <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">종료 (선택)</label>
              <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">장소 (선택)</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="예: 강남, Zoom 링크" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">설명 (선택)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="상세 메모" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">태그 (콤마 분리)</label>
            <input type="text" value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} placeholder="공모주, 매매, 미팅" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <button onClick={onClose} className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded">취소</button>
          <button onClick={submit} disabled={submitting} className="px-3 py-1 text-xs font-bold bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-40">
            {existing ? '저장' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}

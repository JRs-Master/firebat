'use client';

/**
 * CalendarPanel — sysmod_calendar 어드민 UI.
 *
 * 사이드바 일정 탭. list-upcoming/add/update/delete sysmod 호출.
 * 데이터: data/calendar/events.jsonl. cron 잡과 linkedJobId 로 양방향 추적 가능.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, X, Calendar as CalendarIcon, MapPin, Link as LinkIcon } from 'lucide-react';
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

function formatDateTime(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ko-KR', opts ?? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isPast(iso: string): boolean {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t < Date.now();
}

export function CalendarPanel() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [days, setDays] = useState(14);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<CalEvent | null>(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callCalendar('list-upcoming', { days, limit: 100 });
      setEvents((result?.items ?? []) as CalEvent[]);
    } catch (err: any) {
      console.error('[CalendarPanel] fetch fail', err);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-2 py-2 border-b border-slate-200/80 flex items-center gap-1">
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="flex-1 text-[11px] px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value={7}>다가오는 7일</option>
          <option value={14}>다가오는 14일</option>
          <option value={30}>다가오는 30일</option>
          <option value={90}>다가오는 90일</option>
        </select>
        <Tooltip label="일정 추가">
          <button
            onClick={() => { setEditing(null); setShowCreate(true); }}
            className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-md"
          >
            <Plus size={13} />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400">로드 중...</p>
        ) : events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400 italic">일정 없음. + 버튼으로 추가</p>
        ) : (
          <ul className="list-none p-0 m-0">
            {events.map(e => {
              const past = isPast(e.startAt);
              return (
                <li key={e.id} className={`border-b border-slate-100 px-2 py-1.5 hover:bg-slate-50 ${past ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-1.5">
                    <CalendarIcon size={11} className={`mt-0.5 shrink-0 ${past ? 'text-slate-400' : 'text-blue-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-bold text-slate-700 truncate">{e.title}</div>
                      <div className="text-[10px] text-slate-500 tabular-nums">
                        {formatDateTime(e.startAt)}
                        {e.endAt && ` ~ ${formatDateTime(e.endAt, { hour: '2-digit', minute: '2-digit' })}`}
                      </div>
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
              );
            })}
          </ul>
        )}
      </div>

      {showCreate && (
        <CalendarModal
          existing={editing}
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
  // datetime-local 입력은 Y-M-D T H:M (로컬 timezone)
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

function CalendarModal({ existing, onClose, onSaved }: { existing: CalEvent | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [startAt, setStartAt] = useState(toLocalInputValue(existing?.startAt));
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

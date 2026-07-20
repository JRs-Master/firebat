'use client';

/**
 * CalendarPanel — sysmod_calendar 어드민 UI.
 *
 * 사이드바 캘린더 탭. 월(month) 단위 달력 그리드 + 선택 날짜 events 리스트.
 * 상단: ◀ 2026년 5월 ▶ (year/month dropdown 클릭 변경) + 오늘로 + 추가.
 * 그리드: 일~토 7×6, 오늘 강조, events 있는 날 점 표시 + 개수.
 * 셀 클릭 → 하단에 그 날짜 events list. 데이터 fetch 는 1년치 한 번.
 *
 * 데이터: data/calendar/events.jsonl (sysmod_calendar 모듈). cron 잡 linkedJobId 양방향.
 */
import { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { Plus, Trash2, X, MapPin, Link as LinkIcon, ChevronLeft, ChevronRight, ChevronDown, Clock, CheckCircle2, XCircle, Pencil, Play, Loader2 } from 'lucide-react';
import { useTranslations } from '../../../lib/i18n';
import { Tooltip } from './Tooltip';
import { RowActions, InteractiveRow } from './InteractiveRow';
import { confirmDialog, alertDialog } from './Dialog';
import { apiGet, apiPost, apiDelete } from '../../../lib/api-fetch';
import { logger } from '../../../lib/util/logger';
import { SaveButton, type SaveButtonState } from './SaveButton';
import { ScheduleModal, type CronJob } from './CronPanel';
import { useEvents } from '../hooks/events-manager';
import { useRunningCronJobs } from '../hooks/active-jobs';

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

/** cron 잡의 캘린더 투영 — 예약 발화 시각(occursAt) 1건. cron 이 진실원천, 캘린더는 read-only 표시. */
interface CronOcc {
  jobId: string;
  title?: string;
  targetPath: string;
  occursAt: string;
  mode: string;
}
/** cron 실행 이력 1건 — 완료/실패 표시용. */
interface CronLog {
  jobId: string;
  title?: string;
  triggeredAt: string;
  success: boolean;
  error?: string;
}

export type CalendarHubContext = { slug: string; apiToken: string; sessionId: string };

async function callCalendar(
  action: string,
  data: Record<string, unknown>,
  hubContext?: CalendarHubContext,
): Promise<any> {
  if (hubContext) {
    const res = await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/sysmod`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Token': hubContext.apiToken,
        'X-Session-Id': hubContext.sessionId,
      },
      body: JSON.stringify({ module: 'calendar', action, data }),
    });
    const json = await res.json().catch(() => null);
    if (!json?.success) throw new Error(json?.error || 'sysmod_calendar 실패');
    return json.data;
  }
  const json = await apiPost<{ success: boolean; data?: unknown; error?: string }>(
    '/api/module/run',
    { module: 'calendar', data: { action, ...data } },
    { category: 'calendar' },
  );
  if (!json.success) throw new Error(json.error || 'sysmod_calendar 실패');
  return json.data;
}

// cron 실행 기록 태그 — main.rs 콜백이 매 cron 발화 후 sysmod_calendar add({tags:['실행기록', '완료'|'실패']}).
// 이 태그 이벤트 = 영속 실행 이력(cron 로그 버퍼·잡 삭제와 무관). 일정과 분리해 스케줄 섹션에 표시.
const EXEC_TAG = '실행기록';
const isExecRecord = (e: CalEvent) => (e.tags ?? []).includes(EXEC_TAG);

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

export function CalendarPanel({
  hubMode,
  hubContext,
}: {
  hubMode?: boolean;
  hubContext?: CalendarHubContext;
} = {}) {
  const t = useTranslations();
  const today = useMemo(() => new Date(), []);
  const [cursorYear, setCursorYear] = useState(today.getFullYear());
  const [cursorMonth, setCursorMonth] = useState(today.getMonth()); // 0-indexed
  const [selectedDate, setSelectedDate] = useState<string>(ymd(today)); // 'YYYY-MM-DD'
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [cronOccs, setCronOccs] = useState<CronOcc[]>([]);
  // 캘린더의 cron 예정도 실행 중이면 표시 — 워크스페이스와 동일 전역 status(meta.jobId) 소스.
  const isCronRunning = useRunningCronJobs();
  // cron 실행 이력은 더 이상 휘발 로그(/api/cron logs)가 아니라 캘린더 영속 이벤트('실행기록' 태그)에서 읽음 (execByDate).
  const [editingCron, setEditingCron] = useState<CronJob | null>(null); // 캘린더에서 cron 스케줄 편집 (ScheduleModal 재사용)
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<CalEvent | null>(null);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // events fetch — 과거 30일 ~ 미래 400일 범위. cursor 변경 시 재호출.
  // sysmod_calendar.list-range 는 fromTm / toTm 임의 범위 지원 (list-upcoming 의 미래
  // 전용 limitation 우회). 실 조회량 적어 한 번에 fetch 부담 없음.
  const fetchEvents = useCallback(async () => {
    // hub mode 면 익명 hub sysmod endpoint 통해 호출 — sysmod 가 _hubScope 받아 자기 데이터 디렉토리 사용.
    if (hubMode && !hubContext) { setEvents([]); setLoading(false); return; }
    setLoading(true);
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const to = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000);
      const result = await callCalendar('list-range', {
        fromTm: ymd(from),
        toTm: ymd(to),
        limit: 1000,
      }, hubContext);
      setEvents((result?.items ?? []) as CalEvent[]);
    } catch (err) {
      logger.error('calendar', 'fetch 실패', err);
    } finally {
      setLoading(false);
    }
  }, [hubMode, hubContext]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // AI 채팅이 도구로 일정을 저장하면 useChat 이 'firebat-refresh' 를 쏜다 → 사이드바 자동 재조회.
  // (저장은 됐는데 수동 새로고침 전까지 달력에 안 뜨던 문제 차단.)
  useEffect(() => {
    const onRefresh = () => fetchEvents();
    window.addEventListener('firebat-refresh', onRefresh);
    return () => window.removeEventListener('firebat-refresh', onRefresh);
  }, [fetchEvents]);

  // cron 잡 투영 — admin 전용 (cron 은 owner-scoped, hub 방문자엔 미노출). /api/cron 이 from/to 구간
  // occurrences + 실행 로그 반환. cron 이 진실원천이라 캘린더는 비추기만 (중복 저장 0).
  const fetchCron = useCallback(async () => {
    if (hubMode) { setCronOccs([]); return; }
    try {
      const now = new Date();
      const from = ymd(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
      const to = ymd(new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000));
      const res = await apiGet<{ occurrences?: CronOcc[]; logs?: CronLog[] }>(
        `/api/cron?from=${from}&to=${to}`,
        { category: 'calendar' },
      );
      setCronOccs(res.occurrences ?? []);
    } catch (err) {
      logger.debug('calendar', 'cron 투영 fetch 실패', { error: err });
    }
  }, [hubMode]);

  useEffect(() => {
    fetchCron();
    // 스케줄 등록/변경 시 'firebat-refresh' → cron 투영도 재조회 (mount 외에도 갱신해 stale 차단 —
    // 스케줄 등록했는데 캘린더에 안 뜨던 것 fix).
    const onRefresh = () => fetchCron();
    window.addEventListener('firebat-refresh', onRefresh);
    return () => window.removeEventListener('firebat-refresh', onRefresh);
  }, [fetchCron]);

  // cron 실행(StatusManager status:update) 시 cron 투영(예정·실행이력) 자동 갱신 — 스케줄이 실제
  // 발화하면 캘린더가 열려 있을 때 실시간 반영. admin 전용 (fetchCron 이 hubMode 면 no-op).
  useEvents(['status:update'], () => { void fetchCron(); });

  // bucket: 'YYYY-MM-DD' → events[]
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      if (isExecRecord(e)) continue; // 실행기록은 일정과 분리(execByDate) — 스케줄 섹션에만 표시.
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

  // cron 실행 이력 = '실행기록' 태그 캘린더 이벤트(영속). 날짜 버킷, 최신순.
  const execByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      if (!isExecRecord(e)) continue;
      const d = new Date(e.startAt);
      if (isNaN(d.getTime())) continue;
      const key = ymd(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
    }
    return map;
  }, [events]);

  // cron 발화 시각 → 날짜 버킷 (예약 표시).
  const cronByDate = useMemo(() => {
    const map = new Map<string, CronOcc[]>();
    for (const o of cronOccs) {
      const d = new Date(o.occursAt);
      if (isNaN(d.getTime())) continue;
      const key = ymd(d);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.occursAt).getTime() - new Date(b.occursAt).getTime());
    }
    return map;
  }, [cronOccs]);

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
  const selectedOccs = cronByDate.get(selectedDate) ?? [];
  const selectedExec = execByDate.get(selectedDate) ?? [];

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

  // cron 스케줄 즉시 1회 실행 — /api/cron?action=run (CronPanel handleRunNow 와 동일). 실행 후 refetch 로 로그 갱신.
  const runCronNow = async (jobId: string, title?: string) => {
    if (!await confirmDialog({ title: '즉시 실행', message: `"${title || jobId}" 스케줄을 지금 1회 실행합니다.`, okLabel: '실행' })) return;
    try {
      await apiPost(`/api/cron?action=run&jobId=${encodeURIComponent(jobId)}`, {}, { category: 'calendar' });
      await fetchCron();
    } catch (err: any) {
      await alertDialog({ title: '실행 실패', message: err?.message ?? String(err), danger: true });
    }
  };

  // cron 스케줄(투영) 삭제 — cron 이 진실원천이라 /api/cron 잡 해제 호출, 캘린더는 투영만 → refetch.
  const deleteCronJob = async (jobId: string, title?: string): Promise<boolean> => {
    if (!await confirmDialog({ title: '스케줄 삭제', message: `"${title || jobId}" 스케줄(cron 잡)을 삭제합니다.`, okLabel: '삭제', cancelLabel: '취소', danger: true })) return false;
    try {
      await apiDelete(`/api/cron?jobId=${encodeURIComponent(jobId)}`, { category: 'calendar' });
      await fetchCron();
      return true;
    } catch (err: any) {
      await alertDialog({ title: '삭제 실패', message: err?.message ?? String(err), danger: true });
      return false;
    }
  };

  // cron 스케줄 편집 — jobId 로 전체 CronJob 조회 후 ScheduleModal(CronPanel 재사용) 오픈.
  const handleEditCron = async (jobId: string) => {
    try {
      const res = await apiGet<{ jobs?: CronJob[] }>('/api/cron', { category: 'calendar' });
      const job = (res.jobs ?? []).find(j => j.jobId === jobId);
      if (!job) { await alertDialog({ title: '편집 불가', message: '해당 스케줄을 찾지 못했습니다 (이미 종료/삭제됨).' }); await fetchCron(); return; }
      setEditingCron(job);
    } catch (err: any) {
      await alertDialog({ title: '오류', message: err?.message ?? String(err), danger: true });
    }
  };

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
      await callCalendar('delete', { id: e.id }, hubContext);
      setEvents(prev => prev.filter(x => x.id !== e.id));
    } catch (err: any) {
      await alertDialog({ title: '삭제 실패', message: err?.message ?? String(err), danger: true });
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
        <Tooltip label={t('calendar.previous_month')}>
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
        <Tooltip label={t('calendar.next_month')}>
          <button onClick={goNextMonth} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-md">
            <ChevronRight size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t('common.today')}>
          <button
            onClick={goToday}
            className="px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-100 rounded-md border border-slate-200"
          >
            오늘
          </button>
        </Tooltip>
        <Tooltip label={t('calendar.add_event')}>
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
                        className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-violet-500'}`}
                      />
                    ))
                  ) : (
                    <span className={`text-[8px] font-bold tabular-nums ${isSelected ? 'text-white' : 'text-violet-500'}`}>
                      {dayEvents.length}
                    </span>
                  )}
                </span>
              )}
              {/* cron 투영 마커 — 예약(파랑=스케줄색) / 완료(초록) / 실패(빨강). 일정 점(보라=캘린더색)과 별도 줄. */}
              {(cronByDate.get(cell.key)?.length || execByDate.get(cell.key)?.length) ? (
                <span className="flex items-center gap-0.5 mt-0.5">
                  {cronByDate.get(cell.key)?.length ? (
                    <span className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-blue-500'}`} />
                  ) : null}
                  {execByDate.get(cell.key)?.some(e => (e.tags ?? []).includes('실패')) ? (
                    <span className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-red-500'}`} />
                  ) : execByDate.get(cell.key)?.length ? (
                    <span className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-green-500'}`} />
                  ) : null}
                </span>
              ) : null}
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
          <RowActions>
          <ul className="list-none p-0 m-0">
            {selectedEvents.map(e => (
              <li key={e.id} className="border-b border-slate-100">
                <InteractiveRow
                  id={e.id}
                  kind="none"
                  rowClassName="px-2 py-1.5 hover:bg-slate-50"
                  className="flex items-start gap-1.5"
                  actions={
                    <>
                      <Tooltip label={t('common.edit')}>
                        <button
                          onClick={() => { setEditing(e); setShowCreate(true); }}
                          className="p-1 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                      </Tooltip>
                      <Tooltip label={t('common.delete')}>
                        <button
                          onClick={() => handleDelete(e)}
                          className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                        >
                          <Trash2 size={10} />
                        </button>
                      </Tooltip>
                    </>
                  }
                >
                  <span className="mt-0.5 shrink-0 text-[10px] font-bold text-violet-600 tabular-nums">{formatTime(e.startAt)}</span>
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
                      {(e.tags ?? []).slice(0, 4).map((tag, i) => (
                        <span key={i} className="text-[9px] px-1 rounded bg-slate-100 text-slate-500">#{tag}</span>
                      ))}
                      {e.linkedJobId && (
                        <Tooltip label={t('calendar.cron_linked', { jobId: e.linkedJobId })}>
                          <span className="text-[9px] px-1 rounded bg-purple-50 text-purple-600 inline-flex items-center gap-0.5">
                            <LinkIcon size={8} /> cron
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </InteractiveRow>
              </li>
            ))}
          </ul>
          </RowActions>
        )}

        {/* 스케줄(cron) 투영 — 선택 날짜의 예약 발화 + 실행 이력. cron 이 진실원천, 캘린더는 read-only 표시. */}
        {(selectedOccs.length > 0 || selectedExec.length > 0) && (
          <div className="border-t border-blue-100">
            <div className="px-2 py-1.5 bg-blue-50/60 text-[11px] font-bold text-blue-700 flex items-center gap-1">
              <Clock size={11} /> 스케줄 ({selectedOccs.length + selectedExec.length})
            </div>
            <RowActions>
            <ul className="list-none p-0 m-0">
              {selectedOccs.map((o, i) => (
                <li key={`occ-${i}`} className="border-b border-slate-100">
                  <InteractiveRow
                    id={`occ-${o.jobId}-${i}`}
                    kind="none"
                    rowClassName="px-2 py-1.5 hover:bg-slate-50"
                    className="flex items-start gap-1.5"
                    actions={
                      <>
                        <Tooltip label="즉시 실행"><button onClick={() => runCronNow(o.jobId, o.title)} className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded"><Play size={11} /></button></Tooltip>
                        <Tooltip label={t('common.edit')}><button onClick={() => handleEditCron(o.jobId)} className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded"><Pencil size={11} /></button></Tooltip>
                        <Tooltip label="스케줄 삭제"><button onClick={() => deleteCronJob(o.jobId, o.title)} className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 size={11} /></button></Tooltip>
                      </>
                    }
                  >
                    <span className="mt-0.5 shrink-0 text-[10px] font-bold text-blue-600 tabular-nums">{formatTime(o.occursAt)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-bold text-slate-700 truncate">{o.title || o.jobId}</div>
                      {isCronRunning(o.jobId)
                        ? <span className="text-[9px] px-1 rounded bg-emerald-50 text-emerald-600 inline-flex items-center gap-0.5"><Loader2 size={9} className="animate-spin" /> 실행 중</span>
                        : <span className="text-[9px] px-1 rounded bg-blue-50 text-blue-600">예정 · {o.mode}</span>}
                    </div>
                  </InteractiveRow>
                </li>
              ))}
              {selectedExec.map((l) => {
                const failed = (l.tags ?? []).includes('실패');
                return (
                <li key={l.id} className="border-b border-slate-100">
                  <InteractiveRow
                    id={l.id}
                    kind="none"
                    rowClassName="px-2 py-1.5 hover:bg-slate-50"
                    className="flex items-start gap-1.5"
                    actions={
                      <Tooltip label={t('common.delete')}>
                        <button onClick={() => handleDelete(l)} className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 size={10} /></button>
                      </Tooltip>
                    }
                  >
                    <span className="mt-0.5 shrink-0">{failed ? <XCircle size={11} className="text-red-600" /> : <CheckCircle2 size={11} className="text-green-600" />}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-slate-700 truncate">{l.title}</div>
                      <div className="text-[10px] text-slate-400 tabular-nums">{formatTime(l.startAt)} · {failed ? '실패' : '완료'}</div>
                      {failed && l.description && <div className="text-[10px] text-red-500 line-clamp-1 break-words">{l.description}</div>}
                    </div>
                  </InteractiveRow>
                </li>
                );
              })}
            </ul>
            </RowActions>
          </div>
        )}
      </div>

      {editingCron && (() => {
        const job = editingCron;
        return (
          <ScheduleModal
            job={job}
            hubContext={hubContext}
            onClose={() => setEditingCron(null)}
            // 저장 = 목록 갱신만 (모달 유지 — 닫기는 명시적으로). CronPanel 과 동일.
            onSaved={() => { void fetchCron(); }}
            onDelete={async () => { if (await deleteCronJob(job.jobId)) setEditingCron(null); }}
          />
        );
      })()}
      {showCreate && (
        <CalendarModal
          existing={editing}
          defaultDate={selectedDate}
          hubContext={hubContext}
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

function CalendarModal({ existing, defaultDate, hubContext, onClose, onSaved }: { existing: CalEvent | null; defaultDate?: string; hubContext?: CalendarHubContext; onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const startAtId = useId();
  const endAtId = useId();
  const locationId = useId();
  const descriptionId = useId();
  const tagsRawId = useId();
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
      await callCalendar(action, data, hubContext);
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
            <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={titleId}>제목</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="일정 제목" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="title" autoComplete="off" id={titleId} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={startAtId}>시작</label>
              <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="startAt" autoComplete="off" id={startAtId} />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={endAtId}>종료 (선택)</label>
              <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="endAt" autoComplete="off" id={endAtId} />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={locationId}>장소 (선택)</label>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="예: 강남, Zoom 링크" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="location" autoComplete="off" id={locationId} />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={descriptionId}>설명 (선택)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="상세 메모" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" name="description" autoComplete="off" id={descriptionId} />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={tagsRawId}>태그 (콤마 분리)</label>
            <input type="text" value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} placeholder="태그 (콤마, 선택)" className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="tagsRaw" autoComplete="off" id={tagsRawId} />
          </div>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <button onClick={onClose} className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded">취소</button>
          <SaveButton
            state={(submitting ? 'saving' : 'idle') as SaveButtonState}
            label={existing ? undefined : '추가'}
            onClick={submit}
          />
        </div>
      </div>
    </div>
  );
}

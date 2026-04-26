'use client';

/**
 * ActiveJobsIndicator — StatusManager 의 SSE 'status:update' 이벤트 구독.
 *
 * 표시:
 *   - 활성 작업 수 (animate-pulse)
 *   - 클릭 시 활성 작업 패널 (progress bar + 메시지)
 *   - 종료 작업 5초 동안 노출 후 자동 제거 (사용자가 결과 인지)
 *
 * 일반 로직:
 *   - job.type 무관 — 모든 작업 동등 처리 (image/pipeline/cron/sandbox/llm/...)
 *   - SSE 만으로 list 유지. 페이지 reload 직후 진행 중이던 작업이 다음 update 이벤트 시
 *     자동으로 list 에 등장 (별도 API 조회 불필요)
 */
import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Activity, X } from 'lucide-react';
import { useEvents } from '../hooks/events-manager';

interface JobStatus {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress?: number;
  message?: string;
  startedAt: number;
  updatedAt: number;
  doneAt?: number;
  result?: unknown;
  error?: string;
  parentJobId?: string;
  meta?: Record<string, unknown>;
}

const FINISHED_RETENTION_MS = 5_000;

export function ActiveJobsIndicator() {
  const [jobs, setJobs] = useState<Map<string, JobStatus>>(new Map());
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ left: number; bottom: number } | null>(null);

  // dropdown 열릴 때 버튼 위치 → viewport 좌표 계산. 입력창 overflow-hidden 회피용 portal 좌표.
  // viewport 안에 들어오게 left clamp — 모바일에서 dropdown 이 화면 밖으로 나가는 현상 방지.
  useEffect(() => {
    if (!open) { setCoords(null); return; }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const dropdownWidth = Math.min(320, window.innerWidth - 16); // w-80 (320) 또는 viewport-16 중 작은 것
      // 버튼 중심 정렬 시도 → 좌우 viewport edge 안에 clamp (8px margin)
      const center = (r.left + r.right) / 2;
      const idealLeft = center - dropdownWidth / 2;
      const left = Math.max(8, Math.min(idealLeft, window.innerWidth - dropdownWidth - 8));
      setCoords({ left, bottom: window.innerHeight - r.top });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEvents(['status:update'], (ev) => {
    const payload = ev.data as { job: JobStatus; change: string } | undefined;
    if (!payload?.job) return;
    const { job, change } = payload;
    setJobs(prev => {
      const next = new Map(prev);
      next.set(job.id, job);
      return next;
    });
    // 종료 작업은 retention 후 자동 제거
    if (change === 'completed' || change === 'failed') {
      setTimeout(() => {
        setJobs(prev => {
          const next = new Map(prev);
          next.delete(job.id);
          return next;
        });
      }, FINISHED_RETENTION_MS);
    }
  });

  const activeJobs = useMemo(
    () => Array.from(jobs.values()).filter(j => j.status === 'running' || j.status === 'queued'),
    [jobs],
  );
  const finishedJobs = useMemo(
    () => Array.from(jobs.values()).filter(j => j.status === 'done' || j.status === 'error'),
    [jobs],
  );

  // 활성·종료 모두 0 = 인디케이터 자체 숨김
  if (activeJobs.length === 0 && finishedJobs.length === 0) return null;

  // dropdown — 입력창 overflow-hidden 회피 위해 Portal 로 document.body 직접 마운트.
  // fixed position + getBoundingClientRect 로 버튼 위에 정확히 anchoring.
  const dropdown = open && coords && (
    <>
      {/* backdrop — 클릭 시 닫힘 */}
      <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} />
      <div
        className="fixed z-[60] bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
        style={{
          left: `${coords.left}px`,
          bottom: `${coords.bottom + 8}px`,
          width: `${Math.min(320, window.innerWidth - 16)}px`,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <span className="text-[12px] font-bold text-slate-700">작업 상태</span>
          <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
            <X size={14} />
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {[...activeJobs, ...finishedJobs].map(job => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      </div>
    </>
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-bold transition-colors"
        aria-label={`실행 중 ${activeJobs.length}개`}
      >
        <Activity size={14} className={activeJobs.length > 0 ? 'animate-pulse' : ''} />
        <span>실행 {activeJobs.length}</span>
        {finishedJobs.length > 0 && (
          <span className="text-[10px] text-emerald-600">+{finishedJobs.length}</span>
        )}
      </button>
      {dropdown && typeof window !== 'undefined' && createPortal(dropdown, document.body)}
    </>
  );
}

function JobRow({ job }: { job: JobStatus }) {
  const isRunning = job.status === 'running' || job.status === 'queued';
  const isError = job.status === 'error';
  const elapsed = Math.max(0, ((job.doneAt ?? Date.now()) - job.startedAt) / 1000).toFixed(0);
  const tone = isError
    ? 'text-red-600'
    : isRunning
      ? 'text-blue-600'
      : 'text-emerald-600';

  return (
    <div className="px-3 py-2 border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] font-bold uppercase ${tone}`}>{job.type}</span>
        <span className="text-[10px] text-slate-400 tabular-nums">{elapsed}초</span>
        {isError && <span className="text-[10px] text-red-500">실패</span>}
        {!isRunning && !isError && <span className="text-[10px] text-emerald-500">완료</span>}
      </div>
      {job.message && (
        <p className="text-[11px] text-slate-600 break-words">{job.message}</p>
      )}
      {isError && job.error && (
        <p className="text-[10px] text-red-500 break-words mt-0.5">{job.error}</p>
      )}
      {isRunning && typeof job.progress === 'number' && (
        <div className="mt-1.5 h-1 bg-slate-100 rounded overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${Math.round(job.progress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Timer, CalendarClock, Repeat, Trash2, Loader2, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, X, Save, Settings, Play } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSidebarRefresh } from '../hooks/events-manager';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';
import { rowActionsClass } from '../utils/row-actions';
import { logger } from '../../../lib/util/logger';
import { apiGet, apiPost, apiDelete, apiPut } from '../../../lib/api-fetch';
import { usePolling } from '../../../lib/hooks/use-polling';
import { TIME } from '../../../lib/util/time';
import { z } from 'zod';
import { validateForm } from '../../../lib/form-validation';
import type { CronRunWhen, CronRetry, CronNotify } from '../../../lib/types/firebat-types';

interface CronJob {
  jobId: string;
  targetPath: string;
  title?: string;
  description?: string;
  cronTime?: string;
  runAt?: string;
  delaySec?: number;
  startAt?: string;
  endAt?: string;
  inputData?: any;
  pipeline?: any[];
  createdAt: string;
  mode: string;
  oneShot?: boolean;
  runWhen?: CronRunWhen;
  retry?: CronRetry;
  notify?: CronNotify;
  executionMode?: 'pipeline' | 'agent';
  agentPrompt?: string;
}

interface CronLog {
  jobId: string;
  targetPath: string;
  title?: string;
  triggeredAt: string;
  success: boolean;
  durationMs: number;
  error?: string;
  /** 마지막 step 결과 요약 (savedSlug 등) — silent failure 추적용 */
  output?: Record<string, any>;
  stepsExecuted?: number;
  stepsTotal?: number;
}

export type CronHubContext = { slug: string; apiToken: string; sessionId: string };

export function CronPanel({
  hubMode,
  hubContext,
}: {
  hubMode?: boolean;
  hubContext?: CronHubContext;
} = {}) {
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [editing, setEditing] = useState<CronJob | null>(null);
  // 모바일 select-to-show 패턴 — Sidebar 와 동일. PC 에선 무시 (group-hover 가 처리).
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data: cronData } = useQuery({
    queryKey: ['cron', hubMode && hubContext ? `hub-${hubContext.slug}` : 'admin'],
    queryFn: async () => {
      if (hubMode) {
        // 익명 hub endpoint — owner='hub:<id>' 인 작업만 노출.
        if (!hubContext) return { jobs: [] as CronJob[], logs: [] as CronLog[] };
        try {
          const res = await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/cron`, {
            headers: {
              'X-Api-Token': hubContext.apiToken,
              'X-Session-Id': hubContext.sessionId,
            },
          });
          const data = await res.json().catch(() => null);
          if (data?.success) return { jobs: data.jobs ?? [], logs: data.logs ?? [] };
        } catch (e) {
          logger.debug('cron', 'hub fetch 실패', { error: e });
        }
        return { jobs: [], logs: [] };
      }
      return apiGet<{ jobs?: CronJob[]; logs?: CronLog[] }>('/api/cron', { category: 'cron' }).catch((e) => {
        logger.debug('cron', 'fetch 실패', { error: e });
        return { jobs: [], logs: [] };
      });
    },
  });
  const jobs = cronData?.jobs ?? [];
  const logs = cronData?.logs ?? [];
  const invalidateCron = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['cron'] }),
    [queryClient],
  );

  // SSE (cron:complete / sidebar:refresh) + window 'firebat-refresh' 통합 수신
  // EventsManager 싱글톤이 EventSource 1개만 유지 — Sidebar 와 공유. hub mode 면 no-op (admin SSE 수신 X).
  useSidebarRefresh(hubMode ? () => {} : invalidateCron);

  // 알림 폴링 (페이지 열기용, 30초 간격). 탭 백그라운드 시 자동 일시정지. hub mode 면 skip.
  usePolling({
    interval: 30 * TIME.SECOND_MS,
    onTick: async () => {
      if (hubMode) return;
      try {
        const nData = await apiGet<{ notifications?: Array<{ url: string }> }>('/api/cron?notify=poll', { category: 'cron' });
        for (const n of nData.notifications ?? []) window.open(n.url, '_blank');
      } catch (e) { logger.debug('cron', 'notify poll 실패', { error: e }); }
    },
  });

  const handleCancel = async (jobId: string) => {
    if (!await confirmDialog({ title: '잡 해제', message: `잡 "${jobId}"을(를) 해제하시겠습니까?`, danger: true, okLabel: '해제' })) return;
    setCancelling(jobId);
    try {
      if (hubMode && hubContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubContext.slug)}/cron?jobId=${encodeURIComponent(jobId)}`, {
          method: 'DELETE',
          headers: {
            'X-Api-Token': hubContext.apiToken,
            'X-Session-Id': hubContext.sessionId,
          },
        });
      } else {
        await apiDelete(`/api/cron?jobId=${encodeURIComponent(jobId)}`, { category: 'cron' });
      }
      invalidateCron();
    } finally {
      setCancelling(null);
    }
  };

  const handleRunNow = async (jobId: string) => {
    setRunning(jobId);
    try {
      // fire-and-forget — 백엔드가 비동기 트리거. 결과는 cron-logs SSE 로 반영.
      // setTimeout 으로 spinner 잠깐 보여주고 자동 해제 (UX 안정).
      await apiPost(`/api/cron?action=run&jobId=${encodeURIComponent(jobId)}`, undefined, { category: 'cron' });
      setTimeout(() => setRunning(null), 1500);
    } catch {
      setRunning(null);
    }
  };

  const handleClearLogs = async () => {
    if (!await confirmDialog({ title: '로그 삭제', message: '실행 로그를 전부 삭제하시겠습니까?', danger: true, okLabel: '삭제' })) return;
    await apiDelete('/api/cron?logs=clear', { category: 'cron' });
    invalidateCron();
  };

  const formatCron = (expr: string) => {
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) return expr;
    const [min, hour, dom, mon, dow] = parts;

    const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
    const dowLabel = (() => {
      if (dow === '*') return '';
      if (dow === '1-5') return '평일';
      if (dow === '0,6' || dow === '6,0') return '주말';
      if (/^\d$/.test(dow)) return DOW_KO[parseInt(dow)] + '요일';
      if (/^\d+(,\d+)+$/.test(dow)) return dow.split(',').map(d => DOW_KO[parseInt(d)]).join('·') + '요일';
      if (/^\d+-\d+$/.test(dow)) {
        const [s, e] = dow.split('-').map(Number);
        return `${DOW_KO[s]}~${DOW_KO[e]}요일`;
      }
      return '';
    })();

    const hourLabel = (() => {
      if (hour === '*') return null;
      if (/^\d+-\d+$/.test(hour)) {
        const [s, e] = hour.split('-').map(Number);
        return `${s}~${e}시`;
      }
      if (/^\*\/\d+$/.test(hour)) return `${hour.slice(2)}시간마다`;
      if (/^\d+$/.test(hour)) return `${hour}시`;
      return null;
    })();

    const minLabel = (() => {
      if (min === '*') return '매분';
      if (min === '0') return '정각';
      if (/^\*\/\d+$/.test(min)) return `${min.slice(2)}분마다`;
      if (/^\d+$/.test(min)) return `${min}분`;
      return min + '분';
    })();

    const parts_out: string[] = [];
    if (dowLabel) parts_out.push(dowLabel);
    if (dom !== '*') parts_out.push(`${dom}일`);
    if (mon !== '*') parts_out.push(`${mon}월`);

    // 시·분 조합
    if (hourLabel && min === '0') parts_out.push(hourLabel + ' 정각');
    else if (hourLabel && /^\d+$/.test(min)) parts_out.push(`${hour}:${min.padStart(2, '0')}`);
    else if (hourLabel && /^\*\/\d+$/.test(min)) parts_out.push(`${hourLabel} ${min.slice(2)}분마다`);
    else if (hourLabel) parts_out.push(hourLabel);
    else parts_out.push(minLabel);

    return parts_out.join(' ') || expr;
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const modeIcon = (mode: string) => {
    switch (mode) {
      case 'cron': return <Repeat size={12} className="text-amber-500 shrink-0" />;
      case 'once': return <CalendarClock size={12} className="text-blue-500 shrink-0" />;
      case 'delay': return <Timer size={12} className="text-emerald-500 shrink-0" />;
      default: return <Clock size={12} className="text-slate-400 shrink-0" />;
    }
  };

  const modeLabel = (job: CronJob) => {
    if (job.mode === 'cron') {
      let label = formatCron(job.cronTime!);
      if (job.endAt) label += ` ~${formatTime(job.endAt)}`;
      return label;
    }
    if (job.mode === 'once' && job.runAt) return formatTime(job.runAt);
    if (job.mode === 'delay') return '지연 실행 대기중';
    return job.mode;
  };

  // 항상 SCHEDULER 섹션 표시 — 잡·로그 둘 다 없어도 빈 상태 노출
  // (사용자가 cron 등록 직후 즉시 발화 시 잡 목록 비어보여도 이 섹션은 유지)

  return (
    <div className="border-t border-slate-200/80">
      <div className="px-3 py-2 text-[10px] font-extrabold tracking-widest text-slate-400 flex items-center gap-1.5">
        <Clock size={11} /> SCHEDULER
      </div>

      {jobs.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate-400 italic">등록된 잡 없음</p>
      ) : (
        <div className="pb-2 px-2 space-y-0.5">
          {jobs.map(job => {
            const jobSelected = selectedJobId === job.jobId;
            return (
            <div
              key={job.jobId}
              onClick={() => setSelectedJobId(jobSelected ? null : job.jobId)}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${jobSelected ? 'bg-slate-100' : 'hover:bg-slate-100'}`}
            >
              {modeIcon(job.mode)}
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-semibold text-slate-700 truncate">{job.title || job.jobId}</p>
                <p className="text-[10px] text-slate-400 truncate">
                  {modeLabel(job)}{job.description ? ` · ${job.description}` : ''}
                </p>
              </div>
              <span className={rowActionsClass(jobSelected)}>
                <Tooltip label="지금 실행">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRunNow(job.jobId); setSelectedJobId(null); }}
                    disabled={running === job.jobId}
                    className="p-1 rounded text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                  >
                    {running === job.jobId ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                  </button>
                </Tooltip>
                <Tooltip label="설정">
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditing(job); setSelectedJobId(null); }}
                    className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                  >
                    <Settings size={11} />
                  </button>
                </Tooltip>
                <Tooltip label="해제">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCancel(job.jobId); setSelectedJobId(null); }}
                    disabled={cancelling === job.jobId}
                    className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  >
                    {cancelling === job.jobId ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  </button>
                </Tooltip>
              </span>
            </div>
            );
          })}
        </div>
      )}

      {logs.length > 0 && (
        <>
          <div className="flex items-center px-3 py-1">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="flex-1 text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors"
            >
              {showLogs ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              최근 실행 로그 ({logs.length})
            </button>
            {showLogs && (
              <Tooltip label="로그 전체 삭제">
                <button
                  onClick={handleClearLogs}
                  className="p-0.5 text-slate-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={10} />
                </button>
              </Tooltip>
            )}
          </div>
          {showLogs && (
            <div className="px-2 pb-2 space-y-1 max-h-60 overflow-y-auto">
              {[...logs].reverse().slice(0, 20).map((log, i) => {
                // output 요약 — savedSlug 우선 표시. warning 있으면 경고 색상
                const out = log.output || {};
                const savedSlug = out.savedSlug as string | undefined;
                const warning = out.warning as string | undefined;
                const stepFrac = log.stepsTotal != null ? `${log.stepsExecuted ?? '?'}/${log.stepsTotal}` : null;
                return (
                  <div key={i} className={`flex flex-col gap-0.5 px-2 py-1 rounded text-[10px] ${warning ? 'bg-amber-50' : ''}`}>
                    <div className="flex items-center gap-1.5">
                      {log.success ? (
                        <CheckCircle2 size={10} className={`shrink-0 ${warning ? 'text-amber-500' : 'text-emerald-500'}`} />
                      ) : (
                        <AlertCircle size={10} className="text-red-500 shrink-0" />
                      )}
                      <span className="text-slate-600 font-medium truncate">{log.title || log.jobId}</span>
                      <span className="text-slate-400 shrink-0">{log.durationMs}ms</span>
                      {stepFrac && <span className="text-slate-400 shrink-0">· {stepFrac} step</span>}
                      <span className="text-slate-400 shrink-0 ml-auto">{formatTime(log.triggeredAt)}</span>
                    </div>
                    {savedSlug && (
                      <div className="flex items-center gap-1 pl-4 text-emerald-700">
                        <span>→ /{savedSlug}</span>
                      </div>
                    )}
                    {warning && (
                      <div className="pl-4 text-amber-700 break-words">⚠ {warning}</div>
                    )}
                    {log.error && (
                      <div className="pl-4 text-red-600 break-words">{log.error}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {editing && (
        <ScheduleModal
          job={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidateCron(); }}
          onDelete={() => { handleCancel(editing.jobId); setEditing(null); }}
        />
      )}
    </div>
  );
}

// ── 스케줄 등록/수정 모달 ──────────────────────────────────────────────
export function ScheduleModal({ job, onClose, onSaved, onDelete }: {
  job: {
    jobId: string;
    targetPath: string;
    title?: string;
    description?: string;
    pipeline?: any[];
    pageSlugs?: string[];
    cronTime?: string;
    runAt?: string;
    delaySec?: number;
    startAt?: string;
    endAt?: string;
    inputData?: any;
    mode?: string;
    oneShot?: boolean;
    runWhen?: CronRunWhen;
    retry?: CronRetry;
    notify?: CronNotify;
    executionMode?: 'pipeline' | 'agent';
    agentPrompt?: string;
  } | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete?: () => void;
}) {
  const endAtId = useId();
  const advancedCronId = useId();
  const freqIntervalId = useId();
  const freqHourId = useId();
  const freqMinuteId = useId();
  const runAtId = useId();
  const delaySecId = useId();
  const permanentId = useId();
  const agentPromptId = useId();
  const oneShotId = useId();
  const runWhenTextId = useId();
  const retryTextId = useId();
  const notifyTextId = useId();
  const isNew = !job?.mode;
  const [jobId, setJobId] = useState(job?.jobId || '');
  const [mode, setMode] = useState<'cron' | 'once' | 'delay'>(
    (job?.mode as any) || 'cron'
  );

  const [targetPath] = useState(job?.targetPath || '');

  // 반복 주기 (사용자 친화적)
  type FreqType = 'minutes' | 'hours' | 'daily' | 'weekly' | 'advanced';
  const parsedFreq = parseCronToFreq(job?.cronTime);
  const [freqType, setFreqType] = useState<FreqType>(parsedFreq.type);
  const [freqInterval, setFreqInterval] = useState(parsedFreq.interval);
  const [freqHour, setFreqHour] = useState(parsedFreq.hour);
  const [freqMinute, setFreqMinute] = useState(parsedFreq.minute);
  const [freqDows, setFreqDows] = useState<number[]>(parsedFreq.dows);
  const [advancedCron, setAdvancedCron] = useState(job?.cronTime || '');

  const [runAt, setRunAt] = useState(job?.runAt ? toLocalInput(job.runAt) : '');
  const [delaySec, setDelaySec] = useState(job?.delaySec ? String(job.delaySec) : '');
  const [endAt, setEndAt] = useState(job?.endAt ? toLocalInput(job.endAt) : '');
  const [permanent, setPermanent] = useState(!job?.endAt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── 표준 메커니즘: runWhen / retry / notify (JSON 직접 편집) ──
  // job 의 기존 값을 JSON 문자열로 직렬화 → textarea 에 표시. 빈 객체면 "" 로 표기.
  const stringifyOrEmpty = (v: unknown): string => v ? JSON.stringify(v, null, 2) : '';
  const [oneShot, setOneShot] = useState<boolean>(!!job?.oneShot);
  const [runWhenText, setRunWhenText] = useState<string>(stringifyOrEmpty(job?.runWhen));
  const [retryText, setRetryText] = useState<string>(stringifyOrEmpty(job?.retry));
  const [notifyText, setNotifyText] = useState<string>(stringifyOrEmpty(job?.notify));
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    !!(job?.runWhen || job?.retry || job?.notify || job?.oneShot)
  );

  // ── 실행 모드: pipeline / agent ──
  const [executionMode, setExecutionMode] = useState<'pipeline' | 'agent'>(job?.executionMode || 'pipeline');
  const [agentPrompt, setAgentPrompt] = useState<string>(job?.agentPrompt || '');

  const toggleDow = (d: number) => {
    setFreqDows(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort());
  };

  const buildCronTime = (): string => {
    switch (freqType) {
      case 'minutes': return `*/${freqInterval} * * * *`;
      case 'hours': return `0 */${freqInterval} * * *`;
      case 'daily': return `${freqMinute} ${freqHour} * * *`;
      case 'weekly': return `${freqMinute} ${freqHour} * * ${freqDows.length > 0 ? freqDows.join(',') : '*'}`;
      case 'advanced': return advancedCron;
    }
  };

  const describeCron = (expr: string): string => {
    const p = expr.split(' ');
    if (p.length !== 5) return expr;
    const [min, hour, dom, mon, dow] = p;
    if (min.startsWith('*/')) return `${min.slice(2)}분마다`;
    if (hour.startsWith('*/')) return `${hour.slice(2)}시간마다`;
    const timeStr = `${hour}:${min.padStart(2, '0')}`;
    if (dom !== '*' && mon === '*') return `매월 ${dom}일 ${timeStr}`;
    if (dow !== '*') {
      const days = dow.split(',').map(d => DOW_LABELS[parseInt(d)] || d).join('·');
      return `매주 ${days} ${timeStr}`;
    }
    if (min !== '*' && hour !== '*') return `매일 ${timeStr}`;
    return expr;
  };

  // JSON 텍스트 → object | undefined (빈 문자열 = undefined). z.NEVER 로 검증 실패 신호.
  const jsonField = (label: string) =>
    z.string().transform((raw, ctx) => {
      const t = raw.trim();
      if (!t) return undefined;
      try { return JSON.parse(t); }
      catch (e: any) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} JSON 파싱 실패: ${e.message}` });
        return z.NEVER;
      }
    });

  const scheduleSchema = z.object({
    jobId: z.string().min(1, '잡 ID가 없습니다.'),
    executionMode: z.enum(['pipeline', 'agent']),
    agentPrompt: z.string(),
    runWhen: jsonField('runWhen'),
    retry: jsonField('retry'),
    notify: jsonField('notify'),
  }).refine((v) => v.executionMode !== 'agent' || v.agentPrompt.trim().length > 0, {
    message: 'agent 모드는 agentPrompt 필수입니다.',
    path: ['agentPrompt'],
  });

  const handleSave = async () => {
    setSaving(true);
    setError('');

    const parsed = validateForm(scheduleSchema, {
      jobId,
      executionMode,
      agentPrompt,
      runWhen: runWhenText,
      retry: retryText,
      notify: notifyText,
    });
    if (!parsed.success) {
      const first = Object.values(parsed.errors)[0];
      if (first) setError(first);
      setSaving(false);
      return;
    }

    try {
      const body: any = { jobId: parsed.data.jobId, targetPath: targetPath || '' };
      if (job?.pipeline) body.pipeline = job.pipeline;
      if (mode === 'cron') body.cronTime = buildCronTime();
      if (mode === 'once' && runAt) body.runAt = new Date(runAt).toISOString();
      if (mode === 'delay' && delaySec) body.delaySec = Number(delaySec);
      if (!permanent && endAt) body.endAt = new Date(endAt).toISOString();
      if (job?.inputData !== undefined) body.inputData = job.inputData;
      if (job?.title) body.title = job.title;
      if (job?.description) body.description = job.description;

      // 표준 메커니즘 — 비어있으면 명시적으로 null 보내서 기존 값 제거
      body.oneShot = oneShot || undefined;
      body.runWhen = parsed.data.runWhen;
      body.retry = parsed.data.retry;
      body.notify = parsed.data.notify;

      // 실행 모드 + agent prompt
      body.executionMode = parsed.data.executionMode;
      body.agentPrompt = parsed.data.executionMode === 'agent' ? parsed.data.agentPrompt.trim() : undefined;

      try {
        await apiPut('/api/cron', body, { category: 'cron' });
        onSaved();
      } catch (e: any) {
        setError(e?.message || '저장 실패');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];
  const btnCls = (active: boolean) =>
    `flex-1 px-2 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
      active ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
    }`;

  // Portal 로 document.body 직접 렌더 — 사이드바·CronPanel 부모 stacking context
  // (transform/overflow/contain) 영향 회피. fixed inset-0 가 viewport 기준 동작.
  const modalContent = (
    <div className="fixed inset-0 bg-black/40 z-[60] flex items-stretch justify-center sm:items-center sm:p-4" onClick={onClose}>
      {/* 갤러리와 동일 패턴: 모바일은 inset-0 + items-stretch → viewport unit 의존 없이 자연 높이 채움.
          PC 는 sm:h-[85vh] + p-4 + items-center 로 가운데 카드. */}
      <div
        className="bg-white w-full sm:max-w-md sm:rounded-xl rounded-t-none shadow-2xl flex flex-col h-full sm:h-[85vh] sm:max-h-[85vh] overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50 shrink-0"
          style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}
        >
          <h3 className="text-sm font-bold text-slate-800">{isNew ? '스케줄 등록' : '스케줄 수정'}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 overflow-y-auto flex-1">
          {/* 스케줄 설명 */}
          {(job?.title || job?.description) && (
            <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
              {job?.title && <p className="text-[12px] font-semibold text-slate-700">{job.title}</p>}
              {job?.description && <p className="text-[11px] text-slate-500 mt-0.5">{job.description}</p>}
            </div>
          )}

          {/* 실행 모드 */}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1.5 block">실행 방식</label>
            <div className="flex gap-1">
              {([['cron', '반복'], ['once', '예약 1회'], ['delay', '지연']] as const).map(([m, label]) => (
                <button key={m} onClick={() => setMode(m)} className={btnCls(mode === m)}>{label}</button>
              ))}
            </div>
          </div>

          {/* 반복 설정 */}
          {mode === 'cron' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold text-slate-500">반복 주기</label>
                <button onClick={() => setFreqType(freqType === 'advanced' ? 'minutes' : 'advanced')}
                  className="text-[10px] text-blue-500 hover:text-blue-700 transition-colors">
                  {freqType === 'advanced' ? '간편 모드' : '고급'}
                </button>
              </div>

              {freqType === 'advanced' ? (
                <div className="space-y-1.5">
                  <label htmlFor={advancedCronId} className="sr-only">고급 cron 표현식</label>
                  <input value={advancedCron} onChange={e => setAdvancedCron(e.target.value)}
                    placeholder="분 시 일 월 요일 (예: 0 9 * * *)"
                    aria-label="고급 cron 표현식"
                    className="w-full px-3 py-1.5 text-[12px] font-mono border border-slate-300 rounded-lg outline-none focus:border-blue-400" name="advancedCron" autoComplete="off" id={advancedCronId} />
                  {advancedCron && (
                    <p className="text-[10px] text-blue-600 px-1">→ {describeCron(advancedCron)}</p>
                  )}
                  <div className="text-[10px] text-slate-400 px-1 space-y-0.5">
                    <p>형식: 분(0-59) 시(0-23) 일(1-31) 월(1-12) 요일(0-6, 0=일)</p>
                    <p>* = 매번 · */N = N마다 · 1,3,5 = 특정 값</p>
                    <p>0 9 * * * = 매일 9시 · 0 9 * * 1-5 = 평일 9시 · */30 * * * * = 30분마다</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex gap-1">
                    {([['minutes', '분마다'], ['hours', '시간마다'], ['daily', '매일'], ['weekly', '매주']] as const).map(([f, label]) => (
                      <button key={f} onClick={() => setFreqType(f)} className={btnCls(freqType === f)}>{label}</button>
                    ))}
                  </div>

                  {(freqType === 'minutes' || freqType === 'hours') && (
                    <div className="flex items-center gap-2">
                      <input type="number" min={1} max={freqType === 'minutes' ? 59 : 23} value={freqInterval}
                        onChange={e => setFreqInterval(Number(e.target.value) || 1)}
                        aria-label={freqType === 'minutes' ? '분 단위 간격' : '시간 단위 간격'}
                        className="w-16 px-2 py-1.5 text-[12px] border border-slate-300 rounded-lg outline-none text-center" name="freqInterval" autoComplete="off" id={freqIntervalId} />
                      <span className="text-[12px] text-slate-600">{freqType === 'minutes' ? '분' : '시간'}마다 실행</span>
                    </div>
                  )}

                  {freqType === 'weekly' && (
                    <div className="flex gap-0.5">
                      {DOW_LABELS.map((d, i) => (
                        <button key={i} onClick={() => toggleDow(i)}
                          className={`flex-1 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors ${
                            freqDows.includes(i) ? 'bg-blue-100 border-blue-300 text-blue-700' : 'border-slate-200 text-slate-400 hover:bg-slate-50'
                          }`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  )}

                  {(freqType === 'daily' || freqType === 'weekly') && (
                    <div className="flex items-center gap-2">
                      <input type="number" min={0} max={23} value={freqHour}
                        onChange={e => setFreqHour(Number(e.target.value))}
                        aria-label="시"
                        className="w-14 px-2 py-1.5 text-[12px] border border-slate-300 rounded-lg outline-none text-center" name="freqHour" autoComplete="off" id={freqHourId} />
                      <span className="text-[12px] text-slate-600">시</span>
                      <input type="number" min={0} max={59} value={freqMinute}
                        onChange={e => setFreqMinute(Number(e.target.value))}
                        aria-label="분"
                        className="w-14 px-2 py-1.5 text-[12px] border border-slate-300 rounded-lg outline-none text-center" name="freqMinute" autoComplete="off" id={freqMinuteId} />
                      <span className="text-[12px] text-slate-600">분</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {mode === 'once' && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 mb-1 block" htmlFor={runAtId}>실행 시각</label>
              <input type="datetime-local" value={runAt} onChange={e => setRunAt(e.target.value)}
                className="w-full px-3 py-1.5 text-[12px] border border-slate-300 rounded-lg outline-none focus:border-blue-400" name="runAt" autoComplete="off" id={runAtId} />
            </div>
          )}

          {mode === 'delay' && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-semibold text-slate-500 shrink-0" htmlFor={delaySecId}>지연</label>
              <input type="number" min={1} value={delaySec} onChange={e => setDelaySec(e.target.value)}
                placeholder="300" className="w-20 px-2 py-1.5 text-[12px] border border-slate-300 rounded-lg outline-none text-center" name="delaySec" autoComplete="off" id={delaySecId} />
              <span className="text-[12px] text-slate-600">초 후 실행</span>
            </div>
          )}

          {/* 종료 시각 */}
          {mode === 'cron' && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-[11px] font-semibold text-slate-500" htmlFor={endAtId}>종료 시각</label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={permanent} onChange={e => setPermanent(e.target.checked)}
                    className="w-3 h-3 rounded border-slate-300" name="permanent" autoComplete="off" id={permanentId} aria-label="종료 시각 영구" />
                  <span className="text-[10px] text-slate-400">영구</span>
                </label>
              </div>
              {!permanent && (
                <input type="datetime-local" value={endAt} onChange={e => setEndAt(e.target.value)}
                  className="w-full px-3 py-1.5 text-[12px] border border-slate-300 rounded-lg outline-none focus:border-blue-400" name="endAt" autoComplete="off" id={endAtId} aria-label="종료 시각" />
              )}
            </div>
          )}

          {/* 입력 데이터 (읽기 전용) */}
          {job?.inputData && (
            <div>
              <label className="text-[11px] font-semibold text-slate-500 mb-1 block">입력 데이터</label>
              <pre className="px-3 py-2 text-[11px] bg-slate-50 border border-slate-200 rounded-lg text-slate-600 overflow-x-auto max-h-24 whitespace-pre-wrap">
                {typeof job.inputData === 'string' ? job.inputData : JSON.stringify(job.inputData, null, 2)}
              </pre>
            </div>
          )}

          {/* 실행 모드 (pipeline / agent) */}
          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1.5 block">실행 모드</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setExecutionMode('pipeline')}
                className={btnCls(executionMode === 'pipeline')}
              >
                Pipeline
              </button>
              <button
                type="button"
                onClick={() => setExecutionMode('agent')}
                className={btnCls(executionMode === 'agent')}
              >
                AI Agent
              </button>
            </div>
            {executionMode === 'pipeline' ? (
              <>
                <p className="text-[10px] text-slate-400 mt-1.5">미리 짠 step 흐름 결정적 실행 (싸고 결정적). 단순 시세·알림에 사용.</p>
                {job?.pipeline && (
                  <pre className="mt-1.5 px-3 py-2 text-[11px] bg-slate-50 border border-slate-200 rounded-lg text-slate-600 overflow-x-auto max-h-32 whitespace-pre-wrap">
                    {JSON.stringify(job.pipeline, null, 2)}
                  </pre>
                )}
              </>
            ) : (
              <div className="mt-1.5 space-y-1">
                <p className="text-[10px] text-slate-400">트리거마다 AI Function Calling 사이클로 실행. 도구 자유 사용·검증·콘텐츠 생성 가능 (비용 ↑). 블로그·리포트·일정 정리에 사용.</p>
                <label htmlFor={agentPromptId} className="sr-only">AI Agent 프롬프트</label>
                <textarea
                  value={agentPrompt}
                  onChange={e => setAgentPrompt(e.target.value)}
                  rows={6}
                  placeholder={'예: "이번 주 주제 리서치 + sysmod 데이터 수집 + 페이지 발행 + 텔레그램 알림. 출처·시점 명시, 과거·미래 분간, hallucinate 금지."'}
                  aria-label="AI Agent 프롬프트"
                  className="w-full px-3 py-2 text-[11px] border border-slate-300 rounded-lg outline-none focus:border-blue-400 resize-y font-mono" name="agentPrompt" autoComplete="off" id={agentPromptId}
                />
                <p className="text-[10px] text-slate-400">트리거 시 AI 가 user message 로 받음. 잡 목적·필요 데이터·출력 형식·알림 명시.</p>
              </div>
            )}
          </div>

          {/* 표준 메커니즘 (runWhen / retry / notify / oneShot) */}
          <div className="pt-1">
            <button
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-700 transition-colors"
              type="button"
            >
              {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              고급 옵션 (runWhen · retry · notify · oneShot)
            </button>

            {showAdvanced && (
              <div className="mt-2 space-y-3 pl-3 border-l-2 border-slate-100">
                {/* oneShot */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oneShot} onChange={e => setOneShot(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-slate-300" name="oneShot" autoComplete="off" id={oneShotId} aria-label="oneShot — 첫 성공 시 자동 취소" />
                  <span className="text-[11px] text-slate-600">oneShot — 첫 성공 시 자동 취소</span>
                </label>

                {/* runWhen */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-semibold text-slate-500">runWhen <span className="text-slate-400 font-normal">— 발화 전 조건 체크 (휴장·가드)</span></label>
                    {runWhenText && <button onClick={() => setRunWhenText('')} type="button" className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">제거</button>}
                  </div>
                  <textarea value={runWhenText} onChange={e => setRunWhenText(e.target.value)}
                    placeholder={'{\n  "check": { "sysmod": "<module>", "action": "<action>" },\n  "field": "$prev.<field>",\n  "op": "==",\n  "value": "<expected>"\n}'}
                    rows={5}
                    aria-label="runWhen 조건"
                    className="w-full px-3 py-2 text-[11px] font-mono border border-slate-300 rounded-lg outline-none focus:border-blue-400 resize-y" name="runWhenText" autoComplete="off" id={runWhenTextId} />
                </div>

                {/* retry */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-semibold text-slate-500">retry <span className="text-slate-400 font-normal">— 멱등 도구만 (매수 등 부작용 도구는 금지)</span></label>
                    {retryText && <button onClick={() => setRetryText('')} type="button" className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">제거</button>}
                  </div>
                  <textarea value={retryText} onChange={e => setRetryText(e.target.value)}
                    placeholder={'{ "count": 3, "delayMs": 30000 }'}
                    rows={2}
                    aria-label="retry 정책"
                    className="w-full px-3 py-2 text-[11px] font-mono border border-slate-300 rounded-lg outline-none focus:border-blue-400 resize-y" name="retryText" autoComplete="off" id={retryTextId} />
                </div>

                {/* notify */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-semibold text-slate-500">notify <span className="text-slate-400 font-normal">— 결과 알림 hook (pipeline 외부 처리)</span></label>
                    {notifyText && <button onClick={() => setNotifyText('')} type="button" className="text-[10px] text-slate-400 hover:text-red-500 transition-colors">제거</button>}
                  </div>
                  <textarea value={notifyText} onChange={e => setNotifyText(e.target.value)}
                    placeholder={'{\n  "onSuccess": { "sysmod": "telegram", "template": "✓ {title} 완료" },\n  "onError": { "sysmod": "telegram", "template": "❌ {title} 실패: {error}" }\n}'}
                    rows={6}
                    aria-label="notify hook"
                    className="w-full px-3 py-2 text-[11px] font-mono border border-slate-300 rounded-lg outline-none focus:border-blue-400 resize-y" name="notifyText" autoComplete="off" id={notifyTextId} />
                  <p className="text-[10px] text-slate-400 mt-1">placeholder: {'{title} {jobId} {error} {durationMs} {output}'}</p>
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-[11px] text-red-500 font-medium">{error}</p>}
        </div>

        <div
          className="flex items-center justify-between px-5 py-3 border-t border-slate-200 bg-slate-50 shrink-0"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
        >
          {onDelete ? (
            <button onClick={onDelete} className="px-3 py-1.5 text-[12px] font-semibold text-red-500 hover:bg-red-50 rounded-lg transition-colors">
              삭제
            </button>
          ) : <div />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-[12px] font-semibold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors">
              취소
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50">
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {isNew ? '등록' : '저장'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof window === 'undefined') return null;
  return createPortal(modalContent, document.body);
}

// ── 유틸 ──────────────────────────────────────────────────────────────────

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 크론 표현식 → 사용자 친화적 주기 파싱 */
function parseCronToFreq(cronTime?: string) {
  const defaults = { type: 'minutes' as const, interval: 5, hour: 9, minute: 0, dows: [1] as number[] };
  if (!cronTime) return defaults;
  const parts = cronTime.split(' ');
  if (parts.length !== 5) return { ...defaults, type: 'advanced' as const };
  const [min, hour, dom, , dow] = parts;

  if (min.startsWith('*/')) return { ...defaults, type: 'minutes' as const, interval: parseInt(min.slice(2)) || 5 };
  if (hour.startsWith('*/')) return { ...defaults, type: 'hours' as const, interval: parseInt(hour.slice(2)) || 1 };
  if (dow !== '*') {
    const dows = dow.split(',').map(d => parseInt(d)).filter(d => !isNaN(d));
    return { ...defaults, type: 'weekly' as const, hour: parseInt(hour) || 0, minute: parseInt(min) || 0, dows };
  }
  if (dom !== '*') return { ...defaults, type: 'advanced' as const }; // 매월 특정일 → 고급
  if (min !== '*' && hour !== '*') return { ...defaults, type: 'daily' as const, hour: parseInt(hour) || 0, minute: parseInt(min) || 0 };
  return defaults;
}

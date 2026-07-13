'use client';

/**
 * LogPanel — admin 설정 로그 탭 (로그 시스템 Phase 5, 2026-05-21 / 고도화 2026-07-14).
 *
 * sqlite ring buffer (data/logs.db) 조회 + 런타임 EnvFilter reload (ssh SIGHUP 대신 UI).
 * journalctl 실질 대체: 전문 검색(contains, ring 전체 LIKE) + 실시간 tail(since 폴링,
 * 탭 백그라운드 자동 일시정지) + target 자동완성(로드된 엔트리에서 파생).
 * 범위 = 조회 / 필터 / 검색 / tail 만 (대시보드 / 그래프 / 알림 X — observability paradox 룰).
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2, RefreshCw, Filter, Play, Pause } from 'lucide-react';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import { usePolling } from '../../../lib/hooks/use-polling';
import { logger } from '../../../lib/util/logger';

interface LogEntry {
  tsMs: number;
  level: string;
  target: string;
  message: string;
}

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'bg-red-100 text-red-700 border-red-200',
  WARN: 'bg-amber-100 text-amber-700 border-amber-200',
  INFO: 'bg-blue-50 text-blue-600 border-blue-200',
  DEBUG: 'bg-slate-100 text-slate-500 border-slate-200',
  TRACE: 'bg-slate-50 text-slate-400 border-slate-200',
};

/** tail 중 화면에 쌓아둘 최대 줄 수 — 무한 누적 방지 (오래된 것부터 drop). */
const TAIL_MAX_ROWS = 1000;

export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState('');
  const [targetPrefix, setTargetPrefix] = useState('');
  const [contains, setContains] = useState('');
  // 입력 중 자유롭게 비울 수 있게 문자열 상태 — 조회 시점에만 1~2000 보정.
  // (옛 숫자 상태 + `Number("")||50` 은 "50" 의 5 를 지우면 즉시 50 으로 복귀 → 200 입력 불가였음)
  const [limit, setLimit] = useState('50');
  const [loading, setLoading] = useState(false);
  // 실시간 tail — journalctl -f 등가. since 폴링(2초)이라 SSE 배선 없이 견고, 탭 백그라운드
  // 시 usePolling 이 자동 일시정지. 새 줄은 위에 쌓임(최신순 뷰 유지 = 스크롤 고정 불필요).
  const [tail, setTail] = useState(false);
  // 런타임 EnvFilter — ssh `kill -HUP` 대신 UI 에서 즉시 적용 (재빌드/재시작 0).
  const [filterStr, setFilterStr] = useState('info');
  const [filterMsg, setFilterMsg] = useState<string | null>(null);
  // tail 폴링 커서 — 마지막으로 본 ts (그 이후만 요청). ref = 폴링 tick 간 상태 레이스 회피.
  const lastTsRef = useRef(0);

  const buildParams = useCallback((sinceMs?: number) => {
    const params = new URLSearchParams();
    if (minLevel) params.set('minLevel', minLevel);
    if (targetPrefix.trim()) params.set('targetPrefix', targetPrefix.trim());
    if (contains.trim()) params.set('contains', contains.trim());
    if (sinceMs) params.set('sinceMs', String(sinceMs));
    params.set('limit', String(Math.max(1, Math.min(2000, Number(limit) || 50))));
    return params;
  }, [minLevel, targetPrefix, contains, limit]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ success?: boolean; entries?: LogEntry[] }>(
        `/api/logs?${buildParams().toString()}`,
        { category: 'logs' },
      );
      if (data?.success) {
        const rows = data.entries ?? [];
        setEntries(rows);
        lastTsRef.current = rows[0]?.tsMs ?? Date.now();
      }
    } catch (e) {
      logger.error('logs', '로그 조회 실패', e);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // 탭 진입 시 1회 조회
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 실시간 tail — since 커서 이후 새 줄만 받아 위에 prepend. 필터/검색 조건 그대로 적용.
  usePolling({
    interval: 2000,
    enabled: tail,
    fireImmediately: false,
    onTick: async () => {
      try {
        const data = await apiGet<{ success?: boolean; entries?: LogEntry[] }>(
          `/api/logs?${buildParams(lastTsRef.current + 1).toString()}`,
          { category: 'logs' },
        );
        const rows = data?.entries ?? [];
        if (!data?.success || rows.length === 0) return;
        lastTsRef.current = Math.max(lastTsRef.current, rows[0]?.tsMs ?? 0);
        setEntries(prev => [...rows, ...prev].slice(0, TAIL_MAX_ROWS));
      } catch (e) {
        logger.debug('logs', 'tail 폴링 실패', { error: e });
      }
    },
  });

  const startTail = useCallback(() => {
    // 커서를 지금으로 — 켜는 순간부터의 새 로그만 흐르게 (과거는 조회 버튼 몫).
    if (lastTsRef.current === 0) lastTsRef.current = Date.now();
    setTail(true);
  }, []);

  // target 자동완성 — 로드된 엔트리에서 distinct target 파생 (백엔드 0).
  const targetOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.target);
    return Array.from(set).sort();
  }, [entries]);

  const applyFilter = useCallback(async () => {
    setFilterMsg(null);
    try {
      const data = await apiPost<{ success?: boolean; error?: string }>(
        '/api/logs',
        { filter: filterStr.trim() || 'info' },
        { category: 'logs' },
      );
      setFilterMsg(data?.success ? '적용되었습니다.' : (data?.error || '적용 실패'));
    } catch (e) {
      setFilterMsg('적용 실패');
      logger.error('logs', '로그 필터 적용 실패', e);
    }
  }, [filterStr]);

  return (
    <div className="flex flex-col gap-4">
      {/* 런타임 로그 레벨 — EnvFilter 동적 reload */}
      <div className="flex flex-col gap-1.5 p-3 bg-slate-50 border border-slate-200 rounded-lg">
        <span className="text-xs sm:text-sm font-bold text-slate-700">런타임 로그 레벨</span>
        <p className="text-[11px] text-slate-400">
          예: <code className="bg-slate-200 px-1 rounded">info</code> 또는 <code className="bg-slate-200 px-1 rounded">info,firebat_infra::adapters::sandbox=debug</code>
        </p>
        <div className="flex gap-2">
          <input
            id="log-filter"
            name="logFilter"
            type="text"
            value={filterStr}
            onChange={e => setFilterStr(e.target.value)}
            placeholder="info,target=debug"
            className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={applyFilter}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-bold rounded-lg flex items-center gap-1.5"
          >
            <Filter size={13} /> 적용
          </button>
        </div>
        {filterMsg && <span className="text-[11px] text-slate-500">{filterMsg}</span>}
      </div>

      {/* 조회 필터 */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="log-min-level" className="text-[11px] font-semibold text-slate-600">최소 레벨</label>
          <select
            id="log-min-level"
            name="minLevel"
            value={minLevel}
            onChange={e => setMinLevel(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">전체</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN 이상</option>
            <option value="INFO">INFO 이상</option>
            <option value="DEBUG">DEBUG 이상</option>
          </select>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
          <label htmlFor="log-target" className="text-[11px] font-semibold text-slate-600">target</label>
          <input
            id="log-target"
            name="targetPrefix"
            type="text"
            list="log-target-options"
            value={targetPrefix}
            onChange={e => setTargetPrefix(e.target.value)}
            placeholder="sandbox / cron / ai …"
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id="log-target-options">
            {targetOptions.map(t => <option key={t} value={t} />)}
          </datalist>
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
          <label htmlFor="log-contains" className="text-[11px] font-semibold text-slate-600">검색 (메시지·target 포함)</label>
          <input
            id="log-contains"
            name="contains"
            type="text"
            value={contains}
            onChange={e => setContains(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void load(); }}
            placeholder="embed_shadow / cron-cal / 429 …"
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex flex-col gap-1 w-20">
          <label htmlFor="log-limit" className="text-[11px] font-semibold text-slate-600">건수</label>
          <input
            id="log-limit"
            name="limit"
            type="number"
            value={limit}
            onChange={e => setLimit(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-800 disabled:opacity-50 text-white text-[13px] font-bold rounded-lg flex items-center gap-1.5"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} 조회
        </button>
        <button
          type="button"
          onClick={() => (tail ? setTail(false) : startTail())}
          className={`px-3 py-1.5 text-[13px] font-bold rounded-lg flex items-center gap-1.5 border ${
            tail
              ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600'
              : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300'
          }`}
          title="실시간 tail — 2초마다 새 로그를 위에 쌓습니다 (탭 백그라운드 시 자동 일시정지)"
        >
          {tail ? <Pause size={13} /> : <Play size={13} />} {tail ? '실시간 중' : '실시간'}
        </button>
      </div>

      {/* 로그 목록 */}
      <div className="flex flex-col gap-1 max-h-[50vh] overflow-y-auto border border-slate-200 rounded-lg p-2 bg-white">
        {entries.length === 0 ? (
          <div className="text-center py-8 text-[13px] text-slate-400">
            {loading ? '조회 중…' : tail ? '새 로그 대기 중…' : '로그 없음'}
          </div>
        ) : (
          entries.map((e, i) => (
            <div key={`${e.tsMs}-${i}`} className="flex flex-col gap-0.5 py-1.5 border-b border-slate-50 last:border-0 text-[12px] font-mono">
              {/* 메타 한 줄 (날짜·레벨·타겟) — 메시지는 다음 줄 전체 폭이라 타겟 길이로 폭이 들쭉날쭉하지 않음 */}
              <div className="flex items-center gap-2">
                <span className="text-slate-400 shrink-0 tabular-nums" title={new Date(e.tsMs).toLocaleString('ko-KR', { hour12: false })}>
                  {new Date(e.tsMs).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                </span>
                <span className={`shrink-0 px-1 rounded border text-[10px] font-bold ${LEVEL_COLOR[e.level.toUpperCase()] ?? LEVEL_COLOR.INFO}`}>
                  {e.level}
                </span>
                <span className="text-blue-600 truncate" title={e.target}>{e.target}</span>
              </div>
              <span className="text-slate-700 break-all whitespace-pre-wrap pl-0.5">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

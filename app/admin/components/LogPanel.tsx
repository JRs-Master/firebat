'use client';

/**
 * LogPanel — admin 설정 로그 탭 (로그 시스템 Phase 5, 2026-05-21 / 고도화 2026-07-14).
 *
 * sqlite ring buffer (data/logs.db) 조회 + 런타임 EnvFilter reload (ssh SIGHUP 대신 UI).
 * journalctl 실질 대체: 전문 검색(contains, ring 전체 LIKE) + 실시간 tail(since 폴링,
 * 탭 백그라운드 자동 일시정지) + target/module lists accumulated from rows already fetched.
 * 범위 = 조회 / 필터 / 검색 / tail 만 (대시보드 / 그래프 / 알림 X — observability paradox 룰).
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2, RefreshCw, Filter, Play, Pause } from 'lucide-react';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import { usePolling } from '../../../lib/hooks/use-polling';
import { logger } from '../../../lib/util/logger';
import { useTranslations } from '../../../lib/i18n';

interface LogEntry {
  tsMs: number;
  level: string;
  target: string;
  message: string;
  /** 실제 tracing target(모듈 경로) — EnvFilter directive 로 쓸 수 있는 유일한 이름. */
  module?: string;
}

/** EnvFilter 레벨 사다리 — 런타임 레벨 조립기의 선택지. */
const ENV_LEVELS = ['off', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'bg-red-100 text-red-700 border-red-200',
  WARN: 'bg-amber-100 text-amber-700 border-amber-200',
  INFO: 'bg-blue-50 text-blue-600 border-blue-200',
  DEBUG: 'bg-slate-100 text-slate-500 border-slate-200',
  TRACE: 'bg-slate-50 text-slate-400 border-slate-200',
};

/**
 * Size of the ONE sample taken to seed the target/module lists. Everything after that accumulates
 * from rows the table and the tail already fetched, so it costs nothing — refetching a large sample
 * to derive a handful of counts means shipping thousands of rows to learn ten numbers. Having the
 * database count them is the correct answer and is tracked separately; it needs a new call.
 */
const FACET_SAMPLE = 1000;
/** tail 중 화면에 쌓아둘 최대 줄 수 — 무한 누적 방지 (오래된 것부터 drop). */
const TAIL_MAX_ROWS = 1000;

export function LogPanel() {
  const t = useTranslations();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  // load 가 loadFacets 보다 위에 정의돼 있어 ref 로 잇는다(선언 순서 의존 없이).
  const loadFacetsRef = useRef<(() => Promise<void>) | null>(null);
  const mergeFacetsRef = useRef<((rows: LogEntry[]) => void) | null>(null);
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
  // 런타임 EnvFilter 는 **조립해서** 만든다 — 옛 자유입력은 모듈 경로를 외워야 해서 못 썼다
  // (사용자 2026-07-29: "뭘 적어야 할지를 모르잖아"). 기본 레벨 + 모듈별 오버라이드 → 문자열.
  const [baseLevel, setBaseLevel] = useState('info');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const filterStr = useMemo(
    () => [baseLevel, ...Object.entries(overrides).map(([m, lv]) => `${m}=${lv}`)].join(','),
    [baseLevel, overrides],
  );
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
        // Feed the lists from this response — no second request just for them.
        mergeFacetsRef.current?.(rows);
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
        mergeFacetsRef.current?.(rows);
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

  // The lists must not follow the query, for two separate reasons.
  //  · Not the filter: derived from the loaded entries, picking one target shrinks the list to that
  //    target, and there is no way back to the others.
  //  · Not the window: built from the newest thousand rows, a chatty target crowding it (measured:
  //    ws_stream held 925 of 1000) makes rarer ones vanish from the UI while still being in the log.
  // No backend work — the same query API, and a local admin-only sqlite makes it cheap.
  const [facets, setFacets] = useState<Array<{ target: string; count: number; warn: boolean }>>([]);
  /// EnvFilter 로 실제 켜고 끌 수 있는 대상 — 로그가 기록해 둔 모듈 경로에서 그대로 읽는다.
  /// 목록을 코드에 박지 않으므로 모듈이 늘면 UI 도 저절로 는다.
  const [modules, setModules] = useState<Array<{ module: string; count: number }>>([]);
  /**
   * Accumulate the lists from rows already in hand. Query and tail responses feed it, so no extra
   * request is made, and a target once seen stays listed even when a later query omits it — which
   * removes both failure modes above. The counts are therefore what this session observed, not a
   * statistic over the ring.
   */
  const mergeFacets = useCallback((rows: LogEntry[]) => {
    if (rows.length === 0) return;
    setFacets(prev => {
      const acc = new Map(prev.map(f => [f.target, { count: f.count, warn: f.warn }]));
      for (const e of rows) {
        const cur = acc.get(e.target) ?? { count: 0, warn: false };
        cur.count += 1;
        const lv = (e.level || '').toUpperCase();
        if (lv === 'WARN' || lv === 'ERROR') cur.warn = true;
        acc.set(e.target, cur);
      }
      return Array.from(acc, ([target, v]) => ({ target, ...v })).sort((a, b) => b.count - a.count);
    });
    setModules(prev => {
      const acc = new Map(prev.map(m => [m.module, m.count]));
      for (const e of rows) {
        if (e.module) acc.set(e.module, (acc.get(e.module) ?? 0) + 1);
      }
      return Array.from(acc, ([module, count]) => ({ module, count })).sort((a, b) => b.count - a.count);
    });
  }, []);
  const loadFacets = useCallback(async () => {
    try {
      const data = await apiGet<{ success?: boolean; entries?: LogEntry[] }>(
        `/api/logs?limit=${FACET_SAMPLE}`, { category: 'logs' },
      );
      if (data?.success) mergeFacets(data.entries ?? []);
    } catch { /* the lists are secondary — a failure here still leaves the query working */ }
  }, [mergeFacets]);
  loadFacetsRef.current = loadFacets;
  mergeFacetsRef.current = mergeFacets;
  // Only the first sample is fetched for its own sake; accumulation handles the rest.
  useEffect(() => { void loadFacets(); }, [loadFacets]);

  const applyFilter = useCallback(async () => {
    setFilterMsg(null);
    try {
      const data = await apiPost<{ success?: boolean; error?: string }>(
        '/api/logs',
        { filter: filterStr.trim() || 'info' },
        { category: 'logs' },
      );
      setFilterMsg(data?.success ? t('common.log_applied') : (data?.error || t('common.log_apply_failed')));
    } catch (e) {
      setFilterMsg(t('common.log_apply_failed'));
      logger.error('logs', '로그 필터 적용 실패', e);
    }
  }, [filterStr, t]);

  return (
    <div className="flex flex-col gap-4">
      {/* 런타임 로그 레벨 — EnvFilter 동적 reload */}
      <div className="flex flex-col gap-1.5 p-3 bg-slate-50 border border-slate-200 rounded-lg">
        <span className="text-xs sm:text-sm font-bold text-slate-700">{t('common.log_section_settings')}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold text-slate-600">{t('common.log_global_level')}</span>
          {ENV_LEVELS.map(lv => (
            <button key={lv} type="button" onClick={() => setBaseLevel(lv)}
              className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                baseLevel === lv
                  // `off` records nothing, so it cannot look like the other five. Selected blue on a
                  // level ladder reads as "this much and up"; on `off` that reads as "everything".
                  ? lv === 'off'
                    ? 'bg-slate-700 text-white border-slate-700 font-bold'
                    : 'bg-blue-600 text-white border-blue-600 font-bold'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
              {lv === 'off' ? t('common.log_level_off') : lv}
            </button>
          ))}
        </div>
        {modules.length > 0 && (
          <div className="flex flex-col gap-1">
            {/* One list to pick from, and a row per raised module: the panel does not fill up as
                modules multiply, and what is overridden reads at a glance. Each carries its OWN full
                ladder — an override is independent of the global level in both directions, so a noisy
                target can be turned down to warn while everything else stays at info. */}
            <span className="text-[11px] font-semibold text-slate-600">{t('common.log_module_levels')}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label={t('common.log_module_add')}
                value=""
                onChange={e => {
                  const m = e.target.value;
                  if (m) setOverrides(o => ({ ...o, [m]: 'debug' }));
                }}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] font-mono max-w-[260px]"
              >
                <option value="">{t('common.log_module_add')}</option>
                {modules.filter(m => !overrides[m.module]).map(m => (
                  <option key={m.module} value={m.module}>{m.module} ({m.count})</option>
                ))}
              </select>
              {Object.keys(overrides).length === 0 ? (
                // The empty state is a value, not a blank: "모듈 추가" alone left it unclear whether
                // some default was already in effect.
                <span className="px-2 py-1 rounded-md text-[11px] font-mono border bg-white text-slate-400 border-slate-200">
                  {t('common.log_module_none')}
                </span>
              ) : (
                Object.entries(overrides).map(([mod, lv]) => (
                  <span key={mod}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md text-[11px] font-mono border bg-amber-50 text-amber-800 border-amber-300">
                    <span className="font-bold">{mod.split('::').slice(-2).join('::')}</span>
                    <select
                      aria-label={mod}
                      value={lv}
                      onChange={e => setOverrides(o => ({ ...o, [mod]: e.target.value }))}
                      className="px-1 py-0.5 bg-white border border-amber-300 rounded text-[11px] font-mono text-amber-900"
                    >
                      {ENV_LEVELS.map(l => (
                        <option key={l} value={l}>{l === 'off' ? t('common.log_level_off') : l}</option>
                      ))}
                    </select>
                    <button type="button" aria-label={`${mod} ${t('common.log_module_remove')}`}
                      title={t('common.log_module_remove')}
                      onClick={() => setOverrides(o => { const n = { ...o }; delete n[mod]; return n; })}
                      className="px-1 text-amber-600 hover:text-amber-900">×</button>
                  </span>
                ))
              )}
            </div>
          </div>
        )}
        <div className="flex gap-2 items-center">
          {/* 조립 결과를 그대로 보여준다 — 무엇이 적용되는지 숨기지 않는다. */}
          <code className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] font-mono text-slate-600 overflow-x-auto whitespace-nowrap">
            {filterStr}
          </code>
          <button
            type="button"
            onClick={applyFilter}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-bold rounded-lg flex items-center gap-1.5"
          >
            <Filter size={13} /> {t('common.log_apply')}
          </button>
        </div>
        {filterMsg && <span className="text-[11px] text-slate-500">{filterMsg}</span>}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs sm:text-sm font-bold text-slate-700">{t('common.log_section_query')}</span>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="log-min-level" className="text-[11px] font-semibold text-slate-600">{t('common.log_level_filter')}</label>
            <select
              id="log-min-level"
              name="minLevel"
              value={minLevel}
              onChange={e => setMinLevel(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {/* Ordered loudest-first, and every entry says "and above" so the axis is unmistakable.
                  There is no TRACE row because TRACE is the bottom rank — "TRACE and above" is every
                  row, which is what the first option already is; hence its label names trace. */}
              <option value="">{t('common.log_level_all')}</option>
              {['ERROR', 'WARN', 'INFO', 'DEBUG'].map(lv => (
                <option key={lv} value={lv}>{t('common.log_level_at_least', { level: lv })}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 w-full order-last">
            <label className="text-[11px] font-semibold text-slate-600">
              target{targetPrefix && <span className="font-normal text-slate-400"> · {targetPrefix}</span>}
            </label>
            {/* Pick from what exists rather than typing a remembered name. Laying every value out as
                a chip filled the panel as targets multiplied, and the names overlapped the module list
                above it so the two read as the same thing shown twice — they are in fact two axes of
                one query: this one filters the view, that one raises the collection level. Ordered by
                count with a dot on anything carrying warnings, so "where should I look" reads out of
                the list itself. */}
            <select
              aria-label="target"
              value={targetPrefix}
              onChange={e => setTargetPrefix(e.target.value)}
              className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] font-mono"
            >
              <option value="">{t('common.log_all')}</option>
              {facets.map(f => (
                <option key={f.target} value={f.target}>
                  {f.warn ? '● ' : ''}{f.target} ({f.count})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
            <label htmlFor="log-contains" className="text-[11px] font-semibold text-slate-600">{t('common.log_search')}</label>
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
            <label htmlFor="log-limit" className="text-[11px] font-semibold text-slate-600">{t('common.log_count')}</label>
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
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {t('common.log_query')}
          </button>
          <button
            type="button"
            onClick={() => (tail ? setTail(false) : startTail())}
            className={`px-3 py-1.5 text-[13px] font-bold rounded-lg flex items-center gap-1.5 border ${
              tail
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600'
                : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300'
            }`}
          >
            {tail ? <Pause size={13} /> : <Play size={13} />} {tail ? t('common.log_live_on') : t('common.log_live')}
          </button>
        </div>
      </div>

      {/* 로그 목록 */}
      <div className="flex flex-col gap-1 max-h-[50vh] overflow-y-auto border border-slate-200 rounded-lg p-2 bg-white">
        {entries.length === 0 ? (
          <div className="text-center py-8 text-[13px] text-slate-400">
            {loading ? t('common.log_loading') : tail ? t('common.log_waiting') : t('common.log_empty')}
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

'use client';

/**
 * LogPanel — the log tab in admin settings.
 *
 * Reads the sqlite ring buffer (data/logs.db) and reloads the runtime EnvFilter from the UI instead
 * of an ssh SIGHUP. Stands in for journalctl: full-text search across the whole ring, a live tail
 * (2s polling, auto-paused while the tab is in the background), and target/module lists counted
 * server-side. Scope is query / filter / search / tail only — no dashboards, graphs or alerts.
 */
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2, RefreshCw, Play, Pause } from 'lucide-react';
import { apiGet, apiPost } from '../../../lib/api-fetch';
import { usePolling } from '../../../lib/hooks/use-polling';
import { logger } from '../../../lib/util/logger';
import { SaveButton, type SaveButtonState } from './SaveButton';
import { useTranslations } from '../../../lib/i18n';

interface LogEntry {
  tsMs: number;
  level: string;
  target: string;
  message: string;
  /** The real tracing target (module path) — the only name an EnvFilter directive accepts. */
  module?: string;
}

/** The EnvFilter level ladder — the choices the runtime level builder offers. */
const ENV_LEVELS = ['off', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * Dependency crates pinned to warn whenever the global level goes below info.
 *
 * A bare `debug` in EnvFilter is global in the literal sense — it turns on the HTTP/2 and connection
 * pool internals too. Measured 2026-07-31: one hour at debug wrote 4,639 h2 frame lines and cut the
 * 20,000-line ring from nine days of history down to about an hour. None of it is ours and none of it
 * has ever answered a question here, so raising OUR level must not raise theirs.
 */
const NOISY_DEPS = ['h2', 'hyper', 'hyper_util', 'tonic', 'tower', 'rustls', 'reqwest'] as const;

const LEVEL_COLOR: Record<string, string> = {
  ERROR: 'bg-red-100 text-red-700 border-red-200',
  WARN: 'bg-amber-100 text-amber-700 border-amber-200',
  INFO: 'bg-blue-50 text-blue-600 border-blue-200',
  DEBUG: 'bg-slate-100 text-slate-500 border-slate-200',
  TRACE: 'bg-slate-50 text-slate-400 border-slate-200',
};

/** Rows the tail keeps on screen — bounded so it cannot grow forever (oldest drop first). */
const TAIL_MAX_ROWS = 1000;

export function LogPanel() {
  const t = useTranslations();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  // load is defined above loadState, so a ref links them without depending on declaration order.
  const loadFacetsRef = useRef<(() => Promise<void>) | null>(null);
  const [minLevel, setMinLevel] = useState('');
  const [targetPrefix, setTargetPrefix] = useState('');
  const [contains, setContains] = useState('');
  // Kept as a string so the box can be emptied while typing; clamped to 1..2000 only at query time.
  // (A numeric state with `Number("")||50` snapped back to 50 the moment "50" lost a digit, which
  // made 200 impossible to type.)
  const [limit, setLimit] = useState('50');
  const [loading, setLoading] = useState(false);
  // Live tail, the equivalent of journalctl -f. Polling on a since cursor (2s) is robust without
  // any SSE wiring, and usePolling pauses it while the tab is in the background. New rows are
  // prepended, which keeps the newest-first view without any scroll anchoring.
  const [tail, setTail] = useState(false);
  // The runtime EnvFilter, applied from the UI instead of an ssh `kill -HUP` — no rebuild, no
  // restart. It is ASSEMBLED rather than typed: the old free-text box required remembering module
  // paths, so it went unused ("you don't know what to write in it"). Global level + per-module
  // overrides compose the directive.
  const [baseLevel, setBaseLevel] = useState('info');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const filterStr = useMemo(() => {
    const parts: string[] = [baseLevel];
    // Only below info — at info and above the dependency crates are already quiet, and pinning them
    // then would just be noise in the directive the user reads.
    if (baseLevel === 'debug' || baseLevel === 'trace') {
      parts.push(...NOISY_DEPS.map(d => `${d}=warn`));
    }
    parts.push(...Object.entries(overrides).map(([m, lv]) => `${m}=${lv}`));
    return parts.join(',');
  }, [baseLevel, overrides]);
  // The button carries its own result, like every other action button in settings — no separate
  // element to notice, and it returns to idle on its own instead of leaving text on screen.
  const [applyState, setApplyState] = useState<SaveButtonState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (applyTimer.current) clearTimeout(applyTimer.current); }, []);
  // Tail cursor — the newest ts seen, so each poll asks only for what is after it. A ref rather
  // than state so consecutive ticks cannot race.
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
      logger.error('logs', 'log query failed', e);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // One query on entering the tab.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live tail — only rows newer than the cursor, prepended. The query conditions still apply.
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
        logger.debug('logs', 'tail poll failed', { error: e });
      }
    },
  });

  const startTail = useCallback(() => {
    // Start the cursor at now, so the tail carries only what arrives from here on (the past is
    // what the query button is for).
    if (lastTsRef.current === 0) lastTsRef.current = Date.now();
    setTail(true);
  }, []);

  // The lists count the WHOLE ring, server-side (GROUP BY), not the rows a query happened to return.
  // Accumulating client-side made the dropdown mean "what is on screen": a target only appeared once
  // the row count was raised far enough to catch it, and the counts were session observations rather
  // than facts. Shipping 20,000 rows to count ten names was also the wrong way round.
  const [facets, setFacets] = useState<Array<{ target: string; count: number; warn: boolean }>>([]);
  /// What an EnvFilter directive can actually address, read from the module paths the logs recorded.
  /// Nothing is hardcoded, so the UI grows by itself as modules are added.
  const [modules, setModules] = useState<Array<{ module: string; count: number }>>([]);
  /**
   * One call for everything the panel cannot know on its own: the filter the server is actually
   * running and the ring-wide counts. Without the filter the panel drew its own default, so a level
   * raised minutes earlier read as reverted when the tab was reopened — it had not been (2026-07-31:
   * the server was at debug the whole time, and the debug rows were in the ring).
   */
  const loadState = useCallback(async () => {
    try {
      const data = await apiGet<{
        success?: boolean;
        filter?: string;
        targets?: Array<{ name: string; count: number | string; warnCount?: number | string }>;
        modules?: Array<{ name: string; count: number | string }>;
      }>('/api/logs?state=1', { category: 'logs' });
      if (!data?.success) return;
      setFacets(
        (data.targets ?? []).map(f => ({
          target: f.name,
          count: Number(f.count) || 0,
          warn: Number(f.warnCount ?? 0) > 0,
        })),
      );
      setModules((data.modules ?? []).map(m => ({ module: m.name, count: Number(m.count) || 0 })));
      // Split the directive back into the two controls. Anything that is not `name=level` is the
      // global level; dependency pins are re-derived from the global level, so they are dropped here
      // rather than shown as if the user had set them.
      const parts = (data.filter ?? '').split(',').map(p => p.trim()).filter(Boolean);
      const next: Record<string, string> = {};
      let base = '';
      for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) { if (!base) base = p; continue; }
        const name = p.slice(0, eq);
        if ((NOISY_DEPS as readonly string[]).includes(name)) continue;
        next[name] = p.slice(eq + 1);
      }
      if (base) setBaseLevel(base);
      setOverrides(next);
    } catch { /* the lists are secondary — a failure here still leaves the query working */ }
  }, []);
  loadFacetsRef.current = loadState;
  useEffect(() => { void loadState(); }, [loadState]);

  const applyFilter = useCallback(async () => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
    setApplyError(null);
    setApplyState('saving');
    try {
      const data = await apiPost<{ success?: boolean; error?: string }>(
        '/api/logs',
        { filter: filterStr.trim() || 'info' },
        { category: 'logs' },
      );
      const ok = Boolean(data?.success);
      setApplyState(ok ? 'saved' : 'error');
      // A rejected directive says WHY, and that message has to stay long enough to read — the button
      // alone would return to idle and leave the filter silently unapplied.
      if (!ok) setApplyError(data?.error ?? null);
      applyTimer.current = setTimeout(() => setApplyState('idle'), ok ? 1500 : 4000);
    } catch (e) {
      setApplyState('error');
      applyTimer.current = setTimeout(() => setApplyState('idle'), 4000);
      logger.error('logs', 'log filter apply failed', e);
    }
  }, [filterStr]);

  return (
    <div className="flex flex-col gap-4">
      {/* Runtime log level — reloads the EnvFilter in place. */}
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
                // The empty state is a value, not a blank: the add-module control alone left it
                // unclear whether some default was already in effect.
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
          {/* Show the assembled directive verbatim — never hide what is about to be applied. */}
          <code className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] font-mono text-slate-600 overflow-x-auto whitespace-nowrap">
            {filterStr}
          </code>
          <SaveButton
            size="md"
            state={applyState}
            label={t('common.log_apply')}
            onClick={applyFilter}
          />
        </div>
        {applyState === 'error' && applyError && (
          <span className="text-[11px] text-red-600">{applyError}</span>
        )}
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

      {/* The rows. */}
      <div className="flex flex-col gap-1 max-h-[50vh] overflow-y-auto border border-slate-200 rounded-lg p-2 bg-white">
        {entries.length === 0 ? (
          <div className="text-center py-8 text-[13px] text-slate-400">
            {loading ? t('common.log_loading') : tail ? t('common.log_waiting') : t('common.log_empty')}
          </div>
        ) : (
          entries.map((e, i) => (
            <div key={`${e.tsMs}-${i}`} className="flex flex-col gap-0.5 py-1.5 border-b border-slate-50 last:border-0 text-[12px] font-mono">
              {/* Meta on one line (time, level, target); the message takes the next line at full
                  width, so a long target name cannot make the column ragged. */}
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

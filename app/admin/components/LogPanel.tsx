'use client';

/**
 * LogPanel — admin 설정 로그 탭 (로그 시스템 Phase 5, 2026-05-21 / 고도화 2026-07-14).
 *
 * sqlite ring buffer (data/logs.db) 조회 + 런타임 EnvFilter reload (ssh SIGHUP 대신 UI).
 * journalctl 실질 대체: 전문 검색(contains, ring 전체 LIKE) + 실시간 tail(since 폴링,
 * 탭 백그라운드 자동 일시정지) + target·모듈 목록(조회 조건·창 크기와 독립인 별 표본에서 파생).
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
 * 목록(target·모듈)의 **첫 표본**만 이 크기로 받는다. 그 뒤로는 조회·tail 응답에서 누적하므로
 * 추가 비용이 없다 — 매번 큰 표본을 받아 다시 세는 것은 10개 카운트를 얻으려 수만 행을 실어
 * 오는 낭비다(사용자 2026-07-30). 정확한 해법은 SQL 이 세는 것(`GROUP BY target` → 10행)인데
 * 그건 proto·코어까지 붙는 별 작업이라 트래커에 남겼다.
 */
const FACET_SAMPLE = 1000;
/** tail 중 화면에 쌓아둘 최대 줄 수 — 무한 누적 방지 (오래된 것부터 drop). */
const TAIL_MAX_ROWS = 1000;

export function LogPanel() {
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
        // 목록은 이 응답에서 누적한다 — 목록만을 위한 두 번째 요청은 보내지 않는다.
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

  // target·모듈 목록 — 두 가지 이유로 **조회와 독립**이다.
  //  · 필터와 독립: 화면에 로드된 엔트리에서 파생하면 `ai` 로 거르는 순간 목록이 `ai` 하나로
  //    쪼그라들어 다음 target 으로 넘어갈 수가 없다.
  //  · 창 크기와 독립: 1000건으로 뽑던 옛 코드는 빈발 target 하나가 그 창을 다 먹으면
  //    (실측: ws_stream 925/1000) 드물게 찍히는 target 이 목록에서 사라져, 로그에는 있는데
  //    UI 에는 없는 상태가 됐다("아까는 page_binding 이 있었는데 지금은 안 보이노").
  // 백엔드 0(같은 조회 API 를 조건 없이 한 번 더) — admin 전용 로컬 sqlite 라 값싸다.
  const [facets, setFacets] = useState<Array<{ target: string; count: number; warn: boolean }>>([]);
  /// EnvFilter 로 실제 켜고 끌 수 있는 대상 — 로그가 기록해 둔 모듈 경로에서 그대로 읽는다.
  /// 목록을 코드에 박지 않으므로 모듈이 늘면 UI 도 저절로 는다.
  const [modules, setModules] = useState<Array<{ module: string; count: number }>>([]);
  /**
   * 이미 받은 줄에서 목록을 **누적**한다. 조회·tail 응답을 그대로 먹이므로 추가 요청이 없고,
   * 한 번 본 target 은 다음 조회가 그것을 안 담아도 목록에 남는다 — 필터를 바꾸다 목록이
   * 쪼그라들거나, 빈발 target 에 밀려 사라지는 문제가 둘 다 사라진다.
   * 카운트는 그래서 "이 세션에서 관측한 수"다(ring 전체 통계가 아니다).
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
    } catch { /* 목록은 보조 — 실패해도 조회는 된다 */ }
  }, [mergeFacets]);
  loadFacetsRef.current = loadFacets;
  mergeFacetsRef.current = mergeFacets;
  // 첫 표본만 따로 받는다 — 그 뒤 갱신은 조회·tail 응답 누적이 맡는다.
  useEffect(() => { void loadFacets(); }, [loadFacets]);

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
          기본 레벨을 고르고, 더 자세히 볼 모듈만 따로 올립니다 — 이름을 외워서 적을 필요 없이 실제 로그에 찍힌 모듈에서 고릅니다.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold text-slate-600">기본</span>
          {ENV_LEVELS.map(lv => (
            <button key={lv} type="button" onClick={() => setBaseLevel(lv)}
              className={`px-2 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                baseLevel === lv ? 'bg-blue-600 text-white border-blue-600 font-bold'
                                 : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
              {lv}
            </button>
          ))}
        </div>
        {modules.length > 0 && (
          <div className="flex flex-col gap-1">
            {/* 고르는 곳은 리스트 하나, 켜 둔 것만 뱃지로 남긴다 — 모듈이 늘어도 화면이 안 덮이고
                "지금 무엇이 올라가 있나"가 한눈에 보인다. */}
            <span className="text-[11px] font-semibold text-slate-600">모듈별로 더 자세히 (선택)</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label="자세히 볼 모듈"
                value=""
                onChange={e => {
                  const m = e.target.value;
                  if (m) setOverrides(o => ({ ...o, [m]: 'debug' }));
                }}
                className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] font-mono max-w-[260px]"
              >
                <option value="">모듈 고르기…</option>
                {modules.filter(m => !overrides[m.module]).map(m => (
                  <option key={m.module} value={m.module}>{m.module} ({m.count})</option>
                ))}
              </select>
              {Object.keys(overrides).length === 0
                ? <span className="text-[11px] text-slate-400">고르면 debug 로 올립니다</span>
                : Object.entries(overrides).map(([mod, lv]) => (
                    <span key={mod}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono border bg-amber-500 text-white border-amber-500 font-bold">
                      <button type="button" title="debug ↔ trace"
                        onClick={() => setOverrides(o => ({ ...o, [mod]: o[mod] === 'debug' ? 'trace' : 'debug' }))}>
                        {mod.split('::').slice(-2).join('::')} = {lv}
                      </button>
                      <button type="button" aria-label={`${mod} 해제`} title="해제"
                        onClick={() => setOverrides(o => { const n = { ...o }; delete n[mod]; return n; })}
                        className="opacity-80 hover:opacity-100">×</button>
                    </span>
                  ))}
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
        <div className="flex flex-col gap-1 w-full order-last">
          <label className="text-[11px] font-semibold text-slate-600">
            target <span className="font-normal text-slate-400">— 괄호는 관측 건수</span>
            {targetPrefix && <span className="font-normal text-slate-400"> · {targetPrefix}</span>}
          </label>
          {/* 이름을 외워서 치는 대신 **있는 것 중에 고른다**. 칩을 전부 늘어놓던 옛 UI 는 target 이
              늘수록 화면을 덮었고, 위쪽 "모듈별로 더 자세히" 와 이름이 겹쳐 같은 것을 두 번
              보여주는 것처럼 읽혔다(둘은 사실 같은 조회에서 뽑은 두 축 — 아래는 필터, 위는 수집
              레벨). 건수 순으로 정렬하고 경고·에러가 섞인 것은 점을 붙여, "어디를 봐야 하나"는
              목록 안에서 읽히게 둔다. */}
          <select
            aria-label="target 필터"
            value={targetPrefix}
            onChange={e => setTargetPrefix(e.target.value)}
            className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-[12px] font-mono"
          >
            <option value="">전체</option>
            {facets.map(f => (
              <option key={f.target} value={f.target}>
                {f.warn ? '● ' : ''}{f.target} ({f.count})
              </option>
            ))}
          </select>
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

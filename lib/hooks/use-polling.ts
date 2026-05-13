/**
 * usePolling — interval-based polling hook. Phase 9 정공 (2026-05-13).
 *
 * 옛 산재된 setInterval + fetch + useEffect cleanup boilerplate 통합.
 * 자동 visibility 처리 — 탭 백그라운드 시 polling 자동 일시정지 (배터리 / 비용 절감).
 *
 * React Query 의 refetchInterval 이 대안이지만, polling 만 필요한 경우 (UI state 없이 side effect)
 * 본 hook 이 더 가벼움.
 *
 * 사용:
 *   usePolling({
 *     interval: 5000,
 *     onTick: async () => { const data = await fetch(...); doSomething(data); },
 *     enabled: !!session,
 *   });
 */

'use client';

import { useEffect, useRef } from 'react';

interface UsePollingOpts {
  /** 폴링 간격 (ms). */
  interval: number;
  /** 매 tick 호출 함수. async OK. */
  onTick: () => void | Promise<void>;
  /** false 면 polling 일시정지. condition 동적 변경 시 자동 재시작. */
  enabled?: boolean;
  /** 첫 tick 즉시 실행 여부 (기본 true). false 면 첫 tick = interval 후. */
  fireImmediately?: boolean;
  /** 탭 백그라운드 시 polling 일시정지 (기본 true). 배터리 / API 비용 절감. */
  pauseOnHidden?: boolean;
}

export function usePolling(opts: UsePollingOpts): void {
  const { interval, onTick, enabled = true, fireImmediately = true, pauseOnHidden = true } = opts;
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      void onTickRef.current();
    };
    const start = () => {
      if (timer != null) return;
      if (fireImmediately) tick();
      timer = setInterval(tick, interval);
    };
    const stop = () => {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    };

    const handleVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) stop();
      else start();
    };

    if (pauseOnHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
      if (!document.hidden) start();
    } else {
      start();
    }

    return () => {
      cancelled = true;
      stop();
      if (pauseOnHidden && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [interval, enabled, fireImmediately, pauseOnHidden]);
}

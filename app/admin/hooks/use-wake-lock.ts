/**
 * useWakeLock — 모바일 브라우저 화면 자동 잠금 방지.
 *
 * 사용처: AI 응답 중에 화면이 꺼지면 SSE 연결이 throttle 또는 drop 되어
 *   응답이 실종되거나 "로봇 사라짐" 증상 발생. chat 페이지 박힌 동안 화면 켜둠.
 *
 * 동작:
 *  - active=true 동안 `navigator.wakeLock.request('screen')` 1회 호출
 *  - visibility hidden → visible 복귀 시 sentinel.released 확인 후 재acquire
 *  - 옛 `96f8030` 안 release event listener + 즉시 재acquire 박은 영역 폐기 — 모바일
 *    background throttle 시점 OS 가 release → 재acquire reject (영구 reject 가능) →
 *    silent catch → 영구 미박힘 root cause. 옛 `f6941bb` (node 시점 동작 영역) 단순
 *    영역 복원.
 *
 * 지원: iOS Safari 16.4+, Android Chrome/Firefox 등 모던 브라우저.
 * 제약: HTTPS / secure context. 미지원 환경 no-op.
 */
'use client';

import { useEffect } from 'react';

interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
}

interface NavigatorWakeLock {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined') return;
    const wakeLockApi = (navigator as Navigator & { wakeLock?: NavigatorWakeLock }).wakeLock;
    if (!wakeLockApi) return;

    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const acquire = async () => {
      try {
        const got = await wakeLockApi.request('screen');
        if (disposed) {
          try { await got.release(); } catch {}
          return;
        }
        sentinel = got;
      } catch { /* 권한 / secure context / OS 영역 reject — 조용히 skip */ }
    };

    const onVisibility = () => {
      // visibility hidden → 브라우저 자동 release → released=true 박힘.
      // visible 복귀 시 released 박힌 영역 재acquire. 옛 commit `96f8030` 안 release
      // event listener 박은 영역 = 즉시 재acquire → OS 일관 reject 영구 미박힘 root cause.
      // 본 영역 = visibility 변경 시점에만 재acquire — OS 안 user-initiated 영역 박혀
      // 재acquire 박힘.
      if (document.visibilityState === 'visible' && !disposed && (!sentinel || sentinel.released)) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel && !sentinel.released) {
        void sentinel.release().catch(() => {});
      }
      sentinel = null;
    };
  }, [active]);
}

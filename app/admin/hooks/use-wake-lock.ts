/**
 * useWakeLock — 모바일 브라우저 화면 자동 잠금 방지.
 *
 * 사용처: AI 응답 중에 화면이 꺼지면 SSE 연결이 throttle 또는 drop 되어
 *   응답이 실종되거나 "로봇 사라짐" 증상 발생. 응답 중엔 화면 켜둠.
 *
 * 동작:
 *  - active=true 동안 `navigator.wakeLock.request('screen')` 유지
 *  - active=false / 언마운트 / 탭 숨김 → release
 *  - 탭 다시 보이면 active 상태면 재획득 (visibilitychange)
 *
 * 지원: iOS Safari 16.4+, Android Chrome/Firefox 등 대부분 모던 브라우저
 * 제약: HTTPS 필요, secure context. PC 브라우저에서도 동작하지만 사용자 입력 없이 오래 유지 시 일부 OS 가 해제.
 *
 * 폴백: Wake Lock API 미지원 환경에선 조용히 no-op (에러 throw 없음).
 */
'use client';

import { useEffect } from 'react';

// Wake Lock API 타입 — TS 기본 타입에 빠져있어 수동 정의
interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

interface NavigatorWakeLock {
  request(type: 'screen'): Promise<WakeLockSentinel>;
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined') return;
    const wakeLockApi = (navigator as Navigator & { wakeLock?: NavigatorWakeLock }).wakeLock;
    if (!wakeLockApi) return; // 미지원 환경 — 조용히 pass

    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const acquire = async () => {
      try {
        const got = await wakeLockApi.request('screen');
        if (disposed) {
          try { await got.release(); } catch { /* 이미 해제 */ }
          return;
        }
        sentinel = got;
      } catch { /* 권한 거부·secure context 미충족 등 — 조용히 skip */ }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinel && !disposed) {
        // 탭 복귀 시 재획득 — 숨김 상태에서 브라우저가 자동 해제하기 때문
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

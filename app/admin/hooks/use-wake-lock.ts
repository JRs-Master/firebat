/**
 * useWakeLock — 모바일 브라우저 화면 자동 잠금 방지.
 *
 * 사용처: AI 응답 중에 화면이 꺼지면 SSE 연결이 throttle 또는 drop 되어
 *   응답이 실종되거나 "로봇 사라짐" 증상 발생. chat 페이지 활성 동안 화면 켜둠.
 *
 * 동작:
 *  - active=true 동안 `navigator.wakeLock.request('screen')` 1회 호출
 *  - visibility hidden → visible 복귀 시 sentinel.released 확인 후 재acquire
 *
 * 진단 계측 (2026-05-23): "응답 중에도 화면이 꺼진다" 증상의 root cause 추적.
 *   답변을 보는 동안 페이지는 계속 visible 이므로 재acquire 경로는 무관 — 최초
 *   acquire 의 request('screen') 가 거부(reject)되고 catch 가 삼키는지가 핵심 의심.
 *   acquire 성공/실패(사유)/release/visibility 를 logger.warn 으로 기록 → 브라우저
 *   error/warn 은 `/api/log` 로 전송돼 firebat-frontend journalctl 에 합류 (로그 Phase 2).
 *   실제 폰 재현 후 journalctl 에서 reject 사유 확인. root cause 확정 후 success/visibility
 *   계측은 debug 로 내릴 수 있음 (failure 만 warn 유지가 정공).
 *
 * 지원: iOS Safari 16.4+, Android Chrome/Firefox 등 모던 브라우저.
 * 제약: HTTPS / secure context. 미지원 환경 no-op. 배터리 절전 모드 시 OS 가 거부 가능.
 */
'use client';

import { useEffect } from 'react';
import { logger } from '../../../lib/util';

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
    if (!wakeLockApi) {
      logger.warn('wakelock', 'wakeLock API 미지원 — 화면 켜둠 불가 (no-op)', {
        secure: typeof window !== 'undefined' ? window.isSecureContext : undefined,
      });
      return;
    }

    let sentinel: WakeLockSentinel | null = null;
    let disposed = false;

    const onRelease = () => {
      // OS / 브라우저가 lock 을 해제한 시점. visible 중에 이게 찍히면 = "잡았는데 OS 가 선점
      // 해제" → request reject 가 아니라 다른 root cause. hidden 전환 자동 release 와 구분 위해
      // visibilityState 같이 기록.
      logger.warn('wakelock', 'wake lock release 이벤트', {
        visibility: typeof document !== 'undefined' ? document.visibilityState : undefined,
        disposed,
      });
    };

    const acquire = async () => {
      try {
        const got = await wakeLockApi.request('screen');
        if (disposed) {
          try { await got.release(); } catch {}
          return;
        }
        sentinel = got;
        try { got.addEventListener('release', onRelease); } catch {}
        logger.warn('wakelock', 'wake lock acquire 성공', {
          visibility: typeof document !== 'undefined' ? document.visibilityState : undefined,
        });
      } catch (e) {
        // ← 핵심 의심 지점. 옛 catch {} 가 삼키던 reject 사유를 노출.
        const err = e as { name?: string; message?: string };
        logger.warn('wakelock', 'wake lock acquire 실패 (request reject) — 화면 꺼짐 원인 후보', {
          errName: err?.name,
          errMessage: err?.message,
          visibility: typeof document !== 'undefined' ? document.visibilityState : undefined,
        });
      }
    };

    const onVisibility = () => {
      // visibility hidden → 브라우저 자동 release → released=true.
      // visible 복귀 시 released 면 재acquire. user-initiated 컨텍스트라 OS reject 회피.
      if (document.visibilityState === 'visible' && !disposed && (!sentinel || sentinel.released)) {
        logger.warn('wakelock', 'visible 복귀 → 재acquire 시도', {});
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel && !sentinel.released) {
        try { sentinel.removeEventListener('release', onRelease); } catch {}
        void sentinel.release().catch(() => {});
      }
      sentinel = null;
    };
  }, [active]);
}

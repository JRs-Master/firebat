'use client';

/**
 * Admin route error boundary — admin tree 의 client-side throw 격리.
 *
 * 박지 않으면 admin 안의 어떤 throw 든 root global-error.tsx 까지 bubble up →
 * "치명적인 오류" 풀스크린 → admin 통째 사용 불가. 박아두면 admin tree 만 reset 가능.
 *
 * UX 정책: (user)/error.tsx 와 동일 룰.
 *  - digest 있음 (server-side throw) 또는 ChunkLoadError → 1회 자동 reload (sessionStorage 가드)
 *  - 그 외 → reset / 새로고침 버튼만 (사용자 selection)
 *  - 콘솔에 error stack 출력 — 진단용
 */
import { useEffect, useState } from 'react';

const RELOAD_KEY = 'firebat_admin_error_reloads';
const MAX_AUTO_RELOAD = 1;

function isTransientError(err: Error & { digest?: string }): boolean {
  if (err?.digest) return true;
  if (err?.name === 'ChunkLoadError') return true;
  return false;
}

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [autoReloadIn, setAutoReloadIn] = useState<number | null>(null);
  const transient = isTransientError(error);

  useEffect(() => {
    console.error('[admin/error]', error);
    if (!transient) return;
    let count = 0;
    try { count = parseInt(sessionStorage.getItem(RELOAD_KEY) ?? '0', 10) || 0; } catch {}
    if (count >= MAX_AUTO_RELOAD) return;
    setAutoReloadIn(3);
    const tick = setInterval(() => {
      setAutoReloadIn(prev => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(tick);
          try { sessionStorage.setItem(RELOAD_KEY, String(count + 1)); } catch {}
          window.location.reload();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [error, transient]);

  const cancelAutoReload = () => setAutoReloadIn(null);
  const reloadNow = () => {
    try {
      const count = parseInt(sessionStorage.getItem(RELOAD_KEY) ?? '0', 10) || 0;
      sessionStorage.setItem(RELOAD_KEY, String(count + 1));
    } catch {}
    window.location.reload();
  };

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4 bg-white">
      <div className="text-center max-w-md">
        {transient ? (
          <>
            <div className="text-4xl mb-2">🔄</div>
            <h2 className="text-lg font-bold text-slate-900 m-0">
              일시적인 문제가 발생했어요
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              {autoReloadIn !== null
                ? `${autoReloadIn}초 후 자동으로 페이지를 다시 불러옵니다...`
                : '페이지를 다시 불러오면 해결됩니다.'}
            </p>
            <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
              <button
                onClick={reloadNow}
                className="px-3 py-1.5 text-sm font-bold bg-blue-500 hover:bg-blue-600 text-white rounded cursor-pointer border-0"
              >
                지금 새로고침
              </button>
              {autoReloadIn !== null && (
                <button
                  onClick={cancelAutoReload}
                  className="px-3 py-1.5 text-sm font-medium bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded cursor-pointer"
                >
                  취소
                </button>
              )}
            </div>
            {error.digest && (
              <p className="mt-3 text-[11px] font-mono text-slate-400">
                오류 ID: {error.digest}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="text-5xl font-extrabold text-red-600 leading-none mb-2">!</div>
            <h2 className="text-lg font-bold text-slate-900 m-0">
              어드민 영역에서 문제가 발생했어요
            </h2>
            <p className="mt-2 text-sm text-slate-500 break-words">
              {error.message || '알 수 없는 오류'}
            </p>
            {error.digest && (
              <p className="mt-1 text-[11px] font-mono text-slate-400">
                오류 ID: {error.digest}
              </p>
            )}
            <div className="mt-4 flex items-center justify-center gap-2 flex-wrap">
              <button
                onClick={() => reset()}
                className="px-3 py-1.5 text-sm font-bold bg-blue-500 hover:bg-blue-600 text-white rounded cursor-pointer border-0"
              >
                다시 시도
              </button>
              <button
                onClick={reloadNow}
                className="px-3 py-1.5 text-sm font-medium bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded cursor-pointer"
              >
                새로고침
              </button>
              <a
                href="/login"
                className="px-3 py-1.5 text-sm font-medium bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded no-underline"
              >
                로그아웃
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

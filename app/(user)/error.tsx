'use client';

/**
 * User 영역 error boundary — 페이지 렌더 중 throw 발생 시 표시 (500).
 *
 * 'use client' 필수 — Next.js error.tsx 규칙. (user) layout 의 header/footer 자동 적용.
 * design tokens 통합. reset() 호출 시 페이지 재시도.
 *
 * Transient error (Server Action stale / ChunkLoadError) 는 자동 hard reload 시도
 * — Next.js 빌드 직후 client RSC payload stale 시 흔히 발생. 무한 루프 방어 sessionStorage 카운터.
 * 그 외 진짜 에러는 기존 "다시 시도 / 홈으로" UX 유지.
 */
import { useEffect, useState } from 'react';

const RELOAD_KEY = 'firebat_uerror_reloads';
const MAX_AUTO_RELOAD = 1;

function isTransientError(err: Error): boolean {
  const msg = String(err?.message ?? '');
  const name = String(err?.name ?? '');
  return (
    msg.includes('Failed to find Server Action') ||
    msg.includes('ChunkLoadError') ||
    name === 'ChunkLoadError' ||
    msg.includes('Loading chunk') ||
    msg.includes('Loading CSS chunk')
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [autoReloadIn, setAutoReloadIn] = useState<number | null>(null);
  const transient = isTransientError(error);

  useEffect(() => {
    console.error('[user/error]', error);
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
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--cms-bg)' }}
    >
      <section className="firebat-cms-content text-center" style={{ paddingTop: '64px', paddingBottom: '64px' }}>
        {transient ? (
          <>
            <div className="text-5xl mb-3">🔄</div>
            <h1
              className="text-xl sm:text-2xl font-bold tracking-tight m-0"
              style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
            >
              일시적인 문제가 발생했어요
            </h1>
            <p className="mt-3 text-sm max-w-xl mx-auto" style={{ color: 'var(--cms-text-muted)' }}>
              {autoReloadIn !== null
                ? `${autoReloadIn}초 후 자동으로 페이지를 다시 불러옵니다...`
                : '페이지를 다시 불러오면 해결됩니다.'}
            </p>
            <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
              <button
                onClick={reloadNow}
                className="px-4 py-2 text-sm font-bold rounded transition-opacity hover:opacity-90 cursor-pointer border-0"
                style={{ background: 'var(--cms-primary)', color: '#fff' }}
              >
                지금 새로고침
              </button>
              {autoReloadIn !== null && (
                <button
                  onClick={cancelAutoReload}
                  className="px-4 py-2 text-sm font-medium rounded border transition-opacity hover:opacity-80 cursor-pointer"
                  style={{
                    background: 'var(--cms-bg-card)',
                    borderColor: 'var(--cms-border)',
                    color: 'var(--cms-text)',
                  }}
                >
                  취소
                </button>
              )}
            </div>
            {error.digest && (
              <p className="mt-3 text-xs font-mono" style={{ color: 'var(--cms-text-muted)' }}>
                오류 ID: {error.digest}
              </p>
            )}
          </>
        ) : (
          <>
            <div
              className="text-7xl sm:text-8xl font-extrabold tracking-tighter mb-2"
              style={{
                color: 'var(--cms-down)',
                fontFamily: 'var(--cms-font-heading)',
                lineHeight: 1,
              }}
            >
              500
            </div>
            <h1
              className="text-2xl sm:text-3xl font-bold tracking-tight m-0"
              style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
            >
              잠시 문제가 발생했습니다
            </h1>
            <p className="mt-3 text-base max-w-xl mx-auto" style={{ color: 'var(--cms-text-muted)' }}>
              요청을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.
            </p>
            {error.digest && (
              <p className="mt-2 text-xs font-mono" style={{ color: 'var(--cms-text-muted)' }}>
                오류 ID: {error.digest}
              </p>
            )}
            <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
              <button
                onClick={() => reset()}
                className="px-4 py-2 text-sm font-bold rounded no-underline transition-opacity hover:opacity-90 cursor-pointer border-0"
                style={{ background: 'var(--cms-primary)', color: '#fff' }}
              >
                다시 시도
              </button>
              <a
                href="/"
                className="px-4 py-2 text-sm font-medium rounded border no-underline transition-opacity hover:opacity-80"
                style={{
                  background: 'var(--cms-bg-card)',
                  borderColor: 'var(--cms-border)',
                  color: 'var(--cms-text)',
                }}
              >
                홈으로
              </a>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

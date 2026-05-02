'use client';

/**
 * User 영역 error boundary — 페이지 렌더 중 throw 발생 시 표시 (500).
 *
 * 'use client' 필수 — Next.js error.tsx 규칙. (user) layout 의 header/footer 자동 적용.
 * design tokens 통합. reset() 호출 시 페이지 재시도.
 */
import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 콘솔에 출력 — dev 디버깅. 운영 환경의 server-side 에러는 ErrorCapture 가 별도 처리.
    console.error('[user/error]', error);
  }, [error]);

  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--cms-bg)' }}
    >
      <section className="firebat-cms-content text-center" style={{ paddingTop: '64px', paddingBottom: '64px' }}>
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
      </section>
    </main>
  );
}

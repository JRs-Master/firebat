'use client';

/**
 * Root-level error boundary — root layout 자체 throw 시 fallback (드물게).
 *
 * Next.js 규칙: global-error.tsx 는 자체 <html><body> 출력 필수 (root layout 무사용 상태).
 * 평소 에러는 (user)/error.tsx 또는 admin 자체 try/catch 가 처리. 이건 최종 안전망.
 *
 * UX 정책 (2026-05-11): 순수 에러 안내만 — 버튼 / 자동 새로고침 / console.error 모두 없음.
 */

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Pretendard Variable", "Pretendard", sans-serif',
          background: '#ffffff',
          color: '#0f172a',
          padding: '16px',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '480px' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>⚠️</div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
            일시적인 문제가 발생했습니다
          </h1>
          {error.digest && (
            <p style={{ marginTop: '16px', fontSize: '0.7rem', fontFamily: 'monospace', color: '#94a3b8' }}>
              오류 ID: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

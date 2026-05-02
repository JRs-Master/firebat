'use client';

/**
 * Root-level error boundary — root layout 자체 throw 시 fallback (드물게).
 *
 * Next.js 규칙: global-error.tsx 는 자체 <html><body> 출력 필수 (root layout 무사용 상태).
 * 평소 에러는 (user)/error.tsx 또는 admin 자체 try/catch 가 처리. 이건 최종 안전망.
 */
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          background: '#ffffff',
          color: '#0f172a',
          padding: '16px',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: '480px' }}>
          <div style={{ fontSize: '5rem', fontWeight: 800, color: '#dc2626', lineHeight: 1, marginBottom: '8px' }}>
            500
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
            치명적인 오류가 발생했습니다
          </h1>
          <p style={{ marginTop: '12px', color: '#64748b' }}>
            요청을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.
          </p>
          {error.digest && (
            <p style={{ marginTop: '8px', fontSize: '0.75rem', fontFamily: 'monospace', color: '#94a3b8' }}>
              오류 ID: {error.digest}
            </p>
          )}
          <button
            onClick={() => reset()}
            style={{
              marginTop: '20px',
              padding: '10px 16px',
              fontSize: '0.875rem',
              fontWeight: 700,
              background: '#2563eb',
              color: '#fff',
              border: 0,
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}

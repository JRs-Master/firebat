'use client';

/**
 * Root-level error boundary — root layout 자체 throw 시 fallback (드물게).
 *
 * Next.js 규칙: global-error.tsx 는 자체 <html><body> 출력 필수 (root layout 무사용 상태).
 * 평소 에러는 (user)/error.tsx 또는 admin 자체 try/catch 가 처리. 이건 최종 안전망.
 *
 * UX 정책 (2026-05-11 단순화):
 *   - 버튼 / 자동 reload 카운트다운 폐기 — 사용자가 직접 F5 / 브라우저 뒤로 가기 결정
 *   - 메시지 + 오류 ID 만 표시 (디버깅 매칭용)
 */
import { useEffect } from 'react';

export default function GlobalError({
  error,
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

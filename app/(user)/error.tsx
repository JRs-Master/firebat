'use client';

/**
 * User 영역 error boundary — 진단 mode (inline 표시). 옛 /500 redirect 영역 폐기 —
 * hub mode 안 사이드바 panel 진입 500 같은 영역 root cause 보임.
 * 사용자 확인 후 다시 redirect 모드 복원 가능.
 */
import { useEffect } from 'react';
import { logger } from '../../lib/util/logger';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // logger 경유 — 브라우저 console + /api/log 서버 수집 (firebat-frontend journalctl).
    // hub 익명 visitor 페이지 crash 가 운영자 ssh 에서 보임 (로그 Phase 2).
    logger.error('error-boundary', '(user) 페이지 렌더 에러', error, { digest: error.digest });
  }, [error]);

  return (
    <div style={{ padding: '24px', maxWidth: '720px', margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ color: '#dc2626', fontSize: '18px', marginBottom: '12px' }}>오류 발생</h2>
      <pre style={{ background: '#f3f4f6', padding: '12px', borderRadius: '6px', fontSize: '12px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {error.message}
        {error.digest && (
          <>
            {'\n\n'}digest: {error.digest}
          </>
        )}
        {error.stack && (
          <>
            {'\n\n'}{error.stack}
          </>
        )}
      </pre>
      <button
        onClick={() => reset()}
        style={{ marginTop: '12px', padding: '8px 16px', background: '#2563eb', color: 'white', borderRadius: '6px', border: 'none', cursor: 'pointer' }}
      >
        다시 시도
      </button>
    </div>
  );
}

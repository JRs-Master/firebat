'use client';

/**
 * Root-level error boundary — root layout 자체 throw 시 fallback (드물게).
 *
 * Next.js 규칙: global-error.tsx 는 자체 <html><body> 출력 필수 (root layout 무사용 상태).
 * 평소 에러는 (user)/error.tsx 또는 admin 자체 try/catch 가 처리. 이건 최종 안전망.
 *
 * UX 정책:
 *   - Server Action / ChunkLoadError 등 reload 로 회복되는 transient error 는 자동 hard reload
 *     (Next.js 빌드·배포·HMR 직후 client RSC payload stale 케이스가 대부분)
 *   - sessionStorage 카운터로 무한 reload 루프 방어 (1회까지만 자동, 그 이상은 사용자 수동)
 *   - 메시지는 "일시적 문제 → 새로고침" 친화적 톤 (워드프레스 식 fatal 화면 회피)
 */
import { useEffect, useState } from 'react';

const RELOAD_KEY = 'firebat_gerror_reloads';
const MAX_AUTO_RELOAD = 1; // 자동 reload 최대 횟수 — 초과 시 manual 버튼만

/** Reload 로 회복 가능한 transient error 검사 — 일반 로직만:
 *  - digest 있음 = Next.js framework 가 server-side throw 에 부여하는 표준 마커
 *  - ChunkLoadError = webpack/turbopack 표준 error.name (client-side, production 도 보존)
 *  Next.js version-specific message 매칭은 하지 않음 (버전 변경 시 break + production redact). */
function isTransientError(err: Error & { digest?: string }): boolean {
  if (err?.digest) return true;
  if (err?.name === 'ChunkLoadError') return true;
  return false;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [autoReloadIn, setAutoReloadIn] = useState<number | null>(null);

  useEffect(() => {
    console.error('[global-error]', error);

    const transient = isTransientError(error);
    if (!transient) return;

    // 무한 루프 방어 — sessionStorage 카운터. 같은 세션 내 N회 초과 시 자동 reload 중단.
    let count = 0;
    try {
      count = parseInt(sessionStorage.getItem(RELOAD_KEY) ?? '0', 10) || 0;
    } catch { /* private mode 등 sessionStorage 차단 환경 */ }
    if (count >= MAX_AUTO_RELOAD) return;

    // 3초 카운트다운 → hard reload (RSC payload·chunks 모두 다시 받음)
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
  }, [error]);

  const cancelAutoReload = () => setAutoReloadIn(null);
  const reloadNow = () => {
    try {
      const count = parseInt(sessionStorage.getItem(RELOAD_KEY) ?? '0', 10) || 0;
      sessionStorage.setItem(RELOAD_KEY, String(count + 1));
    } catch {}
    window.location.reload();
  };

  const transient = isTransientError(error);

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
          {transient ? (
            <>
              <div style={{ fontSize: '2.5rem', marginBottom: '8px' }}>🔄</div>
              <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
                일시적인 문제가 발생했어요
              </h1>
              <p style={{ marginTop: '12px', color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>
                {autoReloadIn !== null
                  ? `${autoReloadIn}초 후 자동으로 페이지를 다시 불러옵니다...`
                  : '페이지를 다시 불러오면 해결됩니다.'}
              </p>
              <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={reloadNow}
                  style={{
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
                  지금 새로고침
                </button>
                {autoReloadIn !== null && (
                  <button
                    onClick={cancelAutoReload}
                    style={{
                      padding: '10px 16px',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      background: '#fff',
                      color: '#64748b',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      cursor: 'pointer',
                    }}
                  >
                    취소
                  </button>
                )}
              </div>
              {error.digest && (
                <p style={{ marginTop: '12px', fontSize: '0.7rem', fontFamily: 'monospace', color: '#94a3b8' }}>
                  오류 ID: {error.digest}
                </p>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize: '3rem', fontWeight: 800, color: '#dc2626', lineHeight: 1, marginBottom: '8px' }}>
                500
              </div>
              <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0 }}>
                요청을 처리하지 못했어요
              </h1>
              <p style={{ marginTop: '12px', color: '#64748b', fontSize: '0.875rem', lineHeight: 1.6 }}>
                잠시 후 다시 시도해 주세요. 문제가 계속되면 새로고침을 시도해 보세요.
              </p>
              {error.digest && (
                <p style={{ marginTop: '8px', fontSize: '0.7rem', fontFamily: 'monospace', color: '#94a3b8' }}>
                  오류 ID: {error.digest}
                </p>
              )}
              <div style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => reset()}
                  style={{
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
                <button
                  onClick={reloadNow}
                  style={{
                    padding: '10px 16px',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    background: '#fff',
                    color: '#64748b',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    cursor: 'pointer',
                  }}
                >
                  새로고침
                </button>
              </div>
            </>
          )}
        </div>
      </body>
    </html>
  );
}

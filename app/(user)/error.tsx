'use client';

/**
 * User 영역 error boundary — 페이지 render 안 throw 박힌 영역.
 *
 * 진단 모드: error 정보 (메시지 + digest + stack) 인라인 표시 — 박힘 root cause 추적용.
 * `/500` redirect 박지 X — 박은 정보 잃지 X.
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
    // 브라우저 콘솔에 풀 stack 출력.
    // eslint-disable-next-line no-console
    console.error('[user error boundary]', error);
  }, [error]);
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-white">
      <div className="max-w-xl w-full">
        <h1 className="text-xl font-bold text-red-600 mb-3">에러 발생</h1>
        <div className="bg-red-50 border border-red-200 rounded p-3 text-[12px] font-mono text-red-700 whitespace-pre-wrap break-words">
          <div className="font-bold mb-1">message:</div>
          <div>{error?.message || '(no message)'}</div>
          {error?.digest && (
            <>
              <div className="font-bold mt-2 mb-1">digest:</div>
              <div>{error.digest}</div>
            </>
          )}
          {error?.stack && (
            <>
              <div className="font-bold mt-2 mb-1">stack:</div>
              <div className="text-[11px]">{error.stack}</div>
            </>
          )}
        </div>
        <button
          onClick={() => reset()}
          className="mt-4 px-3 py-1.5 text-sm bg-blue-600 text-white rounded"
        >
          다시 시도
        </button>
      </div>
    </main>
  );
}

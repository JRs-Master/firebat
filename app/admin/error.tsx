'use client';

/**
 * Admin route error boundary — admin tree 의 client-side throw 격리.
 *
 * 하지 않으면 admin 안의 어떤 throw 든 root global-error.tsx 까지 bubble up →
 * "치명적인 오류" 풀스크린 → admin 통째 사용 불가. 설정해두면 admin tree 만 reset 가능.
 *
 * 옛 transient 자동 reload 패턴 제거 (2026-05-08) — root cause 안 잡힌 채로 무한 새로고침 회피.
 */
import { useEffect } from 'react';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin/error]', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-4 bg-white">
      <div className="text-center max-w-md">
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
        <div className="mt-4 flex items-center justify-center">
          <button
            onClick={() => reset()}
            className="px-3 py-1.5 text-sm font-bold bg-blue-500 hover:bg-blue-600 text-white rounded cursor-pointer border-0"
          >
            다시 시도
          </button>
        </div>
      </div>
    </div>
  );
}

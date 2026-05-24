/**
 * Root-level 404 — 모든 미매칭 경로 (user / admin 영역 모두) fallback.
 *
 * 옛 `(user)/not-found.tsx` 는 (user) layout 안 header / footer wrap 때문에 미존재 slug 에서도
 * header 가 표시되던 부분 폐기. 모든 미존재 경로 = root not-found.tsx (header 0, 단순 404).
 *
 * default style 사용 — cms theme variable 미적용 (root 영역 안 layout 없음).
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '페이지를 찾을 수 없습니다',
  robots: 'noindex, nofollow',
};

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-white">
      <div className="text-center max-w-md">
        <div className="text-7xl sm:text-8xl font-extrabold tracking-tighter mb-2 text-slate-800" style={{ lineHeight: 1 }}>
          404
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight m-0 text-slate-700">
          페이지를 찾을 수 없습니다
        </h1>
        <p className="mt-3 text-base text-slate-500">
          요청하신 경로가 존재하지 않습니다.
        </p>
        <a
          href="/"
          className="inline-block mt-5 px-4 py-2 text-sm font-bold rounded no-underline transition-opacity hover:opacity-90 bg-blue-600 text-white"
        >
          홈으로
        </a>
      </div>
    </main>
  );
}

/**
 * `/500` route — (user) route group 안 error 박힌 영역 안 client redirect 박은 target.
 *
 * 옛 (user)/error.tsx 안 = (user) layout 안 자동 wrap (header 박힘). 사용자 의도 X.
 * 새 흐름 — (user)/error.tsx 안 router.replace('/500') 박은 영역 + 본 route 안 단순 page
 * render (root layout 만 wrap, header 0).
 *
 * status code 200 박힘 (client-side redirect). 진짜 500 status 박지 X — UI 의도 우선.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '일시적인 문제가 발생했습니다',
  robots: 'noindex, nofollow',
};

export default function ServerErrorRoute() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 bg-white">
      <div className="text-center max-w-md">
        <div className="text-7xl sm:text-8xl font-extrabold tracking-tighter mb-2 text-slate-800" style={{ lineHeight: 1 }}>
          500
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight m-0 text-slate-700">
          일시적인 문제가 발생했습니다
        </h1>
        <p className="mt-3 text-base text-slate-500">
          잠시 후 다시 시도해 주세요.
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

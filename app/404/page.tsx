/**
 * `/404` route — (user) route group 안 미존재 slug / 비공개 페이지 안 `redirect('/404')` 박은 target.
 *
 * Next.js 안 (user)/[...slug]/page.tsx 안 `notFound()` 호출 시 가장 가까운 not-found.tsx 매칭
 * + (user)/layout.tsx 안 자동 wrap (header 박힘). 사용자 의도 = header 0 + 단순 404.
 *
 * 정공 = root level route 안 redirect → root layout 만 wrap (header 0).
 *
 * status code 200 박힘 (redirect 후 final). 진짜 404 status 박지 X — SEO 영향 모름 + UI 의도 우선.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '페이지를 찾을 수 없습니다',
  robots: 'noindex, nofollow',
};

export default function NotFoundRoute() {
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

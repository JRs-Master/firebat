/**
 * Root-level 404 — (user) / admin 그룹 밖 미매칭 경로 (예: /admin/없는경로) 의 fallback.
 *
 * (user) 페이지의 404 는 app/(user)/not-found.tsx 가 우선 처리 (header/footer 포함).
 * 여기는 admin 등 다른 영역의 막다른 길 fallback — globals.css 의 default tokens 사용.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '페이지를 찾을 수 없습니다',
  robots: 'noindex, nofollow',
};

export default function NotFound() {
  return (
    <main
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: 'var(--cms-bg)' }}
    >
      <div className="text-center max-w-md">
        <div
          className="text-7xl sm:text-8xl font-extrabold tracking-tighter mb-2"
          style={{
            color: 'var(--cms-primary)',
            fontFamily: 'var(--cms-font-heading)',
            lineHeight: 1,
          }}
        >
          404
        </div>
        <h1
          className="text-2xl sm:text-3xl font-bold tracking-tight m-0"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          페이지를 찾을 수 없습니다
        </h1>
        <p className="mt-3 text-base" style={{ color: 'var(--cms-text-muted)' }}>
          요청하신 경로가 존재하지 않습니다.
        </p>
        <a
          href="/"
          className="inline-block mt-5 px-4 py-2 text-sm font-bold rounded no-underline transition-opacity hover:opacity-90"
          style={{ background: 'var(--cms-primary)', color: '#fff' }}
        >
          홈으로
        </a>
      </div>
    </main>
  );
}

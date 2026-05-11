/**
 * User 영역 404 — notFound() 호출 또는 미매칭 경로 시 자동 표시.
 *
 * (user) layout 의 header/footer/sidebar 자동 적용. design tokens 통합.
 * Next.js 가 metadata 자동 처리 (status 404 + noindex). 별도 generateMetadata 불필요.
 */
// force-dynamic — build 시 Rust core (50051) 미접근. 매 요청 시 server render
// (cms.siteLang / 최근 글 목록 박는 거 동적 데이터라 정적 prerender 불가).
export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import { getCore } from '../../lib/singleton';
import { CmsPageList } from './cms-page-list';
import { getServerTranslations } from '../../lib/i18n-server';

export async function generateMetadata(): Promise<Metadata> {
  const cms = await getCore().getCmsSettings();
  const t = getServerTranslations(cms.siteLang);
  return {
    title: t('page.not_found_title'),
    description: t('page.not_found_message'),
    robots: 'noindex, nofollow',
  };
}

export default async function NotFound() {
  // 최근 글 일부를 보여줘 navigation 깊이 ↑ — 막다른 길 회피.
  const core = getCore();
  const cms = await core.getCmsSettings();
  const t = getServerTranslations(cms.siteLang);
  const listRes = await core.listPages();
  const recent = listRes.success && listRes.data
    ? listRes.data
        .filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
        .slice(0, 6)
    : [];

  return (
    <main
      className="min-h-screen"
      style={{ background: 'var(--cms-bg)' }}
    >
      <section className="firebat-cms-content text-center" style={{ paddingTop: '64px', paddingBottom: '32px' }}>
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
          {t('page.not_found_title')}
        </h1>
        <p className="mt-3 text-base max-w-xl mx-auto" style={{ color: 'var(--cms-text-muted)' }}>
          {t('page.not_found_message')}
        </p>
        <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
          <a
            href="/"
            className="px-4 py-2 text-sm font-bold rounded no-underline transition-opacity hover:opacity-90"
            style={{ background: 'var(--cms-primary)', color: '#fff' }}
          >
            {t('page.go_home')}
          </a>
          <a
            href="/search"
            className="px-4 py-2 text-sm font-medium rounded border no-underline transition-opacity hover:opacity-80"
            style={{
              background: 'var(--cms-bg-card)',
              borderColor: 'var(--cms-border)',
              color: 'var(--cms-text)',
            }}
          >
            {t('common.search')}
          </a>
        </div>
      </section>

      {recent.length > 0 && (
        <section className="firebat-cms-content" style={{ paddingTop: '8px', paddingBottom: '64px' }}>
          <h2
            className="text-base font-bold mb-3"
            style={{ color: 'var(--cms-text-muted)', fontFamily: 'var(--cms-font-heading)' }}
          >
            {t('page.recent_posts')}
          </h2>
          <CmsPageList pages={recent} variant={cms.layout.pageList.cardVariant} />
        </section>
      )}
    </main>
  );
}

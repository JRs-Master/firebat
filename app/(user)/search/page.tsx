/**
 * 검색 결과 페이지 — `/search?q=텀&page=N`.
 *
 * server-side 검색 (Core.searchPages) — title/project/spec 본문 LIKE 매칭.
 * private 페이지 제외 (DB 레벨). password 페이지 포함 (클릭 시 게이트).
 * 빈 쿼리·결과 없음·일반 매칭 모두 같은 페이지에서 처리.
 */
import { getCmsSettings } from '../../../lib/api-gen/module';
import { searchPages } from '../../../lib/api-gen/page';
import { CmsPageList, CmsPagination } from '../cms-page-list';
import { getServerTranslations } from '../../../lib/i18n-server';
import { toPageListItem } from '../../../lib/util/page-pb-convert';
import type { Metadata } from 'next';
import type { PageListItem } from '../../../lib/types/firebat-types';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams?: Promise<{ q?: string; page?: string }>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = searchParams ? await searchParams : {};
  const q = (sp.q ?? '').trim();
  const seoRes = await getCmsSettings();
  const seo = (seoRes.ok ? seoRes.data : {}) as any;
  const t = getServerTranslations(seo.siteLang);
  return {
    title: q ? `"${q}" — ${seo.siteTitle}` : `${t('common.search')} — ${seo.siteTitle}`,
    description: q ? t('page.search_results', { count: 0 }).replace('0', q) : t('common.search'),
    robots: 'noindex, follow',
  };
}

export default async function SearchPage({ searchParams }: Props) {
  const sp = searchParams ? await searchParams : {};
  const q = (sp.q ?? '').trim();
  const currentPage = Math.max(1, parseInt(sp.page || '1') || 1);

  const cmsRes = await getCmsSettings();
  const cms = (cmsRes.ok ? cmsRes.data : {}) as any;
  const t = getServerTranslations(cms.siteLang);
  const perPage = cms.layout?.pageList?.perPage ?? 10;

  let results: PageListItem[] = [];
  let tooShort = false;
  if (q.length >= 2) {
    const res = await searchPages({ query: q, limit: 200n } as any);
    if (res.ok) results = (res.data ?? []).map(toPageListItem);
  } else if (q.length === 1) {
    tooShort = true;
  }

  const totalPages = Math.max(1, Math.ceil(results.length / perPage));
  const paged = results.slice((currentPage - 1) * perPage, currentPage * perPage);

  return (
    <main className="min-h-screen" style={{ background: 'var(--cms-bg)' }}>
      <section className="firebat-cms-content" style={{ paddingTop: '48px', paddingBottom: '24px' }}>
        <div className="text-sm font-bold mb-1" style={{ color: 'var(--cms-text-muted)' }}>
          {t('common.search')}
        </div>
        <h1
          className="text-3xl sm:text-4xl font-extrabold tracking-tight m-0"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          {q ? <>&ldquo;{q}&rdquo;</> : t('common.search')}
        </h1>

        {/* 검색 form — GET method 로 ?q= 갱신, 페이지 reload */}
        <form method="get" action="/search" className="mt-5 flex items-stretch gap-2 max-w-xl">
          <label htmlFor="search-query" className="sr-only">{t('common.search')}</label>
          <input
            id="search-query"
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t('page.search_placeholder')}
            autoComplete="off"
            autoFocus
            aria-label={t('common.search')}
            className="flex-1 px-3 py-2 text-sm border rounded outline-none"
            style={{
              background: 'var(--cms-bg-card)',
              borderColor: 'var(--cms-border)',
              color: 'var(--cms-text)',
            }}
          />
          <button
            type="submit"
            className="px-4 py-2 text-sm font-bold rounded transition-opacity hover:opacity-90"
            style={{ background: 'var(--cms-primary)', color: '#fff' }}
          >
            {t('common.search')}
          </button>
        </form>

        {q && !tooShort && (
          <p className="mt-3 text-sm" style={{ color: 'var(--cms-text-muted)' }}>
            {results.length === 0 ? t('page.search_no_results') : t('page.search_results', { count: results.length })}
          </p>
        )}
        {tooShort && (
          <p className="mt-3 text-sm" style={{ color: 'var(--cms-text-muted)' }}>
            {cms.siteLang === 'en' ? 'Please enter at least 2 characters.' : '2자 이상 입력해 주세요.'}
          </p>
        )}
      </section>

      {q && !tooShort && results.length > 0 && (
        <section className="firebat-cms-content" style={{ paddingTop: '8px', paddingBottom: '64px' }}>
          <CmsPageList pages={paged} variant={cms.layout?.pageList?.cardVariant} />
          <CmsPagination
            basePath={`/search?q=${encodeURIComponent(q)}`}
            currentPage={currentPage}
            totalPages={totalPages}
          />
        </section>
      )}
    </main>
  );
}

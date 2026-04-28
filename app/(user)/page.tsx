import { getCore } from '../../lib/singleton';
import { BASE_URL } from '../../infra/config';
import { CmsPageList, CmsPagination } from './cms-page-list';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ page?: string }>;
}

/** 루트 페이지 SEO 메타데이터 — CMS 모듈 설정에서 로드 */
export async function generateMetadata(): Promise<Metadata> {
  const seo = getCore().getCmsSettings();
  const siteUrl = seo.siteUrl || BASE_URL;

  const ogImage = `${siteUrl}/api/og?title=${encodeURIComponent(seo.siteTitle)}&description=${encodeURIComponent(seo.siteDescription)}`;

  return {
    title: seo.siteTitle,
    description: seo.siteDescription,
    openGraph: {
      title: seo.siteTitle,
      description: seo.siteDescription,
      url: siteUrl,
      siteName: seo.siteTitle,
      images: [ogImage],
      type: 'website',
    },
    robots: 'index, follow',
  };
}

/** 홈 페이지 — Hero + 최근 글 목록 + 프로젝트 카탈로그.
 *  Phase 4 Step 3+4 — cardVariant + 페이지네이션. CmsHeader / CmsFooter 가 layout.tsx 에서 자연 wrap. */
export default async function HomePage({ searchParams }: Props) {
  const core = getCore();
  const cms = core.getCmsSettings();
  const sp = await searchParams;
  const currentPage = Math.max(1, parseInt(sp.page || '1') || 1);
  const perPage = cms.layout.pageList.perPage;

  const pagesRes = await core.listPages();
  const allPages = pagesRes.success && pagesRes.data ? pagesRes.data : [];
  // public + published 만, 최근 순
  const visiblePages = allPages
    .filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  const totalPages = Math.max(1, Math.ceil(visiblePages.length / perPage));
  const pagedPosts = visiblePages.slice((currentPage - 1) * perPage, currentPage * perPage);

  // 프로젝트 카탈로그 (페이지 있는 것만 — 빈 프로젝트 제외)
  const projectMap = new Map<string, number>();
  for (const p of visiblePages) {
    if (p.project) projectMap.set(p.project, (projectMap.get(p.project) ?? 0) + 1);
  }
  const projects = [...projectMap.entries()]
    .sort((a, b) => b[1] - a[1]); // 페이지 많은 순

  return (
    <main className="min-h-screen" style={{ background: 'var(--cms-bg)' }}>
      {/* Hero */}
      <section
        className="firebat-cms-content"
        style={{ paddingTop: '64px', paddingBottom: '48px', textAlign: 'center' }}
      >
        <h1
          className="text-3xl sm:text-5xl font-extrabold tracking-tight m-0"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          {cms.siteTitle}
        </h1>
        {cms.siteDescription && (
          <p
            className="text-base sm:text-lg mt-3 max-w-2xl mx-auto"
            style={{ color: 'var(--cms-text-muted)' }}
          >
            {cms.siteDescription}
          </p>
        )}
      </section>

      {/* 프로젝트 카탈로그 */}
      {projects.length > 0 && (
        <section className="firebat-cms-content" style={{ paddingTop: '24px', paddingBottom: '24px' }}>
          <h2
            className="text-xl sm:text-2xl font-bold mb-4"
            style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
          >
            프로젝트
          </h2>
          <div className="flex flex-wrap gap-2">
            {projects.map(([name, count]) => (
              <a
                key={name}
                href={`/${name}`}
                className="px-3 py-1.5 text-sm font-medium rounded-full no-underline transition-opacity hover:opacity-80"
                style={{
                  background: 'var(--cms-bg-card)',
                  border: '1px solid var(--cms-border)',
                  color: 'var(--cms-text)',
                }}
              >
                {name} <span style={{ color: 'var(--cms-text-muted)' }}>({count})</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* 최근 글 */}
      <section className="firebat-cms-content" style={{ paddingTop: '24px', paddingBottom: '64px' }}>
        <h2
          className="text-xl sm:text-2xl font-bold mb-4"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          최근 글
        </h2>
        <CmsPageList
          pages={pagedPosts}
          emptyMessage="아직 발행된 글이 없습니다."
          variant={cms.layout.pageList.cardVariant}
        />
        <CmsPagination basePath="/" currentPage={currentPage} totalPages={totalPages} />
      </section>
    </main>
  );
}

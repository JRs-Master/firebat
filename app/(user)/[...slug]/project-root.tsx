/**
 * ProjectRootView — `/{projectName}` URL 에서 매칭 page spec 없을 때 프로젝트 카탈로그 fallback.
 *
 * Phase 4 Step 3 + 카테고리 enrichment:
 *  - Breadcrumb (홈 > 프로젝트)
 *  - "카테고리" 라벨 prefix
 *  - RSS 구독 버튼 (project feed)
 *  - JSON-LD CollectionPage (Google rich result, item list)
 */
import { getCore } from '../../../lib/singleton';
import { CmsPageList, CmsPagination } from '../cms-page-list';
import { CmsBreadcrumb } from '../breadcrumb';
import { headers } from 'next/headers';
import { BASE_URL } from '../../../infra/config';

async function resolveBaseUrl(seoSiteUrl?: string): Promise<string> {
  if (seoSiteUrl) return seoSiteUrl.replace(/\/$/, '');
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, '');
  try {
    const h = await headers();
    const host = h.get('x-forwarded-host') || h.get('host');
    if (host) {
      const proto = h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
      return `${proto}://${host}`;
    }
  } catch { /* polyfill */ }
  return BASE_URL;
}

export async function ProjectRootView({ projectName, pageSlugs, currentPage = 1 }: {
  projectName: string;
  pageSlugs: string[];
  currentPage?: number;
}) {
  const core = getCore();
  const cms = core.getCmsSettings();
  const perPage = cms.layout.pageList.perPage;

  const allPagesRes = await core.listPages();
  const allPages = allPagesRes.success && allPagesRes.data ? allPagesRes.data : [];
  const projectPages = allPages
    .filter((p) => pageSlugs.includes(p.slug))
    .filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  const totalPages = Math.max(1, Math.ceil(projectPages.length / perPage));
  const pagedPosts = projectPages.slice((currentPage - 1) * perPage, currentPage * perPage);

  // CollectionPage JSON-LD — Google rich result + item list 표현 (글 list 가시화).
  const siteUrl = await resolveBaseUrl(cms.siteUrl);
  const projectUrl = `${siteUrl}/${encodeURIComponent(projectName)}`;
  const collectionLd = cms.jsonLdEnabled ? {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${projectUrl}#collection`,
        url: projectUrl,
        name: `${projectName} — ${cms.siteTitle}`,
        description: `${projectName} 카테고리의 모든 글`,
        isPartOf: { '@id': `${siteUrl}/#website` },
        // ItemList 도 inline 으로 — 첫 페이지에 등장하는 글들 (paged 가 아닌 첫 N개로 검색결과 노출).
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: projectPages.length,
          itemListElement: projectPages.slice(0, 20).map((p, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            url: `${siteUrl}/${p.slug.split('/').map(encodeURIComponent).join('/')}`,
            name: p.title || p.slug,
          })),
        },
      },
      // BreadcrumbList — 홈 > projectName.
      {
        '@type': 'BreadcrumbList',
        '@id': `${projectUrl}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: '홈', item: siteUrl },
          { '@type': 'ListItem', position: 2, name: projectName, item: projectUrl },
        ],
      },
    ],
  } : null;

  return (
    <>
      {collectionLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionLd) }}
        />
      )}
      <main className="min-h-screen" style={{ background: 'var(--cms-bg)' }}>
        <section className="firebat-cms-content" style={{ paddingTop: '48px', paddingBottom: '24px' }}>
          {/* Breadcrumb — 홈 > 프로젝트 */}
          <CmsBreadcrumb slug={projectName} title={projectName} />

          <div className="text-sm font-bold mb-1" style={{ color: 'var(--cms-text-muted)' }}>
            카테고리
          </div>
          <h1
            className="text-3xl sm:text-4xl font-extrabold tracking-tight m-0"
            style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
          >
            {projectName}
          </h1>

          <div className="mt-2 flex items-center gap-3 flex-wrap">
            <p className="text-base m-0" style={{ color: 'var(--cms-text-muted)' }}>
              {projectPages.length}개 글
            </p>
            {/* RSS 구독 버튼 — project feed.xml 으로 직접 링크. rel=alternate 와 별도로 visible. */}
            {cms.rssEnabled && projectPages.length > 0 && (
              <a
                href={`/${encodeURIComponent(projectName)}/feed.xml`}
                className="inline-flex items-center gap-1 text-[12px] font-medium hover:opacity-80 transition-opacity no-underline"
                style={{ color: 'var(--cms-primary)' }}
                title={`${projectName} RSS 구독`}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 11a9 9 0 0 1 9 9" />
                  <path d="M4 4a16 16 0 0 1 16 16" />
                  <circle cx="5" cy="19" r="1" />
                </svg>
                <span>RSS</span>
              </a>
            )}
          </div>
        </section>

        <section className="firebat-cms-content" style={{ paddingTop: '8px', paddingBottom: '64px' }}>
          <CmsPageList
            pages={pagedPosts}
            emptyMessage="이 프로젝트엔 아직 발행된 글이 없습니다."
            variant={cms.layout.pageList.cardVariant}
          />
          <CmsPagination basePath={`/${projectName}`} currentPage={currentPage} totalPages={totalPages} />
        </section>
      </main>
    </>
  );
}

/**
 * ProjectRootView — `/{projectName}` URL 에서 매칭 page spec 없을 때 프로젝트 카탈로그 fallback.
 *
 * Phase 4 Step 3 — 1-segment URL 이 프로젝트명과 매칭되면 [...slug]/page.tsx 가 이걸 렌더.
 * 해당 프로젝트의 모든 published 페이지 (visibility=public) list 표시.
 */
import { getCore } from '../../../lib/singleton';
import { CmsPageList, CmsPagination } from '../cms-page-list';

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

  return (
    <main className="min-h-screen" style={{ background: 'var(--cms-bg)' }}>
      <section className="firebat-cms-content" style={{ paddingTop: '48px', paddingBottom: '32px' }}>
        <h1
          className="text-3xl sm:text-4xl font-extrabold tracking-tight m-0"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          {projectName}
        </h1>
        <p className="mt-2 text-base" style={{ color: 'var(--cms-text-muted)' }}>
          {projectPages.length}개 글
        </p>
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
  );
}

/**
 * Tag 페이지 — `/tag/{keyword}` URL.
 *
 * Phase 4 Step 3 — keyword 매칭 페이지 list. 페이지 spec.head.keywords 에 해당 키워드 포함 시 매칭.
 * 매칭 페이지 0건이면 404. visibility=public + status=published 만.
 *
 * 향후 Phase 8a (태그 관리 시스템) — alias / normalization / 자동 추적 등 발전.
 */
import { notFound } from 'next/navigation';
import { getCore } from '../../../../lib/singleton';
import { CmsPageList, CmsPagination } from '../../cms-page-list';
import { normalizeTag } from '../../../../lib/tag-utils';
import type { Metadata } from 'next';
import type { PageListItem } from '../../../../core/ports';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ keyword: string }>;
  searchParams?: Promise<{ page?: string }>;
}

function decodeKeyword(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** 페이지의 head.keywords 에 매칭되는 keyword 인지 검사. case-insensitive + alias normalize.
 *  URL "/tag/ai" → CMS settings 의 tagAliases 보고 "AI" canonical 로 normalize → 그 canonical 매칭 페이지. */
async function findMatchingPages(keyword: string): Promise<{ pages: PageListItem[]; canonical: string }> {
  const core = getCore();
  const aliases = core.getCmsSettings().tagAliases;
  const canonical = normalizeTag(keyword, aliases);
  const allRes = await core.listPages();
  const allPages = allRes.success && allRes.data ? allRes.data : [];
  const visible = allPages.filter(
    (p) => p.status === 'published' && (p.visibility ?? 'public') === 'public',
  );
  const matched: PageListItem[] = [];
  for (const p of visible) {
    const pageRes = await core.getPage(p.slug);
    if (!pageRes.success || !pageRes.data) continue;
    const keywords = (pageRes.data.head?.keywords ?? []) as string[];
    // 각 keyword 도 normalize 후 canonical 매칭
    if (keywords.some((k) => typeof k === 'string' && normalizeTag(k, aliases) === canonical)) {
      matched.push(p);
    }
  }
  return {
    pages: matched.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    canonical,
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const keyword = decodeKeyword((await params).keyword);
  const seo = getCore().getCmsSettings();
  const canonical = normalizeTag(keyword, seo.tagAliases);
  return {
    title: `#${canonical} — ${seo.siteTitle}`,
    description: `${canonical} 키워드가 포함된 모든 글`,
    robots: 'index, follow',
  };
}

export default async function TagPage({ params, searchParams }: Props) {
  const rawKeyword = decodeKeyword((await params).keyword);
  const { pages, canonical } = await findMatchingPages(rawKeyword);
  if (pages.length === 0) notFound();

  const cms = getCore().getCmsSettings();
  const sp = searchParams ? await searchParams : {};
  const currentPage = Math.max(1, parseInt(sp.page || '1') || 1);
  const perPage = cms.layout.pageList.perPage;
  const totalPages = Math.max(1, Math.ceil(pages.length / perPage));
  const pagedPosts = pages.slice((currentPage - 1) * perPage, currentPage * perPage);

  return (
    <main className="min-h-screen" style={{ background: 'var(--cms-bg)' }}>
      <section className="firebat-cms-content" style={{ paddingTop: '48px', paddingBottom: '32px' }}>
        <div className="text-sm font-bold mb-1" style={{ color: 'var(--cms-text-muted)' }}>
          태그
        </div>
        <h1
          className="text-3xl sm:text-4xl font-extrabold tracking-tight m-0"
          style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
        >
          #{canonical}
        </h1>
        <p className="mt-2 text-base" style={{ color: 'var(--cms-text-muted)' }}>
          {pages.length}개 글
        </p>
      </section>
      <section className="firebat-cms-content" style={{ paddingTop: '8px', paddingBottom: '64px' }}>
        <CmsPageList pages={pagedPosts} variant={cms.layout.pageList.cardVariant} />
        <CmsPagination basePath={`/tag/${encodeURIComponent(canonical)}`} currentPage={currentPage} totalPages={totalPages} />
      </section>
    </main>
  );
}

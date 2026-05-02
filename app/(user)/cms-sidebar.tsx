/**
 * CmsSidebar — Phase 4 Step 2 + 위젯 카탈로그 확장.
 *
 * 위젯 카탈로그:
 *   - 검색 박스 (showSearchBox) — /search GET form
 *   - 최근 글 (showRecentPosts + recentPostsCount)
 *   - 카테고리 list (showCategoryList) — project 합집합 + 글 수
 *   - 태그 cloud (showTagCloud + tagCloudLimit) — head.keywords 빈도수
 *   - 구독 (showSubscribe) — RSS + 텔레그램 채널 안내
 *   - HTML 자유 위젯 (htmlWidget)
 *
 * RSC — listPages / listAllTags 비동기 fetch. design tokens 적용.
 */
import { getCore } from '../../lib/singleton';
import DOMPurify from 'isomorphic-dompurify';
import type { SidebarConfig } from '../../lib/cms-layout';

const HTML_WIDGET_SANITIZE = {
  ALLOWED_TAGS: ['div', 'span', 'p', 'a', 'strong', 'em', 'b', 'i', 'br', 'ul', 'ol', 'li', 'img', 'h3', 'h4', 'small', 'ins', 'script'],
  ALLOWED_ATTR: ['class', 'id', 'style', 'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'data-ad-client', 'data-ad-slot', 'data-ad-format', 'data-full-width-responsive', 'async'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#|data:image\/)/i,
};

function formatDate(s?: string, timeZone: string = 'Asia/Seoul'): string {
  if (!s) return '';
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone });
}

export async function CmsSidebar({ sidebar }: { sidebar: SidebarConfig }) {
  const core = getCore();

  // 페이지 list — 최근 글 / 카테고리 둘 다 사용. 한 번만 fetch.
  const needPages = sidebar.showRecentPosts || sidebar.showCategoryList;
  const allRes = needPages ? await core.listPages() : null;
  const allPages = allRes?.success && allRes.data
    ? allRes.data.filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
    : [];

  const recent = sidebar.showRecentPosts
    ? [...allPages]
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, sidebar.recentPostsCount || 5)
    : [];

  // 카테고리 — project 합집합 + 빈도수. project 미지정 페이지 제외.
  const categoryMap = new Map<string, number>();
  if (sidebar.showCategoryList) {
    for (const p of allPages) {
      if (!p.project) continue;
      categoryMap.set(p.project, (categoryMap.get(p.project) ?? 0) + 1);
    }
  }
  const categories = [...categoryMap.entries()].sort((a, b) => b[1] - a[1]);

  // 태그 cloud — listAllTags 가 이미 합집합 + slugs 포함, count 정렬 후 top N.
  const tags = sidebar.showTagCloud ? await core.listAllTags() : [];
  const topTags = tags
    .slice(0, sidebar.tagCloudLimit || 20);
  // 폰트 사이즈 분포 — 빈도 max 기준 1.0 ~ 0.7 사이 ratio.
  const maxTagCount = topTags[0]?.count ?? 1;

  const htmlWidgetSan = sidebar.htmlWidget
    ? DOMPurify.sanitize(sidebar.htmlWidget, HTML_WIDGET_SANITIZE)
    : '';

  return (
    <aside className="firebat-cms-sidebar">
      {/* 검색 박스 */}
      {sidebar.showSearchBox && (
        <section>
          <h3>검색</h3>
          <form method="get" action="/search" className="flex items-stretch gap-1.5">
            <input
              type="search"
              name="q"
              placeholder="검색어..."
              className="flex-1 px-2.5 py-1.5 text-[13px] border rounded outline-none min-w-0"
              style={{
                background: 'var(--cms-bg-card)',
                borderColor: 'var(--cms-border)',
                color: 'var(--cms-text)',
              }}
            />
            <button
              type="submit"
              className="px-2.5 py-1.5 text-[13px] font-bold rounded transition-opacity hover:opacity-90 shrink-0"
              style={{ background: 'var(--cms-primary)', color: '#fff' }}
              aria-label="검색"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </form>
        </section>
      )}

      {/* 최근 글 */}
      {sidebar.showRecentPosts && recent.length > 0 && (
        <section>
          <h3>최근 글</h3>
          <ul className="list-none p-0 flex flex-col gap-2">
            {recent.map((p) => (
              <li key={p.slug}>
                <a
                  href={`/${p.slug}`}
                  className="no-underline block hover:opacity-70 transition-opacity"
                  style={{ color: 'var(--cms-text)' }}
                >
                  <div className="text-[13px] font-medium leading-snug" style={{ color: 'var(--cms-text)' }}>
                    {p.title}
                  </div>
                  {p.updatedAt && (
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--cms-text-muted)' }}>
                      {formatDate(p.updatedAt)}
                    </div>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 카테고리 */}
      {sidebar.showCategoryList && categories.length > 0 && (
        <section>
          <h3>카테고리</h3>
          <ul className="list-none p-0 flex flex-col gap-1.5">
            {categories.map(([proj, count]) => (
              <li key={proj}>
                <a
                  href={`/${encodeURIComponent(proj)}`}
                  className="no-underline flex items-center justify-between gap-2 hover:opacity-70 transition-opacity"
                  style={{ color: 'var(--cms-text)' }}
                >
                  <span className="text-[13px] font-medium truncate">{proj}</span>
                  <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--cms-text-muted)' }}>
                    {count}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 태그 cloud */}
      {sidebar.showTagCloud && topTags.length > 0 && (
        <section>
          <h3>태그</h3>
          <div className="flex flex-wrap gap-1.5">
            {topTags.map((t) => {
              // 폰트 사이즈 ratio — 빈도 기반 0.85 ~ 1.15 rem (편차 적당히).
              const ratio = 0.85 + 0.3 * (t.count / Math.max(1, maxTagCount));
              return (
                <a
                  key={t.tag}
                  href={`/tag/${encodeURIComponent(t.tag)}`}
                  className="no-underline inline-flex items-center px-2 py-0.5 rounded transition-opacity hover:opacity-70"
                  style={{
                    background: 'var(--cms-bg-card)',
                    color: 'var(--cms-text)',
                    border: '1px solid var(--cms-border)',
                    fontSize: `${ratio}rem`,
                    lineHeight: 1.4,
                  }}
                  title={`${t.count}개 글`}
                >
                  #{t.tag}
                </a>
              );
            })}
          </div>
        </section>
      )}

      {/* 구독 — RSS feed.xml + 텔레그램 채널 (옵션) */}
      {sidebar.showSubscribe && (
        <section>
          <h3>구독</h3>
          <div className="flex flex-col gap-1.5">
            <a
              href="/feed.xml"
              className="no-underline flex items-center gap-2 text-[13px] hover:opacity-70 transition-opacity"
              style={{ color: 'var(--cms-text)' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 11a9 9 0 0 1 9 9" />
                <path d="M4 4a16 16 0 0 1 16 16" />
                <circle cx="5" cy="19" r="1" />
              </svg>
              <span>RSS 피드</span>
            </a>
          </div>
        </section>
      )}

      {/* HTML 자유 위젯 */}
      {htmlWidgetSan && (
        <section>
          <div dangerouslySetInnerHTML={{ __html: htmlWidgetSan }} />
        </section>
      )}
    </aside>
  );
}

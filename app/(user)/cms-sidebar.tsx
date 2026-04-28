/**
 * CmsSidebar — Phase 4 Step 2. 사이드바 위젯 컨테이너.
 *
 * 위젯 카탈로그 (initial):
 *   - 최근 글 (showRecentPosts + recentPostsCount)
 *   - HTML 자유 위젯 (htmlWidget)
 * 향후 — 인기 글, 검색, 모듈 결과, 광고 슬롯 등.
 *
 * RSC — listPages 비동기 fetch. design tokens 적용.
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
  // sqlite CURRENT_TIMESTAMP 는 'YYYY-MM-DD HH:MM:SS' UTC — ISO + Z 변환 후 timezone 적용.
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone });
}

export async function CmsSidebar({ sidebar }: { sidebar: SidebarConfig }) {
  const core = getCore();
  const recentRes = sidebar.showRecentPosts ? await core.listPages() : null;
  const recent = recentRes?.success && recentRes.data
    ? recentRes.data
        .filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, sidebar.recentPostsCount || 5)
    : [];

  const htmlWidgetSan = sidebar.htmlWidget
    ? DOMPurify.sanitize(sidebar.htmlWidget, HTML_WIDGET_SANITIZE)
    : '';

  return (
    <aside className="firebat-cms-sidebar">
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
      {htmlWidgetSan && (
        <section>
          <div dangerouslySetInnerHTML={{ __html: htmlWidgetSan }} />
        </section>
      )}
    </aside>
  );
}

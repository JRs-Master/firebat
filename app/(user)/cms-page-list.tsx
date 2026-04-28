/**
 * CmsPageList — 단순 페이지 list 렌더 (slug/title/project/updatedAt).
 *
 * 홈·projectRoot·tag 페이지에서 공유 사용. Phase 4 Step 4 의 page card 5 변형은 추후 —
 * 지금은 단순 list (제목 + 메타 + 프로젝트 라벨).
 */
import type { PageListItem } from '../../core/ports';

function formatDate(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function CmsPageList({ pages, emptyMessage }: { pages: PageListItem[]; emptyMessage?: string }) {
  if (pages.length === 0) {
    return (
      <div className="text-center py-12" style={{ color: 'var(--cms-text-muted)' }}>
        {emptyMessage ?? '아직 발행된 페이지가 없습니다.'}
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-4 list-none p-0">
      {pages.map((p) => (
        <li
          key={p.slug}
          className="border rounded-lg p-4 transition-shadow hover:shadow-sm"
          style={{
            background: 'var(--cms-bg-card)',
            borderColor: 'var(--cms-border)',
            borderRadius: 'var(--cms-radius)',
          }}
        >
          <a
            href={`/${p.slug}`}
            className="no-underline block"
            style={{ color: 'var(--cms-text)' }}
          >
            <div className="flex items-center gap-2 text-[11px] mb-1" style={{ color: 'var(--cms-text-muted)' }}>
              {p.project && <span className="font-bold">{p.project}</span>}
              {p.project && p.updatedAt && <span>·</span>}
              {p.updatedAt && <time dateTime={p.updatedAt}>{formatDate(p.updatedAt)}</time>}
            </div>
            <h3
              className="text-base sm:text-lg font-bold leading-snug m-0"
              style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
            >
              {p.title}
            </h3>
          </a>
        </li>
      ))}
    </ul>
  );
}
